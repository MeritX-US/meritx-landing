import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from './app';
import { hashPassword } from './auth';
import { loadConfig } from './config';
import { loadConsentDocument } from './consent';
import { DraftRegister } from './draftRegister';

const password = process.env.PILOT_DEMO_PASSWORD?.trim();
if (!password || Buffer.byteLength(password) < 32) throw new Error('Set a random PILOT_DEMO_PASSWORD of at least 32 bytes');

// Reinitialize only this isolated temp directory on a new demo process. The
// password remains stable in the hosting environment and sessions start fresh.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meritx-synthetic-'));
const secret = () => randomBytes(32).toString('base64');
const hash = hashPassword(password);
const accounts = [
  ['employee', 'employee', 'Demo Employee'],
  ['employee2', 'employee', 'Demo Employee 2'],
  ['lawyer', 'lawyer', 'Demo Lawyer'],
  ['enterprise', 'enterprise', 'Demo HR'],
  ['admin', 'admin', 'Demo Admin'],
].map(([id, role, name]) => ({ id, role, name, email: id + '@preview.example.test', passwordHash: hash }));

const cfg = loadConfig({
  PRIVATE_MODE: 'true', NODE_ENV: 'production', AI_PROVIDER: 'none',
  SESSION_SECRET: secret(), DOWNLOAD_URL_SECRET: secret(), PILOT_ENCRYPTION_KEY: secret(),
  PILOT_DATA_DIR: path.join(root, 'original'), PILOT_DRAFT_REGISTER_DIR: path.join(root, 'register'),
  PILOT_DRAFT_REGISTER_KEY: secret(), PILOT_MAX_ACCOUNTS: '5', PILOT_PRIMARY_EMPLOYEE_ID: 'employee',
  PILOT_ACCOUNTS: JSON.stringify(accounts), MAX_UPLOAD_BYTES: String(5 * 1024 * 1024),
});
const consent = loadConsentDocument({ NODE_ENV: 'development' })!;
cfg.consentDocument = consent;
cfg.syntheticDemo = true;

const register = new DraftRegister(cfg.draftRegister!.dir, cfg.draftRegister!.key);
const pending = register.submit('lawyer', 'HR-DEMO-101', {
  by: 'enterprise', email: 'employee2@preview.example.test', summary: 'Fictional request awaiting law firm review.',
});
const submitted = register.submit('lawyer', 'HR-DEMO-102', {
  by: 'enterprise', email: 'employee@preview.example.test', summary: 'Fictional intake already submitted for review.',
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
  state.materials.push({ id, ownerId: 'employee', filename: 'sample-exhibit.txt', mimeType: 'text/plain', size: bytes.length, uploadedAt: time, category: null });
  state.playbook = { id: 'eb1a_v1', scenario: 'I140_Only' };
});
createApp(cfg).listen(Number(process.env.PORT || 3101), () => console.log('[pilot] synthetic demo listening'));
