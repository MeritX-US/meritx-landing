import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, loginAs, EMAIL, PW } from './helpers';
import { signToken } from '../src/auth';

// Every API route. Unauthenticated access to any of them must be rejected.
export const API_ROUTES: [string, string][] = [
  ['get', '/api/me'], ['get', '/api/case'], ['get', '/api/case/status'], ['put', '/api/case/status'],
  ['put', '/api/case/visa-type'], ['post', '/api/consent'], ['get', '/api/questionnaire'], ['put', '/api/questionnaire'],
  ['get', '/api/materials'], ['post', '/api/materials'], ['post', '/api/materials/00000000-0000-0000-0000-000000000000/download-url'], ['post', '/api/assessment/generate'],
  ['get', '/files/00000000-0000-0000-0000-000000000000?exp=9999999999&sig=x'],
  ['put', '/api/materials/00000000-0000-0000-0000-000000000000/category'], ['delete', '/api/materials/00000000-0000-0000-0000-000000000000'],
  ['post', '/api/todos'], ['put', '/api/todos/x/publish'], ['get', '/api/assessment'], ['put', '/api/assessment'],
  ['post', '/api/assessment/approve'], ['post', '/api/assessment/revoke'], ['get', '/api/access-log'],
  ['get', '/api/records'], ['get', '/api/anything-unknown'],
];

test('every /api route and /files rejects unauthenticated requests with 401', async () => {
  const { app } = makeApp();
  for (const [m, p] of API_ROUTES) {
    const r = await (request(app) as any)[m](p);
    assert.equal(r.status, 401, `${m.toUpperCase()} ${p} => ${r.status}`);
  }
});

test('login succeeds for allowlisted account and sets a hardened cookie', async () => {
  const { app } = makeApp();
  const r = await request(app).post('/auth/login').send({ email: EMAIL.lawyer, password: PW.lawyer });
  assert.equal(r.status, 200);
  const c = String(r.headers['set-cookie']);
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/);
  assert.equal(r.body.role, 'lawyer');
  assert.equal(r.body.passwordHash, undefined);
});

test('secure cookies in production use __Host- prefix and Secure', async () => {
  const { app } = makeApp({ NODE_ENV: 'production', TRUST_PROXY: 'false' });
  const r = await request(app).post('/auth/login').send({ email: EMAIL.lawyer, password: PW.lawyer });
  assert.match(String(r.headers['set-cookie']), /^__Host-mx_pilot_session=.*Secure/);
});

test('wrong password and unknown email return the same generic 401', async () => {
  const { app } = makeApp();
  const a = await request(app).post('/auth/login').send({ email: EMAIL.lawyer, password: 'wrong-password-xx' });
  const b = await request(app).post('/auth/login').send({ email: 'stranger@example.test', password: 'whatever-123456' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.body, b.body);
});

test('repeated failures lock out the email for the window', async () => {
  const { app } = makeApp();
  for (let i = 0; i < 5; i++) await request(app).post('/auth/login').send({ email: EMAIL.employee, password: 'nope-nope-nope' });
  const r = await request(app).post('/auth/login').send({ email: EMAIL.employee, password: PW.employee });
  assert.equal(r.status, 429);
});

test('there is no self-registration endpoint', async () => {
  const { app } = makeApp();
  for (const p of ['/auth/register', '/auth/signup', '/api/register', '/api/signup']) {
    const r = await request(app).post(p).send({ email: 'new@example.test', password: 'x'.repeat(20) });
    assert.ok([401, 404].includes(r.status), `${p} => ${r.status}`);
  }
});

test('forged, tampered and expired session tokens are rejected', async () => {
  const { app } = makeApp();
  const forged = signToken({ sub: 'lawyer', iat: 0, exp: 9999999999, nonce: 'n' }, Buffer.from('not-the-real-secret-not-the-real-secret'));
  let r = await request(app).get('/api/me').set('Cookie', `mx_pilot_session=${forged}`);
  assert.equal(r.status, 401);
  const realSecret = Buffer.from('test-only-session-secret-0123456789abcdef');
  const expired = signToken({ sub: 'lawyer', iat: 0, exp: 1, nonce: 'n' }, realSecret);
  r = await request(app).get('/api/me').set('Cookie', `mx_pilot_session=${expired}`);
  assert.equal(r.status, 401);
  const ghost = signToken({ sub: 'not-in-allowlist', iat: 0, exp: 9999999999, nonce: 'n' }, realSecret);
  r = await request(app).get('/api/me').set('Cookie', `mx_pilot_session=${ghost}`);
  assert.equal(r.status, 401);
});

test('logout revokes the session', async () => {
  const { app } = makeApp();
  const agent = await loginAs(app, 'employee');
  const login = await request(app).post('/auth/login').send({ email: EMAIL.employee, password: PW.employee });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  assert.equal((await request(app).get('/api/me').set('Cookie', cookie)).status, 200);
  await request(app).post('/auth/logout').set('Cookie', cookie);
  assert.equal((await request(app).get('/api/me').set('Cookie', cookie)).status, 401);
  assert.equal((await agent.get('/api/me')).status, 200); // other session unaffected
});
