import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { type Request } from 'express';
import { createApp } from './app';
import { type Auth, hashPassword, parseCookies } from './auth';
import { loadConfig } from './config';
import { loadConsentDocument } from './consent';
import { DraftRegister } from './draftRegister';
import { requireHttps, securityHeaders, strictCors } from './security';
import { trialProgress } from './trialProgress';

const inviteLifetime = 48 * 60 * 60;
const workspaceLifetime = 2 * 60 * 60;
const maxWorkspaces = 16;
const maxRecords = 200;
const recordRetention = 24 * 60 * 60;
const demoEmployee = 'employee@preview.example.test';
const roles = new Set(['enterprise', 'lawyer', 'employee']);
const secret = () => randomBytes(32).toString('base64');
const digest = (value: string) => createHash('sha256').update(value).digest();

export function createDemoApp({ root, password, organizerKey, secureCookies = true, now = Date.now }: {
  root: string; password: string; organizerKey?: string; secureCookies?: boolean; now?: () => number;
}) {
  if (Buffer.byteLength(password) < 32) throw new Error('Set a random PILOT_DEMO_PASSWORD of at least 32 bytes');
  if (organizerKey && (Buffer.byteLength(organizerKey) < 32 || organizerKey === password))
    throw new Error('Set an independent random PILOT_TRIAL_ORGANIZER_KEY of at least 32 bytes');
  const organizerDigest = organizerKey && digest(organizerKey);
  const inviteKey = organizerKey && createHmac('sha256', organizerKey).update('meritx-guided-trial-v1').digest();
  const hash = hashPassword(password);
  const accounts = [
    ['employee', 'employee', 'Demo Employee'],
    ['employee2', 'employee', 'Demo Employee 2'],
    ['lawyer', 'lawyer', 'Demo Lawyer'],
    ['enterprise', 'enterprise', 'Demo HR'],
    ['admin', 'admin', 'Demo Admin'],
  ].map(([id, role, name]) => ({ id, role, name, email: id + '@preview.example.test', passwordHash: hash }));
  const consent = loadConsentDocument({ NODE_ENV: 'development' })!;
  const trialCookie = secureCookies ? '__Host-mx_trial_workspace' : 'mx_trial_workspace';
  const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'strict' as const, path: '/' };
  function buildWorkspace(dir: string, guided: boolean) {
    const cfg = loadConfig({
      PRIVATE_MODE: 'true', NODE_ENV: 'production', AI_PROVIDER: 'none',
      SECURE_COOKIES: String(secureCookies), TRUST_PROXY: String(secureCookies),
      SESSION_SECRET: secret(), DOWNLOAD_URL_SECRET: secret(), PILOT_ENCRYPTION_KEY: secret(),
      PILOT_DATA_DIR: path.join(dir, 'original'), PILOT_DRAFT_REGISTER_DIR: path.join(dir, 'register'),
      PILOT_DRAFT_REGISTER_KEY: secret(), PILOT_MAX_ACCOUNTS: '5', PILOT_PRIMARY_EMPLOYEE_ID: 'employee',
      PILOT_ACCOUNTS: JSON.stringify(accounts), MAX_UPLOAD_BYTES: String((guided ? 1 : 5) * 1024 * 1024),
      ...(guided ? { SESSION_TTL_SECONDS: String(workspaceLifetime), PILOT_ACCESS_LOG_ANCHOR_STDOUT: 'false' } : {}),
    });
    cfg.consentDocument = consent;
    cfg.syntheticDemo = true;
    cfg.guidedTrial = guided;
    const register = new DraftRegister(cfg.draftRegister!.dir, cfg.draftRegister!.key);
    if (guided) cfg.accounts = cfg.accounts.filter(account => roles.has(account.id));
    else seedDemo(register, consent);
    let auth!: Auth;
    const app = createApp(cfg, { auth: instance => { auth = instance; } });
    return { app, auth, cfg, register };
  }

  const legacy = buildWorkspace(root, false);
  const app = express();
  if (secureCookies) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders(legacy.cfg), requireHttps(legacy.cfg), strictCors(legacy.cfg));
  type Workspace = ReturnType<typeof buildWorkspace> & { invite: string; dir: string; expires: number; uploads: number; hrChecked: boolean };
  const progressOf = (workspace: Workspace) =>
    trialProgress(workspace.register, 'lawyer', 'employee', consent, workspace.hrChecked);
  const workspaces = new Map<string, Workspace>();
  const clock = () => Math.floor(now() / 1000);
  // Organizer-facing activity for each link, kept in memory only: it holds no case content, just
  // timestamps, the step count and the participant's feedback, and it resets with the demo process.
  interface Feedback { ease: number; stuck: string; comment: string; at: number }
  interface TrialRecord {
    note?: string; createdAt?: number; expiresAt: number; openedAt?: number; lastActiveAt?: number;
    done: number; total: number; resets: number; feedback?: Feedback;
  }
  const records = new Map<string, TrialRecord>();
  function record(invite: string, expiresAt: number) {
    let entry = records.get(invite);
    if (!entry) {
      // Keep each record for a day after its link expires so the organizer can still review it.
      for (const [id, old] of records) if (old.expiresAt + recordRetention <= clock()) records.delete(id);
      while (records.size >= maxRecords) records.delete(records.keys().next().value!);
      entry = { expiresAt, done: 0, total: 0, resets: 0 };
      records.set(invite, entry);
    }
    return entry;
  }
  function snapshot(workspace: Workspace) {
    const entry = records.get(workspace.invite);
    if (!entry) return;
    try {
      const { steps } = progressOf(workspace);
      entry.done = steps.filter(step => step.done).length;
      entry.total = steps.length;
    } catch { /* the workspace may already be partly removed */ }
  }
  function discard(workspace: Workspace) {
    snapshot(workspace);
    fs.rmSync(workspace.dir, { recursive: true, force: true });
  }
  function sweep() {
    for (const [id, workspace] of workspaces) {
      if (workspace.expires > clock()) continue;
      workspaces.delete(id);
      discard(workspace);
    }
  }
  function workspaceId(req: Request) { return parseCookies(req.headers.cookie)[trialCookie]; }
  function current(req: Request) {
    const workspace = workspaces.get(workspaceId(req));
    return workspace && workspace.expires > clock() ? workspace : undefined;
  }
  function freshWorkspace() {
    const dir = fs.mkdtempSync(path.join(root, 'trial-'));
    try { return { ...buildWorkspace(dir, true), dir }; }
    catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }
  const signature = (value: string) => createHmac('sha256', inviteKey!).update(value).digest('base64url');
  function verifyInvite(token: unknown) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{22}\.\d{1,12}\.[A-Za-z0-9_-]{43}$/.test(token)) return;
    const [invite, expiry, mac] = token.split('.');
    if (Number(expiry) <= clock() || !timingSafeEqual(Buffer.from(mac), Buffer.from(signature(`${invite}.${expiry}`)))) return;
    return { invite, expires: Number(expiry) };
  }
  const isOrganizer = (key: unknown) => typeof key === 'string' && !!organizerDigest && timingSafeEqual(digest(key), organizerDigest);
  const iso = (seconds?: number) => seconds === undefined ? null : new Date(seconds * 1000).toISOString();

  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, syntheticDemo: true, ...(inviteKey ? { guidedTrialAvailable: true } : {}) });
  });
  if (inviteKey && organizerDigest) {
    const trial = express.Router();
    const ended = { error: 'Your trial session ended. Reopen your invitation link to start again.' };
    trial.use((req, res, next) => {
      res.set('Cache-Control', 'no-store');
      const workspace = current(req);
      const entry = workspace && records.get(workspace.invite);
      if (entry) entry.lastActiveAt = clock();
      next();
    });
    trial.use(express.json({ limit: '4kb' }));
    trial.post('/links', (req, res) => {
      if (!isOrganizer(req.body?.key)) return res.status(403).json({ error: 'Check your organizer key and try again.' });
      const note = req.body?.note ?? '';
      if (typeof note !== 'string' || note.trim().length > 60)
        return res.status(400).json({ error: 'Keep the participant note to 60 characters or fewer.' });
      const expires = clock() + inviteLifetime;
      const invite = randomBytes(16).toString('base64url');
      const value = `${invite}.${expires}`;
      Object.assign(record(invite, expires), { createdAt: clock(), ...(note.trim() ? { note: note.trim() } : {}) });
      res.json({ path: `/#trial=${value}.${signature(value)}`, expiresAt: iso(expires) });
    });
    trial.post('/activity', (req, res) => {
      if (!isOrganizer(req.body?.key)) return res.status(403).json({ error: 'Check your organizer key and try again.' });
      sweep(); // record the final step count of trials that expired since the last cleanup
      const live = new Map([...workspaces.values()].map(w => [w.invite, w]));
      for (const workspace of live.values()) snapshot(workspace);
      res.json([...records].reverse().map(([invite, entry]) => ({
        id: invite.slice(0, 6), note: entry.note ?? null, createdAt: iso(entry.createdAt), expiresAt: iso(entry.expiresAt),
        openedAt: iso(entry.openedAt), lastActiveAt: iso(entry.lastActiveAt), active: live.has(invite),
        done: entry.done, total: entry.total, resets: entry.resets,
        feedback: entry.feedback ? { ...entry.feedback, at: iso(entry.feedback.at) } : null,
      })));
    });
    trial.post('/redeem', (req, res) => {
      const link = verifyInvite(req.body?.token);
      if (!link) return res.status(410).json({ error: 'This trial link is invalid or expired. Ask your organizer for a new link.' });
      const { invite } = link;
      sweep();
      const active = current(req);
      if (active?.invite === invite) {
        if (!active.auth.resolve(req)) active.auth.issueSession(res, active.auth.findById('enterprise')!);
        return res.json({ ok: true });
      }
      if (active) return res.status(409).json({ error: 'Sign out of your current trial before opening a new trial link.' });
      if ([...workspaces.values()].some(workspace => workspace.invite === invite))
        return res.status(409).json({ error: 'This trial is open in another browser. Use that browser or ask for a new link.' });
      if (workspaces.size >= maxWorkspaces)
        return res.status(503).json({ error: 'The trial is busy. Try again later.' });
      const id = randomBytes(32).toString('base64url');
      const workspace: Workspace = { ...freshWorkspace(), invite, expires: clock() + workspaceLifetime, uploads: 0, hrChecked: false };
      workspaces.set(id, workspace);
      const entry = record(invite, link.expires);
      entry.openedAt ??= clock();
      entry.lastActiveAt = clock();
      workspace.auth.issueSession(res, workspace.auth.findById('enterprise')!);
      res.cookie(trialCookie, id, { ...cookieOptions, maxAge: workspaceLifetime * 1000 });
      res.json({ ok: true });
    });
    trial.post('/role', (req, res) => {
      const workspace = current(req);
      if (!workspace?.auth.resolve(req)) return res.status(401).json(ended);
      const role = req.body?.role;
      if (!roles.has(role)) return res.status(400).json({ error: 'Choose HR, Attorney or Employee.' });
      workspace.auth.issueSession(res, workspace.auth.findById(role)!);
      res.json({ ok: true });
    });
    trial.get('/progress', (req, res) => {
      const workspace = current(req);
      if (!workspace?.auth.resolve(req)) return res.status(401).json(ended);
      const entry = records.get(workspace.invite);
      res.json({ ...progressOf(workspace), expiresAt: iso(workspace.expires), ...(entry?.feedback ? { feedbackSent: true } : {}) });
    });
    // Start the same trial over: a new, empty workspace replaces the current one in place. The
    // session limit and upload allowance carry over, so a reset never extends the trial.
    trial.post('/reset', (req, res) => {
      const workspace = current(req);
      if (!workspace?.auth.resolve(req)) return res.status(401).json(ended);
      const replacement: Workspace = { ...freshWorkspace(), invite: workspace.invite, expires: workspace.expires,
        uploads: workspace.uploads, hrChecked: false };
      workspaces.set(workspaceId(req), replacement);
      discard(workspace);
      const entry = records.get(workspace.invite);
      if (entry) entry.resets++;
      replacement.auth.issueSession(res, replacement.auth.findById('enterprise')!);
      res.json({ ok: true });
    });
    trial.post('/feedback', (req, res) => {
      const workspace = current(req);
      if (!workspace?.auth.resolve(req)) return res.status(401).json(ended);
      const { ease, stuck, comment = '' } = req.body ?? {};
      const steps = progressOf(workspace).steps.map(step => step.id);
      if (!Number.isInteger(ease) || ease < 1 || ease > 5 || (stuck !== 'none' && !steps.includes(stuck)) ||
          typeof comment !== 'string' || comment.trim().length > 1000)
        return res.status(400).json({ error: 'Choose a rating and a step, and keep comments to 1,000 characters.' });
      record(workspace.invite, workspace.expires).feedback = { ease, stuck, comment: comment.trim(), at: clock() };
      res.json({ ok: true });
    });
    app.use('/trial', trial);
  }
  app.use((req, res, next) => {
    const workspace = current(req);
    if (!workspace) return legacy.app(req, res, next);
    const entry = records.get(workspace.invite);
    if (entry) entry.lastActiveAt = clock();
    if (req.method === 'POST' && req.path === '/auth/logout') {
      workspace.auth.clearSession(req, res);
      workspace.expires = clock();
      sweep();
      res.clearCookie(trialCookie, cookieOptions);
      return res.json({ ok: true });
    }
    if (req.method === 'POST' && req.path === '/auth/login') return res.status(409).json({ error: 'Sign out of your current trial first.' });
    if (!workspace.hrChecked && req.method === 'GET' && req.path === '/api/enterprise/requests' &&
        workspace.auth.resolve(req)?.role === 'enterprise' &&
        progressOf(workspace).steps.every(item => item.done || item.id === 'hr_progress')) workspace.hrChecked = true;
    if (req.method === 'POST' && /^\/api\/draft-matters\/[^/]+\/intake\/materials\/?$/i.test(req.path) && workspace.auth.resolve(req)) {
      if (workspace.uploads >= 20) return res.status(409).json({ error: 'This trial has reached its upload limit.' });
      workspace.uploads++;
    }
    return workspace.app(req, res, next);
  });
  app.use((error: { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    console.error('[pilot] trial request failed');
    res.status(500).json({ error: 'The trial is unavailable. Try again later.' });
  });
  const cleanup = setInterval(() => {
    try { sweep(); } catch { console.error('[pilot] trial cleanup failed'); }
  }, 60_000).unref();
  return { app, stopCleanup: () => clearInterval(cleanup) };
}

