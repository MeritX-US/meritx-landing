import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { destroyCase, DestroyRefused, DESTROY_CONFIRM_PHRASE, parseVendorRetention } from '../src/destroyCase';
import { makeDestroyFixture } from './fixtures/make-destroy-fixture';

const KEY = Buffer.alloc(32, 7).toString('base64'); // test-only constant key

function seed(status: 'closed' | 'in_review' = 'closed') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-destroy-'));
  const dataDir = path.join(root, 'data');
  makeDestroyFixture(dataDir, KEY, status);
  const keyFile = path.join(root, 'pilot.key');
  fs.writeFileSync(keyFile, KEY);
  return { root, dataDir, keyFile };
}
const ARTEFACTS = ['access.log.enc', 'anchor-email.state.json', 'blobs/11111111-1111-1111-1111-111111111111', 'blobs/22222222-2222-2222-2222-222222222222', 'state.enc'];
const ACKS = { ackSnapshotsDeleted: true, aiVendorRetention: [parseVendorRetention('gemini=30')] };

test('dry run (default) lists every artefact and deletes nothing', () => {
  const { dataDir, keyFile } = seed();
  const before = fs.readdirSync(dataDir).length;
  const r = destroyCase({ dataDir, encryptionKey: KEY, keyFile });
  assert.equal(r.dryRun, true); assert.equal(r.deleted, 0); assert.equal(r.caseStatus, 'closed');
  assert.deepEqual(r.files.filter(f => !f.startsWith('/')), ARTEFACTS);
  assert.ok(r.files.includes(keyFile));
  assert.equal(fs.readdirSync(dataDir).length, before);
  assert.ok(fs.existsSync(keyFile));
});

test('execute deletes encrypted state, blobs, access log and key file; keeps unrelated files', () => {
  const { dataDir, keyFile } = seed();
  const r = destroyCase({ dataDir, encryptionKey: KEY, keyFile, dryRun: false, confirm: DESTROY_CONFIRM_PHRASE });
  assert.equal(r.deleted, 5); assert.equal(r.keyFileDeleted, true);
  assert.deepEqual(fs.readdirSync(dataDir), ['unrelated-notes.md']);
  assert.equal(fs.existsSync(keyFile), false);
});

test('refuses without the exact confirm phrase', () => {
  const { dataDir } = seed();
  assert.throws(() => destroyCase({ dataDir, encryptionKey: KEY, dryRun: false }), DestroyRefused);
  assert.throws(() => destroyCase({ dataDir, encryptionKey: KEY, dryRun: false, confirm: 'yes' }), DestroyRefused);
  assert.ok(fs.existsSync(path.join(dataDir, 'state.enc')));
});

test('refuses when the case is not closed, even with --force', () => {
  const { dataDir } = seed('in_review');
  assert.throws(() => destroyCase({ dataDir, encryptionKey: KEY, dryRun: false, confirm: DESTROY_CONFIRM_PHRASE, force: true }), /not "closed"/);
  assert.ok(fs.existsSync(path.join(dataDir, 'state.enc')));
});

test('unknown status (no/wrong key) needs --force', () => {
  const { dataDir } = seed();
  const wrong = Buffer.alloc(32, 9).toString('base64');
  assert.throws(() => destroyCase({ dataDir, encryptionKey: wrong, dryRun: false, confirm: DESTROY_CONFIRM_PHRASE }), /--force/);
  const r = destroyCase({ dataDir, dryRun: false, confirm: DESTROY_CONFIRM_PHRASE, force: true });
  assert.equal(r.caseStatus, 'unknown'); assert.equal(r.deleted, 5);
});

