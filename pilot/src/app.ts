import crypto from 'crypto';
import path from 'path';
import express, { type Response, type NextFunction } from 'express';
import multer from 'multer';
import { publicDir, type PilotConfig } from './config';
import { Auth, allow, ConcurrencyLimiter, type AuthedRequest } from './auth';
import { detectFileType } from './fileType';
import { EncryptedFileStore, CASE_STATUSES, type Store, type CaseStatus, type Material } from './store';
import { Cipher } from './crypto';
import { DraftRegister } from './draftRegister';
import { casePlaybooks } from './caseTools';
import { mountPetition } from './petitionRoutes';
import { mountCaseTools } from './caseToolsRoutes';
import { hasCurrentConsent } from './consent';
import { mountEnterpriseCases } from './enterpriseRoutes';
import { AiClient, AiProviderError, fillTemplate, type FetchLike } from './ai/provider';
import { AccessLog, parseAnchor, stdoutAnchorSink, type AnchorSink } from './accessLog';
import { securityHeaders, strictCors, requireHttps, ROBOTS_TXT } from './security';
import { caseViewFor, statusView, visibleMaterials, materialMeta, employeeAssessment } from './views';

export const ALLOWED_MIME = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/** The ONLY fields an account listing may expose. */
export const ACCOUNT_SUMMARY_KEYS = ['enabled', 'id', 'name', 'role'] as const;
export function accountSummary(a: { id: string; name: string; role: string; enabled: boolean }) {
  return { id: a.id, name: a.name, role: a.role, enabled: a.enabled };
}

export interface AppDeps { store?: Store; log?: AccessLog; fetch?: FetchLike; voiceFetch?: typeof fetch; auth?: (auth: Auth) => void; anchorSink?: AnchorSink }

