import crypto from 'crypto';
import path from 'path';
import express, { type Response, type NextFunction } from 'express';
import multer from 'multer';
import { publicDir, type PilotConfig } from './config';
import { Auth, allow, ConcurrencyLimiter, type AuthedRequest } from './auth';
import { detectFileType } from './fileType';
import { FileStore, CASE_STATUSES, type Store, type CaseStatus } from './store';
import { AccessLog } from './accessLog';
import { securityHeaders, strictCors, requireHttps, ROBOTS_TXT } from './security';
import { caseViewFor, statusView, visibleMaterials, materialMeta, employeeAssessment } from './views';

export const ALLOWED_MIME = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
export const CONSENT_VERSION = 'draft-lawyer-review-required';

/** The ONLY fields an account listing may expose. */
export const ACCOUNT_SUMMARY_KEYS = ['enabled', 'id', 'name', 'role'] as const;
export function accountSummary(a: { id: string; name: string; role: string; enabled: boolean }) {
  return { id: a.id, name: a.name, role: a.role, enabled: a.enabled };
}

export interface AppDeps { store?: Store; log?: AccessLog; auth?: (auth: Auth) => void }

export function createApp(cfg: PilotConfig, deps: AppDeps = {}) {
  const app = express();
  const store: Store = deps.store || new FileStore(cfg.dataDir);
  // Revoked sessions are persisted in the case data store (disk), so logout survives restarts.
  const auth = new Auth(cfg, {
    load: () => store.read().revokedSessions || {},
    save: r => { store.update(st => { st.revokedSessions = r; }); },
  });
  deps.auth?.(auth);
  const log = deps.log || new AccessLog(cfg.dataDir);
  const now = () => new Date().toISOString();

  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders(cfg));
  app.use(requireHttps(cfg));
  app.use(strictCors(cfg));
  app.use(express.json({ limit: '256kb' }));

  const audit = (req: AuthedRequest, action: string, outcome: 'ok' | 'denied' | 'error' = 'ok', resource?: string) =>
    log.append({ actor: req.account?.id || 'anonymous', role: req.account?.role || 'none', action, resource, outcome });

  // ---------- public, data-free endpoints ----------
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send(ROBOTS_TXT));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // ---------- auth ----------
  app.post('/auth/login', async (req: AuthedRequest, res, next) => {
   try {
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 320);
    const key = `${req.ip}|${email}`;
    if (auth.isLockedOut(key)) {
      log.append({ actor: 'anonymous', role: 'none', action: 'login.locked', outcome: 'denied' });
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
    // Per-email exponential backoff (1s, 2s, 4s ... max 15 min). Not a hard lock; admins can reset it.
    const wait = auth.emailBackoffRemainingMs(email);
    if (wait > 0) {
      log.append({ actor: 'anonymous', role: 'none', action: 'login.backoff', outcome: 'denied' });
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
    const result = await auth.limiter.run(() => auth.login(email, String(req.body?.password || '')));
    if (result === ConcurrencyLimiter.BUSY) {
      res.setHeader('Retry-After', '1');
      return res.status(429).json({ error: 'server busy, try again' });
    }
    const acct = result;
    if (!acct) {
      auth.recordFailure(key);
      auth.recordEmailFailure(email);
      log.append({ actor: 'anonymous', role: 'none', action: 'login.failure', outcome: 'denied' });
      return res.status(401).json({ error: 'invalid credentials' });
    }
    auth.clearFailures(key);
    auth.clearEmailBackoff(email);
    auth.issueSession(res, acct);
    log.append({ actor: acct.id, role: acct.role, action: 'login.success', outcome: 'ok' });
    res.json({ id: acct.id, name: acct.name, role: acct.role });
   } catch (e) { next(e); }
  });
  // No self-registration route exists, by design.

  app.post('/auth/logout', (req: AuthedRequest, res) => {
    const acct = auth.resolve(req);
    auth.clearSession(req, res);
    if (acct) log.append({ actor: acct.id, role: acct.role, action: 'logout', outcome: 'ok' });
    res.json({ ok: true });
  });

  // ---------- everything under /api requires a valid session (deny by default) ----------
  const api = express.Router();
  api.use(auth.requireAuth);
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  api.get('/me', (req: AuthedRequest, res) => {
    const a = req.account!;
    res.json({ id: a.id, name: a.name, role: a.role, flags: { lawyerApprovedPublish: cfg.lawyerApprovedPublish } });
  });

  api.get('/case', (req: AuthedRequest, res) => {
    audit(req, 'case.view');
    res.json(caseViewFor(req.account!, cfg, store.read()));
  });

  api.get('/case/status', allow('employee', 'lawyer', 'enterprise', 'admin'), (_req, res) => {
    res.json(statusView(store.read()));
  });

  api.put('/case/status', allow('lawyer'), (req: AuthedRequest, res) => {
    const status = req.body?.status as CaseStatus;
    if (!CASE_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
    const s = store.update(st => { st.case.status = status; st.case.updatedAt = now(); });
    audit(req, 'case.status.update');
    res.json(statusView(s));
  });

  api.put('/case/visa-type', allow('lawyer'), (req: AuthedRequest, res) => {
    const v = String(req.body?.visaType || '').trim();
    if (!v || v.length > 64) return res.status(400).json({ error: 'invalid visaType' });
    store.update(st => { st.case.visaType = v; st.case.visaTypeSetAt = now(); st.case.updatedAt = now(); });
    audit(req, 'case.visaType.update');
    res.json({ ok: true });
  });

  // ---------- consent (employee must sign before questionnaire/upload) ----------
  api.post('/consent', allow('employee'), (req: AuthedRequest, res) => {
    if (req.body?.agree !== true) return res.status(400).json({ error: 'agree must be true' });
    store.update(st => { st.consent = { accountId: req.account!.id, signedAt: now(), version: CONSENT_VERSION }; });
    audit(req, 'consent.sign');
    res.json({ ok: true });
  });
  const requireConsent = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.account!.role !== 'employee') return next();
    const c = store.read().consent;
    if (!c || c.accountId !== req.account!.id) return res.status(412).json({ error: 'consent required' });
    next();
  };

  // ---------- questionnaire ----------
  api.get('/questionnaire', allow('employee', 'lawyer'), (req: AuthedRequest, res) => {
    const q = store.read().questionnaire;
    if (req.account!.role === 'employee' && q.ownerId && q.ownerId !== req.account!.id) return res.status(403).json({ error: 'forbidden' });
    audit(req, 'questionnaire.view');
    res.json({ questions: cfg.questions, answers: q.answers, updatedAt: q.updatedAt, submittedAt: q.submittedAt });
  });

  api.put('/questionnaire', allow('employee'), requireConsent, (req: AuthedRequest, res) => {
    const answers = req.body?.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return res.status(400).json({ error: 'answers must be an object' });
    const allowed = new Set(cfg.questions.map(q => q.id));
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(answers)) {
      if (!allowed.has(k)) continue;
      clean[k] = String(v ?? '').slice(0, 20000);
    }
    store.update(st => {
      st.questionnaire = {
        ownerId: req.account!.id,
        answers: { ...st.questionnaire.answers, ...clean },
        updatedAt: now(),
        submittedAt: req.body?.submit === true ? now() : st.questionnaire.submittedAt,
      };
      if (st.case.status === 'invited') { st.case.status = 'intake'; st.case.updatedAt = now(); }
    });
    audit(req, req.body?.submit === true ? 'questionnaire.submit' : 'questionnaire.save');
    res.json({ ok: true });
  });

  // ---------- materials ----------
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: cfg.maxUploadBytes, files: 1 } });

  api.get('/materials', allow('employee', 'lawyer'), (req: AuthedRequest, res) => {
    audit(req, 'materials.list');
    const s = store.read();
    res.json(visibleMaterials(req.account!, s).map(m =>
      req.account!.role === 'lawyer' ? { ...materialMeta(m), ownerId: m.ownerId, category: m.category } : materialMeta(m)));
  });

  api.post('/materials', allow('employee', 'lawyer'), requireConsent, upload.single('file'), (req: AuthedRequest, res) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'file required' });
    // Type is decided by the file's content (magic bytes), never by the client-reported MIME.
    const detected = detectFileType(f.buffer);
    if (!detected || !ALLOWED_MIME.has(detected)) return res.status(415).json({ error: 'unsupported file type' });
    const id = crypto.randomUUID();
    const filename = path.basename(f.originalname).replace(/[^\w.\- ()]/g, '_').slice(0, 200) || 'file';
    store.putBlob(id, f.buffer);
    store.update(st => {
      st.materials.push({ id, ownerId: req.account!.id, filename, mimeType: detected, size: f.size, uploadedAt: now(), category: null });
    });
    audit(req, 'material.upload', 'ok', id);
    res.status(201).json({ id });
  });

  /** Owner (employee) or lawyer only. 404 (not 403) for others so ids can't be probed. */
  function findVisibleMaterial(req: AuthedRequest) {
    const s = store.read();
    return visibleMaterials(req.account!, s).find(m => m.id === req.params.id) || null;
  }

  // PR1: authenticated streaming download (no static /uploads route exists).
  // PR2 replaces this with short-lived signed URLs over encrypted blobs.
  api.get('/materials/:id/download', allow('employee', 'lawyer'), (req: AuthedRequest, res) => {
    const m = findVisibleMaterial(req);
    if (!m) { audit(req, 'material.download', 'denied', req.params.id); return res.status(404).json({ error: 'not found' }); }
    const data = store.getBlob(m.id);
    if (!data) return res.status(404).json({ error: 'not found' });
    audit(req, 'material.download', 'ok', m.id);
    res.setHeader('Content-Type', m.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${m.filename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(data);
  });

  api.put('/materials/:id/category', allow('lawyer'), (req: AuthedRequest, res) => {
    const cat = String(req.body?.category || '').trim().slice(0, 100) || null;
    let found = false;
    store.update(st => { const m = st.materials.find(x => x.id === req.params.id); if (m) { m.category = cat; found = true; } });
    if (!found) return res.status(404).json({ error: 'not found' });
    audit(req, 'material.category.update', 'ok', req.params.id);
    res.json({ ok: true });
  });

  api.delete('/materials/:id', allow('employee', 'lawyer'), (req: AuthedRequest, res) => {
    const m = findVisibleMaterial(req);
    if (!m) { audit(req, 'material.delete', 'denied', req.params.id); return res.status(404).json({ error: 'not found' }); }
    store.deleteBlob(m.id);
    store.update(st => { st.materials = st.materials.filter(x => x.id !== m.id); });
    audit(req, 'material.delete', 'ok', m.id);
    res.json({ ok: true });
  });

  // ---------- lawyer-confirmed to-dos (gap list items) ----------
  api.post('/todos', allow('lawyer'), (req: AuthedRequest, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'text required' });
    const id = crypto.randomUUID();
    store.update(st => { st.todos.push({ id, text, createdAt: now(), published: false }); });
    audit(req, 'todo.create', 'ok', id);
    res.status(201).json({ id });
  });
  api.put('/todos/:id/publish', allow('lawyer'), (req: AuthedRequest, res) => {
    let found = false;
    store.update(st => { const t = st.todos.find(x => x.id === req.params.id); if (t) { t.published = req.body?.published !== false; found = true; } });
    if (!found) return res.status(404).json({ error: 'not found' });
    audit(req, 'todo.publish', 'ok', req.params.id);
    res.json({ ok: true });
  });

  // ---------- AI eligibility assessment (lawyer-gated publish) ----------
  api.get('/assessment', allow('lawyer', 'employee'), (req: AuthedRequest, res) => {
    const s = store.read();
    if (req.account!.role === 'lawyer') { audit(req, 'assessment.view'); return res.json(s.assessment); }
    const view = employeeAssessment(cfg, s);
    if (!view) return res.status(404).json({ error: 'not available' });
    audit(req, 'assessment.view');
    res.json(view);
  });

  /** Lawyer saves/edits the assessment text (AI generation arrives in PR2). Any edit revokes approval. */
  api.put('/assessment', allow('lawyer'), (req: AuthedRequest, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 50000);
    if (!text) return res.status(400).json({ error: 'text required' });
    const source = req.body?.source === 'ai' ? 'ai' : 'lawyer';
    store.update(st => { st.assessment = { text, source, updatedAt: now(), approval: null }; });
    audit(req, 'assessment.update');
    res.json({ ok: true });
  });

  api.post('/assessment/approve', allow('lawyer'), (req: AuthedRequest, res) => {
    const s = store.read();
    if (!s.assessment) return res.status(404).json({ error: 'no assessment' });
    store.update(st => { st.assessment!.approval = { by: req.account!.id, at: now() }; });
    audit(req, 'assessment.approve');
    res.json({ ok: true, visibleToEmployee: cfg.lawyerApprovedPublish });
  });

  api.post('/assessment/revoke', allow('lawyer'), (req: AuthedRequest, res) => {
    store.update(st => { if (st.assessment) st.assessment.approval = null; });
    audit(req, 'assessment.revoke');
    res.json({ ok: true });
  });

  // ---------- account management (admin): read-only view of the env-configured allowlist ----------
  // Accounts are changed only via PILOT_ACCOUNTS + redeploy; there is no write API by design.
  api.get('/accounts', allow('admin'), (req: AuthedRequest, res) => {
    audit(req, 'accounts.view');
    // Explicit allowlist of fields. Never emails, hashes, reset tokens/links, or any case data.
    res.json({ accounts: cfg.accounts.map(accountSummary) });
  });

  // Manual unlock: resets an email's login backoff and IP+email locks. Always audited.
  api.post('/accounts/unlock', allow('admin'), (req: AuthedRequest, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || email.length > 320) return res.status(400).json({ error: 'email required' });
    auth.unlockEmail(email);
    const target = auth.findByEmail(email);
    audit(req, 'login.unlock', 'ok', target ? target.id : 'unknown-account'); // account id only, never the email
    res.json({ ok: true });
  });

  // ---------- access log (stub) ----------
  api.get('/access-log', allow('lawyer', 'admin'), (req: AuthedRequest, res) => {
    audit(req, 'accessLog.view');
    res.json(log.list());
  });

  api.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use('/api', api);

  // ---------- static UI (login page + shell; contains no data) ----------
  app.use(express.static(publicDir(), { index: 'index.html', dotfiles: 'deny', redirect: false }));
  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

  // generic error handler: never echo internals or request content
  app.use((err: any, _req: AuthedRequest, res: Response, _next: NextFunction) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file too large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid json' });
    console.error('[pilot] request error:', err?.code || err?.name || 'error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
