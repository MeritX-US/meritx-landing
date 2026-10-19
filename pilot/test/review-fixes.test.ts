import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { makeApp, loginAs, EMAIL, PW } from './helpers';
import { Auth, ConcurrencyLimiter, verifyPassword, hashPassword, parseCookies } from '../src/auth';
import { detectFileType } from '../src/fileType';

// ---------- 1. login: per-email exponential backoff, async scrypt, concurrency cap ----------
test('backoff delay doubles per failure: 1s, 2s, 4s, 8s ...', () => {
  assert.equal(Auth.backoffDelayMs(0), 0);
  assert.deepEqual([1, 2, 3, 4, 5].map(Auth.backoffDelayMs), [1000, 2000, 4000, 8000, 16000]);
});

test('backoff delay is capped at 15 minutes', () => {
  assert.equal(Auth.backoffDelayMs(11), 15 * 60 * 1000); // 1024s would exceed 900s
  assert.equal(Auth.backoffDelayMs(1000), 15 * 60 * 1000);
});

test('per-email backoff grows with failures and expires (not a hard lock)', () => {
  const { cfg } = makeApp();
  const a = new Auth(cfg);
  let t = 1_000_000; a.now = () => t;
  const e = EMAIL.employee;
  a.recordEmailFailure(e); assert.equal(a.emailBackoffRemainingMs(e), 1000);
  a.recordEmailFailure(e); assert.equal(a.emailBackoffRemainingMs(e), 2000);
  a.recordEmailFailure(e); assert.equal(a.emailBackoffRemainingMs(e), 4000);
  t += 4000; assert.equal(a.emailBackoffRemainingMs(e), 0, 'can try again after the delay');
  for (let i = 0; i < 20; i++) a.recordEmailFailure(e);
  assert.equal(a.emailBackoffRemainingMs(e), 15 * 60 * 1000);
  t += 15 * 60 * 1000; assert.equal(a.emailBackoffRemainingMs(e), 0, 'cap is a wait, never permanent');
});

test('per-email backoff returns 429 + Retry-After and resets after a successful login', async () => {
  let t = 5_000_000;
  const { app: app2 } = makeApp({}, { auth: (a: Auth) => { a.now = () => t; } });
  const bad = await request(app2).post('/auth/login').send({ email: EMAIL.lawyer, password: 'wrong-wrong-wrong' });
  assert.equal(bad.status, 401);
  const blocked = await request(app2).post('/auth/login').send({ email: EMAIL.lawyer, password: PW.lawyer });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '1');
  t += 1000;
  const ok = await request(app2).post('/auth/login').send({ email: EMAIL.lawyer, password: PW.lawyer });
  assert.equal(ok.status, 200, 'allowed once the delay has passed');
  // success cleared the backoff: next failure starts at 1s again
  assert.equal((await request(app2).post('/auth/login').send({ email: EMAIL.lawyer, password: 'nope-nope-nope' })).status, 401);
  const r = await request(app2).post('/auth/login').send({ email: EMAIL.lawyer, password: PW.lawyer });
  assert.equal(r.status, 429); assert.equal(r.headers['retry-after'], '1');
});

test('admin manual unlock resets backoff and is written to the access log', async () => {
  let t = 9_000_000; let A!: Auth;
  const { app } = makeApp({}, { auth: (a: Auth) => { A = a; a.now = () => t; } });
  for (let i = 0; i < 6; i++) {
    assert.equal((await request(app).post('/auth/login').send({ email: EMAIL.employee, password: 'bad-bad-bad-bad' })).status, i < 5 ? 401 : 429);
    t += Auth.backoffDelayMs(i + 1);
  }
  // IP+email lock (5 failures) is active; admin unlock must clear it and the backoff
  assert.equal((await request(app).post('/auth/login').send({ email: EMAIL.employee, password: PW.employee })).status, 429);
  const admin = await loginAs(app, 'admin');
  assert.equal((await (await loginAs(app, 'lawyer')).post('/api/accounts/unlock').send({ email: EMAIL.employee })).status, 403, 'only admins');
  assert.equal(A.emailFailureCount(EMAIL.employee), 5);
  assert.equal((await admin.post('/api/accounts/unlock').send({ email: EMAIL.employee })).status, 200);
  assert.equal(A.emailFailureCount(EMAIL.employee), 0, 'backoff reset');
  assert.equal((await request(app).post('/auth/login').send({ email: EMAIL.employee, password: PW.employee })).status, 200);
  const log = (await admin.get('/api/access-log')).body;
  const entry = log.find((e: any) => e.action === 'login.unlock');
  assert.ok(entry, 'unlock logged');
  assert.equal(entry.actor, 'admin'); assert.equal(entry.resource, 'employee');
  assert.ok(!JSON.stringify(log).includes(EMAIL.employee), 'log never contains the email');
});

