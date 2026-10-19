import crypto from 'crypto';
import path from 'path';
import express, { type Response, type NextFunction } from 'express';
import multer from 'multer';
import { publicDir, type PilotConfig } from './config';
import { Auth, allow, type AuthedRequest } from './auth';
import { EncryptedFileStore, CASE_STATUSES, type Store, type CaseStatus } from './store';
import { Cipher } from './crypto';
import { AiClient, AiProviderError, fillTemplate, type FetchLike } from './ai/provider';
import { AccessLog } from './accessLog';
import { securityHeaders, strictCors, requireHttps, ROBOTS_TXT } from './security';
import { caseViewFor, statusView, visibleMaterials, materialMeta, employeeAssessment } from './views';

export const ALLOWED_MIME = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
export const CONSENT_VERSION = 'draft-lawyer-review-required';

export interface AppDeps { store?: Store; log?: AccessLog; fetch?: FetchLike }

export function createApp(cfg: PilotConfig, deps: AppDeps = {}) {
  const app = express();
  const auth = new Auth(cfg);
  const cipher = new Cipher(cfg.encryptionKey);
  const store: Store = deps.store || new EncryptedFileStore(cfg.dataDir, cipher);
  const log = deps.log || new AccessLog(cfg.dataDir, cipher);
  const ai = new AiClient(cfg.ai, deps.fetch);
  const now = () => new Date().toISOString();

  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders(cfg));
  app.use(requireHttps(cfg));
  app.use(strictCors(cfg));
  app.use(express.json({ limit: '256kb' }));

  const signDownload = (id: string, sub: string, exp: number) =>
    crypto.createHmac('sha256', cfg.downloadUrlSecret).update(`dl|${id}|${sub}|${exp}`).digest('base64url');
  const verifyDownload = (id: string, sub: string, exp: number, sig: string) => {
    const a = Buffer.from(signDownload(id, sub, exp)), b = Buffer.from(sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const audit = (req: AuthedRequest, action: string, outcome: 'ok' | 'denied' | 'error' = 'ok', resource?: string) =>
    log.append({ actor: req.account?.id || 'anonymous', role: req.account?.role || 'none', action, resource, outcome });

  // ---------- public, data-free endpoints ----------
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send(ROBOTS_TXT));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // ---------- auth ----------
  app.post('/auth/login', (req: AuthedRequest, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const key = `${req.ip}|${email}`;
    if (auth.isLockedOut(key)) {
      log.append({ actor: 'anonymous', role: 'none', action: 'login.locked', outcome: 'denied' });
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
    const acct = auth.login(email, String(req.body?.password || ''));
    if (!acct) {
      auth.recordFailure(key);
      log.append({ actor: 'anonymous', role: 'none', action: 'login.failure', outcome: 'denied' });
      return res.status(401).json({ error: 'invalid credentials' });
    }
    auth.clearFailures(key);
    auth.issueSession(res, acct);
    log.append({ actor: acct.id, role: acct.role, action: 'login.success', outcome: 'ok' });
    res.json({ id: acct.id, name: acct.name, role: acct.role });
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
    if (!ALLOWED_MIME.has(f.mimetype)) return res.status(415).json({ error: 'unsupported file type' });
    const id = crypto.randomUUID();
    const filename = path.basename(f.originalname).replace(/[^\w.\- ()]/g, '_').slice(0, 200) || 'file';
    store.putBlob(id, f.buffer);
    store.update(st => {
      st.materials.push({ id, ownerId: req.account!.id, filename, mimeType: f.mimetype, size: f.size, uploadedAt: now(), category: null });
    });
    audit(req, 'material.upload', 'ok', id);
    res.status(201).json({ id });
  });

  /** Owner (employee) or lawyer only. 404 (not 403) for others so ids can't be probed. */
  function findVisibleMaterial(req: AuthedRequest) {
    const s = store.read();
    return visibleMaterials(req.account!, s).find(m => m.id === req.params.id) || null;
  }

  // Short-lived signed download URL (bound to the requesting account). No static /uploads.
  api.post('/materials/:id/download-url', allow('employee', 'lawyer'), (req: AuthedRequest, res) => {
    const m = findVisibleMaterial(req);
    if (!m) { audit(req, 'material.downloadUrl', 'denied', req.params.id); return res.status(404).json({ error: 'not found' }); }
    const exp = Math.floor(Date.now() / 1000) + cfg.downloadUrlTtlSeconds;
    const sig = signDownload(m.id, req.account!.id, exp);
    audit(req, 'material.downloadUrl', 'ok', m.id);
    res.json({ url: `/files/${m.id}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() });
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

  // ---------- access log (stub) ----------
  api.get('/access-log', allow('lawyer', 'admin'), (req: AuthedRequest, res) => {
    audit(req, 'accessLog.view');
    res.json(log.list());
  });

  // ---------- AI: lawyer-triggered eligibility assessment draft ----------
  api.post('/assessment/generate', allow('lawyer'), async (req: AuthedRequest, res) => {
    if (!ai.enabled || !cfg.ai.prompts) return res.status(503).json({ error: 'AI provider not configured' });
    const s = store.read();
    // Guardrail: no visa-specific AI output before the lawyer has chosen the visa type.
    if (!s.case.visaType) return res.status(409).json({ error: 'set visa type first' });
    const ids: string[] = Array.isArray(req.body?.materialIds) ? req.body.materialIds.map(String) : [];
    const mats = s.materials.filter(m => ids.includes(m.id));
    const attachments = mats.map(m => ({ mimeType: m.mimeType, filename: m.filename, data: store.getBlob(m.id) || Buffer.alloc(0) }));
    const { skipped } = ai.partition(attachments);
    const vars = {
      visaType: s.case.visaType,
      questionnaire: cfg.questions.map(q => `${q.text}\n${s.questionnaire.answers[q.id] || '(no answer)'}`).join('\n\n'),
      materials: mats.map(m => `- ${m.filename}${m.category ? ` [${m.category}]` : ''}`).join('\n'),
    };
    try {
      const r = await ai.generate({ system: cfg.ai.prompts.assessment.system, prompt: fillTemplate(cfg.ai.prompts.assessment.user, vars), attachments });
      store.update(st => { st.assessment = { text: r.text, source: 'ai', updatedAt: now(), approval: null }; });
      audit(req, 'ai.assessment.generate', 'ok', `${r.provider}:${r.model}:${r.requestId || '-'}:files=${attachments.length - skipped.length}`);
      res.json({ ok: true, chars: r.text.length, skippedMaterialIds: mats.filter((_m, i) => skipped.includes(attachments[i])).map(m => m.id) });
    } catch (e: any) {
      audit(req, 'ai.assessment.generate', 'error', ai.label);
      res.status(502).json({ error: e instanceof AiProviderError ? `AI provider error (${e.status})` : 'AI request failed' });
    }
  });

  api.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use('/api', api);

  // ---------- signed file downloads ----------
  // Requires BOTH a valid, unexpired signature AND the same signed-in account it was issued to,
  // and re-checks visibility at download time.
  app.get('/files/:id', (req: AuthedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const acct = auth.resolve(req);
    if (!acct) return res.status(401).json({ error: 'unauthenticated' });
    req.account = acct;
    const exp = Number(req.query.exp), sig = String(req.query.sig || '');
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000) || !verifyDownload(req.params.id, acct.id, exp, sig)) {
      audit(req, 'material.download', 'denied', req.params.id);
      return res.status(403).json({ error: 'link invalid or expired' });
    }
    const m = findVisibleMaterial(req);
    const data = m ? store.getBlob(m.id) : null;
    if (!m || !data) { audit(req, 'material.download', 'denied', req.params.id); return res.status(404).json({ error: 'not found' }); }
    audit(req, 'material.download', 'ok', m.id);
    res.setHeader('Content-Type', m.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${m.filename.replace(/"/g, '')}"`);
    res.send(data);
  });

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
