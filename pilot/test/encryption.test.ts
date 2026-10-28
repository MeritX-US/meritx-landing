import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { Cipher } from '../src/crypto';
import { EncryptedFileStore } from '../src/store';
import { loadConfig } from '../src/config';
import { makeApp, agents, testEnv } from './helpers';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER = Buffer.alloc(32, 9).toString('base64');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

test('cipher round-trips and rejects wrong key, wrong AAD, tampering', () => {
  const c = new Cipher(KEY);
  const ct = c.encrypt(Buffer.from('synthetic secret'), 'blob:a');
  assert.equal(c.decrypt(ct, 'blob:a').toString(), 'synthetic secret');
  assert.throws(() => new Cipher(OTHER).decrypt(ct, 'blob:a'));
  assert.throws(() => c.decrypt(ct, 'blob:b'), 'ciphertext must be bound to its record id');
  const t = Buffer.from(ct); t[t.length - 1] ^= 1;
  assert.throws(() => c.decrypt(t, 'blob:a'));
  assert.throws(() => new Cipher('too-short'));
  assert.notDeepEqual(c.encrypt(Buffer.from('x'), 'a'), c.encrypt(Buffer.from('x'), 'a'), 'fresh IV per write');
});

test('nothing readable on disk: state, uploaded files and access log are ciphertext', async () => {
  const { app, cfg } = makeApp({ PILOT_QUESTIONNAIRE_FILE: '' });
  const a = await agents(app);
  await a.employee.post('/api/consent').send({ agree: true });
  await a.employee.put('/api/questionnaire').send({ answers: { notes: 'SYNTHETIC-ANSWER-MARKER' } });
  await a.employee.post('/api/materials').attach('file', Buffer.from('SYNTHETIC-FILE-MARKER plain text'), { filename: 'SYNTHETIC-NAME-MARKER.txt', contentType: 'text/plain' });
  const files = walk(cfg.dataDir);
  assert.ok(files.length >= 3);
  for (const f of files) {
    const raw = fs.readFileSync(f).toString('latin1');
    for (const marker of ['SYNTHETIC-ANSWER-MARKER', 'SYNTHETIC-FILE-MARKER', 'SYNTHETIC-NAME-MARKER', '"role"', 'login.success']) {
      assert.ok(!raw.includes(marker), `${path.basename(f)} contains plaintext ${marker}`);
    }
  }
  assert.ok(!files.some(f => f.endsWith('state.json')));
  // and the lawyer can still read it back through the API
  const q = await a.lawyer.get('/api/questionnaire');
  assert.equal(q.body.answers.notes, 'SYNTHETIC-ANSWER-MARKER');
  assert.ok((await a.lawyer.get('/api/access-log')).body.length > 0);
});

test('store refuses to start with the wrong key (fail fast) or with leftover plaintext', () => {
  const env = testEnv();
  const cfg = loadConfig(env);
  new EncryptedFileStore(cfg.dataDir, new Cipher(KEY));
  assert.throws(() => new EncryptedFileStore(cfg.dataDir, new Cipher(OTHER)));
  const env2 = testEnv();
  fs.writeFileSync(path.join(env2.PILOT_DATA_DIR!, 'state.json'), '{}');
  assert.throws(() => new EncryptedFileStore(env2.PILOT_DATA_DIR!, new Cipher(KEY)), /plaintext/);
});

test('config requires encryption key and a separate download secret', () => {
  assert.throws(() => loadConfig(testEnv({ PILOT_ENCRYPTION_KEY: '' })), /PILOT_ENCRYPTION_KEY/);
  assert.throws(() => loadConfig(testEnv({ PILOT_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })), /32/);
  assert.throws(() => loadConfig(testEnv({ DOWNLOAD_URL_SECRET: '' })), /DOWNLOAD_URL_SECRET/);
  assert.throws(() => loadConfig(testEnv({ DOWNLOAD_URL_SECRET: 'test-only-session-secret-0123456789abcdef' })), /differ/);
  assert.throws(() => loadConfig(testEnv({ DOWNLOAD_URL_TTL_SECONDS: '3600' })), /TTL/);
});