function seedDemo(register: DraftRegister, consent: NonNullable<ReturnType<typeof loadConsentDocument>>) {
  const pending = register.submit('lawyer', 'HR-DEMO-101', {
    by: 'enterprise', email: 'employee2@preview.example.test', summary: 'Fictional request awaiting law firm review.',
  });
  const submitted = register.submit('lawyer', 'HR-DEMO-102', {
    by: 'enterprise', email: demoEmployee, summary: 'Fictional intake already submitted for review.',
  });
  if (typeof pending === 'string' || typeof submitted === 'string') throw new Error('Could not initialize demo cases');
  register.decide('lawyer', submitted.id, 'accepted');
  register.invite('lawyer', submitted.id, 'employee');
  register.accept('lawyer', submitted.id, 'employee');
  const store = register.intakeStore(submitted);
  const time = new Date().toISOString();
  const id = randomUUID();
  const bytes = Buffer.from('Fictional supporting exhibit for the MeritX online trial.');
  store.putBlob(id, bytes);
  store.update(state => {
    state.consent = { accountId: 'employee', signedAt: time, version: consent.version, digest: consent.digest };
    state.questionnaire = { ownerId: 'employee', answers: { notes: 'Fictional applicant is organizing sample evidence.' }, updatedAt: time, submittedAt: time };
    state.materials.push({ id, ownerId: 'employee', filename: 'sample-exhibit.txt', mimeType: 'text/plain', size: bytes.length, category: null, uploadedAt: time });
    state.playbook = { id: 'eb1a_v1', scenario: 'I140_Only' };
  });
}