export function createApp(cfg: PilotConfig, deps: AppDeps = {}) {
  const app = express();
  const cipher = new Cipher(cfg.encryptionKey);
  const store: Store = deps.store || new EncryptedFileStore(cfg.dataDir, cipher);
  const original = store.read();
  if (original.primaryEmployeeId && original.primaryEmployeeId !== cfg.primaryEmployeeId) {
    throw new Error('Configured employee does not match the original case employee');
  }
  if (!original.primaryEmployeeId && cfg.accounts.filter(account => account.role === 'employee').length > 1) {
    const historicalOwners = [original.consent?.accountId, original.questionnaire.ownerId];
    if (historicalOwners.some(owner => owner && owner !== cfg.primaryEmployeeId)) {
      throw new Error('Configured employee does not match the original case records');
    }
    store.update(state => { state.primaryEmployeeId = cfg.primaryEmployeeId; });
  }
  const originalCaseAccess = (account: { id: string; role: string }) =>
    account.role !== 'employee' || account.id === cfg.primaryEmployeeId;
  // Revoked sessions are persisted in the (encrypted) case data store, so logout survives restarts.
  const auth = new Auth(cfg, {
    load: () => store.read().revokedSessions || {},
    save: r => { store.update(st => { st.revokedSessions = r; }); },
  });
  deps.auth?.(auth);
  // Every append also prints {event:'access_log_anchor', seq, entries, hash} to stdout (Render logs = off-disk anchor).
  const log = deps.log || new AccessLog(cfg.dataDir, cipher, { anchorSink: deps.anchorSink || (cfg.accessLogAnchorStdout ? stdoutAnchorSink : null) });
  const ai = new AiClient(cfg.ai, deps.fetch);
  const drafts = cfg.draftRegister && new DraftRegister(cfg.draftRegister.dir, cfg.draftRegister.key);
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
    log.append({ actor: req.account?.id || 'anonymous', role: req.account?.role || 'none', action, resource: req.res?.locals.matterId ? [req.res.locals.matterId, resource].filter(Boolean).join('/') : resource, outcome });

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
    const workspaces = a.role === 'lawyer' ? cfg.lawyerWorkspaces?.filter(w => w.lawyerId === a.id)
      .map(({ label, origin }) => ({ label, origin })) : undefined;
    res.json({ id: a.id, name: a.name, role: a.role, flags: { lawyerApprovedPublish: cfg.lawyerApprovedPublish },
      ...(cfg.syntheticDemo ? { syntheticDemo: true } : {}),
      ...(!originalCaseAccess(a) ? { originalCaseAccess: false } : {}),
      ...(drafts && a.role === 'lawyer' ? { invitees: cfg.accounts.filter(x => x.enabled && x.role === 'employee')
        .map(x => ({ id: x.id, name: x.name })) } : {}),
      ...(workspaces?.length ? { workspaces } : {}), ...(drafts && ['lawyer', 'employee', 'enterprise'].includes(a.role) ? { draftRegister: true } : {}) });
  });

  const intake = express.Router();
  if (drafts) {
    const draftFiles = express.Router();
    draftFiles.get('/files/:id', serveDownload);
    const lawyer = cfg.accounts.find(a => a.role === 'lawyer')!;
    mountEnterpriseCases(api, drafts, lawyer.id, audit);
    const requestedAccount = (email: string) => cfg.accounts.find(account => account.role === 'employee' && account.enabled && account.email === email);
    api.get('/matter-invitations', allow('employee'), (req: AuthedRequest, res) => {
      const rows = drafts.list(lawyer.id).filter(r => r.invitation?.employeeId === req.account!.id);
      audit(req, 'draft.invitations.list');
      res.json(rows.map(r => ({ id: r.id, label: r.label, accepted: r.invitation!.accepted })));
    });
    api.post('/draft-matters/:id/invite', allow('lawyer'), (req: AuthedRequest, res) => {
      const row = drafts.list(req.account!.id).find(entry => entry.id === req.params.id);
      if (!row) return res.status(404).json({ error: 'matter unavailable' });
      if (row.request && row.request.decision !== 'accepted')
        return res.status(409).json({ error: 'Accept the enterprise request first' });
      const employee = cfg.accounts.find(a => a.role === 'employee' && a.enabled && a.id === req.body?.employeeId);
      if (!employee) return res.status(400).json({ error: 'invalid employee' });
      if (row.request && employee.id !== requestedAccount(row.request.email)?.id)
        return res.status(409).json({ error: 'Invite the employee matching the requested work email' });
      const invitation = drafts.invite(req.account!.id, req.params.id, employee.id);
      if (invitation === 'missing') return res.status(404).json({ error: 'matter unavailable' });
      if (invitation === 'assigned') return res.status(409).json({ error: 'Matter already assigned to another employee' });
      if (invitation === 'pending') return res.status(409).json({ error: 'Accept the enterprise request first' });
      audit(req, 'draft.invite', 'ok', req.params.id);
      res.json({ ok: true, invitation });
    });
    api.post('/matter-invitations/:id/accept', allow('employee'), (req: AuthedRequest, res) => {
      if (!drafts.accept(lawyer.id, req.params.id, req.account!.id))
        return res.status(404).json({ error: 'invitation unavailable' });
      audit(req, 'draft.accept', 'ok', req.params.id);
      res.json({ ok: true });
    });
    api.use('/draft-matters/:matterId/intake', allow('employee', 'lawyer'), (req: AuthedRequest, res, next) => {
      const row = drafts.list(lawyer.id).find(r => r.id === req.params.matterId);
      if (!row || (row.request && row.request.decision !== 'accepted') || (req.account!.role === 'employee' &&
          (!row.invitation?.accepted || row.invitation.employeeId !== req.account!.id)))
        return res.status(404).json({ error: 'matter unavailable' });
      res.locals.intakeStore = drafts.intakeStore(row);
      res.locals.matterId = row.id;
      next();
    }, intake, draftFiles);
    api.get('/draft-matters', allow('lawyer'), (req: AuthedRequest, res) => {
      const rows = drafts.list(req.account!.id);
      audit(req, 'draft.list');
      res.json(rows.map(row => row.request ? { ...row, requestedEmployeeId: requestedAccount(row.request.email)?.id ?? null } : row));
    });
    api.post('/draft-matters', allow('lawyer'), (req: AuthedRequest, res) => {
      const label = req.body?.label;
      if (typeof label !== 'string' || !label.trim() || label.trim().length > 80)
        return res.status(400).json({ error: 'Enter a matter reference of 1 to 80 characters' });
      const row = drafts.create(req.account!.id, label.trim());
      audit(req, 'draft.create', 'ok', row.id);
      res.status(201).json(row);
    });
    api.put('/draft-matters/:id/status', allow('lawyer'), (req: AuthedRequest, res) => {
      if (!CASE_STATUSES.includes(req.body?.status)) return res.status(400).json({ error: 'invalid status' });
      const row = drafts.setStatus(req.account!.id, req.params.id, req.body.status);
      if (!row) return res.status(404).json({ error: 'matter not found' });
      audit(req, 'draft.status.update', 'ok', row.id);
      res.json(row);
    });
  }

  // The routes below serve the original case. Invited matters are handled above.
  api.use((req: AuthedRequest, res, next) => {
    if (!originalCaseAccess(req.account!)) return res.status(403).json({ error: 'Original case unavailable' });
    next();
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

  const intakeStore = (res: Response): Store => res.locals.intakeStore || store;
  mountPetition(intake, intakeStore, ai, cfg.ai.prompts?.petition, cfg.consentDocument, audit);
  mountCaseTools(intake, intakeStore, ai, cfg, audit, deps.voiceFetch);
  const downloadIdentity = (res: Response, id: string) => res.locals.matterId ? res.locals.matterId + '/' + id : id;

  intake.get('/playbook-checklist', allow('lawyer'), (req: AuthedRequest, res) => {
    const state = intakeStore(res).read();
    const playbooks = casePlaybooks(state);
    const classifyAvailable = ai.enabled && hasCurrentConsent(state, cfg.consentDocument);
    const selection = state.playbook;
    const playbook = playbooks.find(p => p.id === selection?.id);
    const documents = playbook?.documents.filter(d => d.scenarios.includes(selection!.scenario)) ?? [];
    const materials = state.materials.map(m => ({
      id: m.id,
      filename: m.filename,
      ...(classifyAvailable ? { classifiable: ['application/pdf', 'text/plain', 'image/jpeg', 'image/png'].includes(m.mimeType) } : {}),
      documentId: playbook ? m.checklistDocuments?.[playbook.id] ?? null : null,
    }));
    audit(req, 'playbook.checklist.view');
    res.json({ catalog: playbooks.map(({ id, caseType, scenarios }) => ({ id, caseType, scenarios })),
      selection, documents, materials, classifyAvailable });
  });

  intake.put('/playbook-checklist', allow('lawyer'), (req: AuthedRequest, res) => {
    const { id, scenario } = req.body ?? {};
    const target = intakeStore(res);
    const playbook = casePlaybooks(target.read()).find(p => p.id === id);
    if (!playbook || typeof scenario !== 'string' || !Object.hasOwn(playbook.scenarios, scenario))
      return res.status(400).json({ error: 'Select an available playbook and scenario' });
    target.update(state => { state.playbook = { id: playbook.id, scenario }; });
    audit(req, 'playbook.checklist.select');
    res.json({ ok: true });
  });

  intake.put('/playbook-checklist/materials/:id', allow('lawyer'), (req: AuthedRequest, res) => {
    const { playbookId, scenario, documentId } = req.body ?? {};
    const target = intakeStore(res);
    const state = target.read();
    const selection = state.playbook;
    if (!selection || selection.id !== playbookId || selection.scenario !== scenario)
      return res.status(409).json({ error: 'The selected playbook changed. Reload the checklist.' });
    const playbook = casePlaybooks(state).find(p => p.id === selection.id);
    if (documentId !== null && !playbook?.documents.some(d => d.id === documentId && d.scenarios.includes(selection.scenario)))
      return res.status(400).json({ error: 'Select a document from the current checklist' });
    if (!state.materials.some(m => m.id === req.params.id)) return res.status(404).json({ error: 'material not found' });
    target.update(current => {
      const material = current.materials.find(m => m.id === req.params.id)!;
      const links = material.checklistDocuments ??= {};
      if (documentId === null) delete links[selection.id];
      else links[selection.id] = documentId;
    });
    audit(req, 'playbook.checklist.link', 'ok', req.params.id);
    res.json({ ok: true });
  });

  intake.get('/consent', allow('employee', 'lawyer'), (req: AuthedRequest, res) => {
    const employeeId = req.account!.role === 'employee' ? req.account!.id : undefined;
    const signed = hasCurrentConsent(intakeStore(res).read(), cfg.consentDocument, employeeId);
    res.json({ signed, document: cfg.consentDocument ?? null });
  });
  // ---------- consent (employee must sign before questionnaire/upload) ----------
  intake.post('/consent', allow('employee'), (req: AuthedRequest, res) => {
    if (req.body?.agree !== true) return res.status(400).json({ error: 'agree must be true' });
    const document = cfg.consentDocument;
    if (!document) return res.status(412).json({ error: 'Your attorney has not made the consent document available yet' });
    if ((!document.preview || req.body?.digest !== undefined) && req.body?.digest !== document.digest)
      return res.status(409).json({ error: 'The consent document changed. Reload it before agreeing.' });
    intakeStore(res).update(st => {
      if (!hasCurrentConsent(st, document, req.account!.id))
        st.consent = { accountId: req.account!.id, signedAt: now(), version: document.version, digest: document.digest };
    });
    audit(req, 'consent.sign');
    res.json({ ok: true });
  });
  const requireConsent = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.account!.role !== 'employee') return next();
    if (!hasCurrentConsent(intakeStore(res).read(), cfg.consentDocument, req.account!.id))
      return res.status(412).json({ error: 'consent required' });
    next();
  };

  // ---------- questionnaire ----------
  intake.get('/questionnaire', allow('employee', 'lawyer'), (req: AuthedRequest, res) => {
    const q = intakeStore(res).read().questionnaire;
    if (req.account!.role === 'employee' && q.ownerId && q.ownerId !== req.account!.id) return res.status(403).json({ error: 'forbidden' });
    audit(req, 'questionnaire.view');
    res.json({ questions: cfg.questions, answers: q.answers, updatedAt: q.updatedAt, submittedAt: q.submittedAt });
  });

  intake.put('/questionnaire', allow('employee'), requireConsent, (req: AuthedRequest, res) => {
    const answers = req.body?.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return res.status(400).json({ error: 'answers must be an object' });
    const allowed = new Set(cfg.questions.map(q => q.id));
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(answers)) {
      if (!allowed.has(k)) continue;
      clean[k] = String(v ?? '').slice(0, 20000);
    }
    intakeStore(res).update(st => {
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

  intake.get('/materials', allow('employee', 'lawyer'), (req: AuthedRequest, res) => {
    audit(req, 'materials.list');
    const s = intakeStore(res).read();
    res.json(visibleMaterials(req.account!, s).map(m =>
      req.account!.role === 'lawyer' ? { ...materialMeta(m), ownerId: m.ownerId, category: m.category } : materialMeta(m)));
  });

  intake.post('/materials', allow('employee', 'lawyer'), requireConsent, upload.single('file'), (req: AuthedRequest, res) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'file required' });
    // Type is decided by the file's content (magic bytes), never by the client-reported MIME.
    const detected = detectFileType(f.buffer);
    if (!detected || !ALLOWED_MIME.has(detected)) return res.status(415).json({ error: 'unsupported file type' });
    const id = crypto.randomUUID();
    const filename = path.basename(f.originalname).replace(/[^\w.\- ()]/g, '_').slice(0, 200) || 'file';
    const target = intakeStore(res);
    target.putBlob(id, f.buffer);
    try {
      target.update(st => {
        st.materials.push({ id, ownerId: req.account!.id, filename, mimeType: detected, size: f.size, uploadedAt: now(), category: null });
      });
    } catch (err) { target.deleteBlob(id); throw err; }
    audit(req, 'material.upload', 'ok', id);
    res.status(201).json({ id });
  });

  /** Owner (employee) or lawyer only. 404 (not 403) for others so ids can't be probed. */
  function findVisibleMaterial(req: AuthedRequest, selectedStore: Store = store) {
    const s = selectedStore.read();
    return visibleMaterials(req.account!, s).find(m => m.id === req.params.id) || null;
  }

  // Short-lived signed download URL (bound to the requesting account). No static /uploads.
  intake.post('/materials/:id/download-url', allow('employee', 'lawyer'), (req: AuthedRequest, res) => {
    const m = findVisibleMaterial(req, intakeStore(res));
    if (!m) { audit(req, 'material.downloadUrl', 'denied', req.params.id); return res.status(404).json({ error: 'not found' }); }
    const exp = Math.floor(Date.now() / 1000) + cfg.downloadUrlTtlSeconds;
    const sig = signDownload(downloadIdentity(res, m.id), req.account!.id, exp);
    audit(req, 'material.downloadUrl', 'ok', m.id);
    res.json({ url: `${res.locals.matterId ? req.baseUrl : ''}/files/${m.id}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() });
  });

  api.use(intake);

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

  // ---------- access log ----------
  // Never fails on a damaged line: bad lines come back as {line, corrupted_or_tampered: true, reason}.
  api.get('/access-log', allow('lawyer', 'admin'), (req: AuthedRequest, res) => {
    audit(req, 'accessLog.view');
    res.json(log.list());
  });

  // ---------- AI: lawyer-triggered eligibility assessment draft ----------
  // The whole body is wrapped: Express 4 does not catch a rejected promise from an async
  // handler, so anything thrown outside a try here would hang the request and take the
  // process down with an unhandled rejection instead of answering the lawyer.
  api.post('/assessment/generate', allow('lawyer'), async (req: AuthedRequest, res, next) => {
   try {
    if (!ai.enabled || !cfg.ai.prompts) return res.status(503).json({ error: 'AI provider not configured' });
    const s = store.read();
    // Guardrail: no visa-specific AI output before the lawyer has chosen the visa type.
    if (!s.case.visaType) return res.status(409).json({ error: 'set visa type first' });
    if (!cfg.consentDocument?.preview && !hasCurrentConsent(s, cfg.consentDocument))
      return res.status(412).json({ error: 'Consent required for this matter' });
    const ids: string[] = Array.isArray(req.body?.materialIds) ? req.body.materialIds.map(String) : [];
    const mats = s.materials.filter(m => ids.includes(m.id));
    // A blob that is missing, empty, or undecryptable (corrupt, or encrypted under a rotated
    // key) is reported back so the lawyer knows to review that document by hand. It is never
    // sent on as an empty attachment and never fails the whole request.
    const readable: { m: Material; data: Buffer }[] = [];
    const unreadableMaterialIds: string[] = [];
    for (const m of mats) {
      let data: Buffer | null = null;
      try { data = store.getBlob(m.id); } catch { data = null; }
      if (data?.length) readable.push({ m, data }); else unreadableMaterialIds.push(m.id);
    }
    // Materials were asked for and not one of them could be read: nothing is sent to the
    // vendor, because an assessment drafted without any of the chosen evidence would look
    // like one that had seen it.
    if (mats.length > 0 && readable.length === 0) {
      audit(req, 'ai.assessment.generate', 'denied', `unreadable-materials=${unreadableMaterialIds.length}`);
      return res.status(409).json({ error: 'none of the selected materials could be read', unreadableMaterialIds });
    }
    const attachments = readable.map(({ m, data }) => ({ mimeType: m.mimeType, filename: m.filename, data }));
    const { skipped } = ai.partition(attachments);
    const vars = {
      visaType: s.case.visaType,
      questionnaire: cfg.questions.map(q => `${q.text}\n${s.questionnaire.answers[q.id] || '(no answer)'}`).join('\n\n'),
      materials: mats.map(m => `- ${m.filename}${m.category ? ` [${m.category}]` : ''}`).join('\n'),
    };
    let r;
    try {
      r = await ai.generate({ system: cfg.ai.prompts.assessment.system, prompt: fillTemplate(cfg.ai.prompts.assessment.user, vars), attachments });
    } catch (e: any) {
      audit(req, 'ai.assessment.generate', 'error', ai.label);
      return res.status(502).json({ error: e instanceof AiProviderError ? `AI provider error (${e.status})` : 'AI request failed' });
    }
    // Audited BEFORE the save: at this point the case files have already reached the vendor,
    // so the disclosure must be on record even if persisting the draft then fails.
    audit(req, 'ai.assessment.generate', 'ok', `${r.provider}:${r.model}:${r.requestId || '-'}:files=${attachments.length - skipped.length}`);
    store.update(st => { st.assessment = { text: r.text, source: 'ai', updatedAt: now(), approval: null }; });
    res.json({
      ok: true,
      chars: r.text.length,
      skippedMaterialIds: readable.filter((_x, i) => skipped.includes(attachments[i])).map(x => x.m.id),
      unreadableMaterialIds,
    });
   } catch (e) { next(e); }
  });

  // Tamper-evidence check of the hash-chained log; returns the head hash for out-of-band anchoring.
  // Optional ?seq=&hash= : also compare against an anchor recorded off-disk (Render log line / daily email).
  api.get('/access-log/verify', allow('lawyer', 'admin'), (req: AuthedRequest, res) => {
    let anchor;
    if (req.query.seq !== undefined || req.query.hash !== undefined) {
      anchor = parseAnchor({ seq: req.query.seq, hash: req.query.hash });
      if (!anchor) return res.status(400).json({ error: 'seq must be a non-negative integer and hash 64 hex chars' });
    }
    const v = log.verify(anchor || undefined);
    audit(req, 'accessLog.verify', v.ok ? 'ok' : 'error');
    res.json(v);
  });

  api.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use('/api', api);

  // ---------- signed file downloads ----------
  // Requires BOTH a valid, unexpired signature AND the same signed-in account it was issued to,
  // and re-checks visibility at download time.
  function serveDownload(req: AuthedRequest, res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const acct = auth.resolve(req);
    if (!acct) return res.status(401).json({ error: 'unauthenticated' });
    if (!res.locals.matterId && !originalCaseAccess(acct)) return res.status(403).json({ error: 'Original case unavailable' });
    req.account = acct;
    const exp = Number(req.query.exp), sig = String(req.query.sig || '');
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000) || !verifyDownload(downloadIdentity(res, req.params.id), acct.id, exp, sig)) {
      audit(req, 'material.download', 'denied', req.params.id);
      return res.status(403).json({ error: 'link invalid or expired' });
    }
    const m = findVisibleMaterial(req, intakeStore(res));
    const data = m ? intakeStore(res).getBlob(m.id) : null;
    if (!m || !data) { audit(req, 'material.download', 'denied', req.params.id); return res.status(404).json({ error: 'not found' }); }
    audit(req, 'material.download', 'ok', m.id);
    res.setHeader('Content-Type', m.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${m.filename.replace(/"/g, '')}"`);
    res.send(data);
  }
  app.get('/files/:id', serveDownload);

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