test('password verification is async (does not block the event loop)', async () => {
  const h = hashPassword('synthetic-pw-123456');
  let ticked = false;
  const p = verifyPassword('synthetic-pw-123456', h);
  assert.ok(p instanceof Promise);
  setImmediate(() => { ticked = true; });
  assert.equal(await p, true);
  assert.equal(ticked, true, 'event loop ran while scrypt was in progress');
  assert.equal(await verifyPassword('wrong', h), false);
});

test('concurrency limiter caps active work and rejects beyond the queue', async () => {
  const l = new ConcurrencyLimiter(2, 1);
  let active = 0, peak = 0;
  const job = () => l.run(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 20)); active--; return 'done'; });
  const results = await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(peak, 2);
  assert.equal(results.filter(r => r === 'done').length, 3);
  assert.equal(results.filter(r => r === ConcurrencyLimiter.BUSY).length, 2);
});

// ---------- 2. malformed cookie => 401, not 500 ----------
test('malformed cookie encoding returns 401, not 500', async () => {
  const { app } = makeApp();
  for (const c of ['mx_pilot_session=%E0%A4%A', 'mx_pilot_session=%', 'mx_pilot_session=abc.%ZZ', '__Host-mx_pilot_session=%C0']) {
    const r = await request(app).get('/api/me').set('Cookie', c);
    assert.equal(r.status, 401, c);
  }
  assert.deepEqual(parseCookies('a=%E0%A4%A; b=ok'), { b: 'ok' });
  assert.equal((await request(app).post('/auth/logout').set('Cookie', 'mx_pilot_session=%')).status, 200);
});

// ---------- 3. revoked sessions persist across restart ----------
test('logged-out sessions stay revoked after a restart (persisted to the data store)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-pilot-restart-'));
  const { app } = makeApp({ PILOT_DATA_DIR: dir });
  const login = await request(app).post('/auth/login').send({ email: EMAIL.employee, password: PW.employee });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const other = String((await request(app).post('/auth/login').send({ email: EMAIL.lawyer, password: PW.lawyer })).headers['set-cookie']).split(';')[0];
  await request(app).post('/auth/logout').set('Cookie', cookie);
  const { app: restarted } = makeApp({ PILOT_DATA_DIR: dir });
  assert.equal((await request(restarted).get('/api/me').set('Cookie', cookie)).status, 401, 'still revoked after restart');
  assert.equal((await request(restarted).get('/api/me').set('Cookie', other)).status, 200, 'other sessions unaffected');
});

// ---------- 4. upload type decided by content ----------
const PDF = Buffer.from('%PDF-1.4\n% synthetic\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
function zip(name: string) {
  const n = Buffer.from(name);
  const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(n.length, 26);
  return Buffer.concat([h, n]);
}

test('detectFileType recognises allowed types by magic bytes only', () => {
  assert.equal(detectFileType(PDF), 'application/pdf');
  assert.equal(detectFileType(PNG), 'image/png');
  assert.equal(detectFileType(JPG), 'image/jpeg');
  assert.equal(detectFileType(zip('word/document.xml')), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(detectFileType(zip('evil.exe')), null);
  assert.equal(detectFileType(Buffer.from('plain synthetic notes\n')), 'text/plain');
  assert.equal(detectFileType(Buffer.from('<html><script>x</script>')), null);
  assert.equal(detectFileType(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), null); // MZ executable
  assert.equal(detectFileType(Buffer.alloc(0)), null);
});

test('upload ignores client MIME: spoofed type is rejected, real type is stored', async () => {
  const { app } = makeApp();
  const emp = await loginAs(app, 'employee');
  await emp.post('/api/consent').send({ agree: true });
  const exe = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(16)]);
  assert.equal((await emp.post('/api/materials').attach('file', exe, { filename: 'cv.pdf', contentType: 'application/pdf' })).status, 415);
  assert.equal((await emp.post('/api/materials').attach('file', Buffer.from('<html><script>1</script>'), { filename: 'a.txt', contentType: 'text/plain' })).status, 415);
  const ok = await emp.post('/api/materials').attach('file', PNG, { filename: 'scan.pdf', contentType: 'application/pdf' });
  assert.equal(ok.status, 201);
  const list = (await emp.get('/api/materials')).body;
  assert.equal(list.find((m: any) => m.id === ok.body.id).mimeType, 'image/png');
});
