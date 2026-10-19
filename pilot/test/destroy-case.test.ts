import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { destroyCase, DestroyRefused, DESTROY_CONFIRM_PHRASE } from '../src/destroyCase';
import { EncryptedFileStore } from '../src/store';
import { AccessLog } from '../src/accessLog';
import { Cipher } from '../src/crypto';

const KEY = Buffer.alloc(32, 7).toString('base64'); // test-only constant key

function seed(status: 'closed' | 'in_review' = 'closed') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-destroy-'));
  const dataDir = path.join(root, 'data');
  const cipher = new Cipher(KEY);
  const store = new EncryptedFileStore(dataDir, cipher);
  store.putBlob('11111111-1111-1111-1111-111111111111', Buffer.from('synthetic blob 1'));
  store.putBlob('22222222-2222-2222-2222-222222222222', Buffer.from('synthetic blob 2'));
  store.update(s => { s.case.status = status; });
  new AccessLog(dataDir, cipher).append({ actor: 'lawyer', role: 'lawyer', action: 'case.close', outcome: 'ok' });
  fs.writeFileSync(path.join(dataDir, 'unrelated-notes.md'), 'not a case artefact');
  const keyFile = path.join(root, 'pilot.key');
  fs.writeFileSync(keyFile, KEY);
  return { root, dataDir, keyFile };
}

test('dry run (default) lists every artefact and deletes nothing', () => {
  const { dataDir, keyFile } = seed();
  const before = fs.readdirSync(dataDir).length;
  const r = destroyCase({ dataDir, encryptionKey: KEY, keyFile });
  assert.equal(r.dryRun, true); assert.equal(r.deleted, 0); assert.equal(r.caseStatus, 'closed');
  assert.deepEqual(r.files.filter(f => !f.startsWith('/')), ['access.log.enc', 'blobs/11111111-1111-1111-1111-111111111111', 'blobs/22222222-2222-2222-2222-222222222222', 'state.enc']);
  assert.ok(r.files.includes(keyFile));
  assert.equal(fs.readdirSync(dataDir).length, before);
  assert.ok(fs.existsSync(keyFile));
});

test('execute deletes encrypted state, blobs, access log and key file; keeps unrelated files', () => {
  const { dataDir, keyFile } = seed();
  const r = destroyCase({ dataDir, encryptionKey: KEY, keyFile, dryRun: false, confirm: DESTROY_CONFIRM_PHRASE });
  assert.equal(r.deleted, 4); assert.equal(r.keyFileDeleted, true);
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
  assert.equal(r.caseStatus, 'unknown'); assert.equal(r.deleted, 4);
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