test('never follows symlinks out of the data dir', () => {
  const { root, dataDir } = seed();
  const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(dataDir, 'blobs', '33333333-3333-3333-3333-333333333333'));
  const r = destroyCase({ dataDir, encryptionKey: KEY, dryRun: false, confirm: DESTROY_CONFIRM_PHRASE });
  assert.ok(!r.files.some(f => f.includes('3333')));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('CLI: dry run by default, exits 1 when refused', () => {
  const { dataDir } = seed();
  const tsx = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
  const script = path.join(__dirname, '..', 'src', 'scripts', 'destroy-case.ts');
  const env = { ...process.env, PILOT_ENCRYPTION_KEY: KEY };
  const out = JSON.parse(execFileSync(tsx, [script, '--data-dir', dataDir], { env, encoding: 'utf8' }));
  assert.equal(out.dryRun, true); assert.ok(fs.existsSync(path.join(dataDir, 'state.enc')));
  assert.throws(() => execFileSync(tsx, [script, '--data-dir', dataDir, '--execute'], { env, stdio: 'pipe' }), (e: any) => e.status === 1);
  assert.ok(fs.existsSync(path.join(dataDir, 'state.enc')));
});

// ---------- mandatory case-close checklist (manual confirmations) ----------

test('checklist: dry run lists both mandatory confirmations as pending and is never complete', () => {
  const { dataDir } = seed();
  const r = destroyCase({ dataDir, encryptionKey: KEY, ...ACKS });
  assert.deepEqual(r.checklist.map(c => [c.id, c.mandatory]), [['render_snapshots_deleted', true], ['ai_vendor_data_deleted', true]]);
  assert.equal(r.complete, false);
  assert.match(r.checklist[0].text, /snapshots and backups/);
  assert.match(r.checklist[1].text, /retention period/);
  const bare = destroyCase({ dataDir, encryptionKey: KEY });
  assert.deepEqual(bare.pendingConfirmations, ['render_snapshots_deleted', 'ai_vendor_data_deleted']);
});

test('checklist: execute without acks deletes data but is NOT complete', () => {
  const { dataDir } = seed();
  const r = destroyCase({ dataDir, encryptionKey: KEY, dryRun: false, confirm: DESTROY_CONFIRM_PHRASE });
  assert.equal(r.deleted, 5); assert.equal(r.complete, false);
  assert.deepEqual(r.pendingConfirmations, ['render_snapshots_deleted', 'ai_vendor_data_deleted']);
});

test('checklist: one ack alone is not enough', () => {
  const { dataDir } = seed();
  const r = destroyCase({ dataDir, encryptionKey: KEY, dryRun: false, confirm: DESTROY_CONFIRM_PHRASE, ackSnapshotsDeleted: true });
  assert.equal(r.complete, false); assert.deepEqual(r.pendingConfirmations, ['ai_vendor_data_deleted']);
});

test('checklist: both acks => complete, retention per vendor recorded (days or zero retention)', () => {
  const { dataDir } = seed();
  const r = destroyCase({ dataDir, encryptionKey: KEY, dryRun: false, confirm: DESTROY_CONFIRM_PHRASE,
    ackSnapshotsDeleted: true, aiVendorRetention: ['gemini=30', 'openai=zero'].map(parseVendorRetention) });
  assert.equal(r.complete, true); assert.deepEqual(r.pendingConfirmations, []);
  assert.deepEqual(r.checklist[1].vendors, [{ vendor: 'gemini', retention: '30 days' }, { vendor: 'openai', retention: 'zero retention' }]);
});

test('checklist: vendor retention must be days or zero', () => {
  assert.deepEqual(parseVendorRetention('Gemini=30'), { vendor: 'gemini', retentionDays: 30 });
  assert.deepEqual(parseVendorRetention('none=zero'), { vendor: 'none', retentionDays: null });
  assert.deepEqual(parseVendorRetention('anthropic=zero retention'), { vendor: 'anthropic', retentionDays: null });
  for (const bad of ['gemini', 'gemini=', 'gemini=soon', 'gemini=-1', 'gemini=99999', '=30', 'none=30']) {
    assert.throws(() => parseVendorRetention(bad), DestroyRefused, bad);
  }
});

test('CLI: execute without acks exits 3; ack run on the emptied dir exits 0 and writes the report file', () => {
  const { root, dataDir } = seed();
  const tsx = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
  const script = path.join(__dirname, '..', 'src', 'scripts', 'destroy-case.ts');
  const env = { ...process.env, PILOT_ENCRYPTION_KEY: KEY };
  assert.throws(() => execFileSync(tsx, [script, '--data-dir', dataDir, '--execute', '--confirm', DESTROY_CONFIRM_PHRASE], { env, stdio: 'pipe' }),
    (e: any) => e.status === 3 && /NOT complete/.test(String(e.stderr)));
  assert.deepEqual(fs.readdirSync(dataDir), ['unrelated-notes.md']);
  const report = path.join(root, 'report.json');
  const out = execFileSync(tsx, [script, '--data-dir', dataDir, '--execute', '--confirm', DESTROY_CONFIRM_PHRASE, '--force',
    '--ack-render-snapshots-deleted', '--ack-ai-vendor-data', 'gemini=30', '--ack-ai-vendor-data', 'openai=zero', '--report-file', report], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(out).complete, true);
  const rec = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(rec.complete, true);
  assert.deepEqual(rec.checklist[1].vendors.map((v: any) => v.retention), ['30 days', 'zero retention']);
  assert.throws(() => execFileSync(tsx, [script, '--data-dir', dataDir, '--ack-ai-vendor-data', 'gemini=later'], { env, stdio: 'pipe' }), (e: any) => e.status === 1);
});
