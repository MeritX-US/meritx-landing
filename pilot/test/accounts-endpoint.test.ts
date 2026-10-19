import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, agents, accountsJson, admin2Account, EMAIL_ADMIN2, PW_ADMIN2, EMAIL, PW } from './helpers';
import { ACCOUNT_SUMMARY_KEYS } from '../src/app';

const EXPECTED_KEYS = ['enabled', 'id', 'name', 'role'];
const FORBIDDEN = /email|pass|hash|salt|token|reset|link|secret|note|client|company|case|visa|status|material|questionnaire|assessment/i;

async function setup(accounts = [...JSON.parse(accountsJson()), admin2Account()]) {
  const { app } = makeApp({ PILOT_ACCOUNTS: JSON.stringify(accounts), PILOT_MAX_ACCOUNTS: '5', PILOT_QUESTIONNAIRE_FILE: '' });
  return { app, a: await agents(app) };
}

test('GET /api/accounts returns exactly {accounts:[{id,name,role,enabled}]} and nothing else', async () => {
  const { a } = await setup();
  // put some case data in the system so a leak would be detectable
  await a.employee.post('/api/consent').send({ agree: true });
  await a.employee.put('/api/questionnaire').send({ answers: { notes: 'SYNTHETIC-CASE-NOTE' } });
  await a.lawyer.put('/api/case/visa-type').send({ visaType: 'SYNTHETIC-VISA' });
  await a.lawyer.put('/api/case/status').send({ status: 'in_review' });

  const r = await a.admin.get('/api/accounts');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['accounts'], 'top-level keys');
  assert.equal(r.body.accounts.length, 5);
  for (const acc of r.body.accounts) {
    assert.deepEqual(Object.keys(acc).sort(), EXPECTED_KEYS, `exact key set for ${acc.id}`);
    assert.equal(typeof acc.id, 'string'); assert.equal(typeof acc.name, 'string');
    assert.equal(typeof acc.role, 'string'); assert.equal(typeof acc.enabled, 'boolean');
    for (const k of Object.keys(acc)) assert.ok(!FORBIDDEN.test(k), `forbidden key ${k}`);
  }
  assert.deepEqual([...ACCOUNT_SUMMARY_KEYS].sort(), EXPECTED_KEYS);
  const raw = JSON.stringify(r.body);
  for (const leak of ['@', 'scrypt$', 'SYNTHETIC-CASE-NOTE', 'SYNTHETIC-VISA', 'in_review', 'token', 'reset', 'http']) {
    assert.ok(!raw.includes(leak), `response leaks ${leak}`);
  }
});

test('only admins can list accounts (both admins)', async () => {
  const { app, a } = await setup();
  const admin2 = request.agent(app);
  await admin2.post('/auth/login').send({ email: EMAIL_ADMIN2, password: PW_ADMIN2 });
  assert.equal((await admin2.get('/api/accounts')).status, 200);
  for (const r of ['employee', 'lawyer', 'enterprise'] as const) assert.equal((await a[r].get('/api/accounts')).status, 403);
  assert.equal((await request(app).get('/api/accounts')).status, 401);
});

test('enabled status: disabled account is listed as enabled=false and cannot log in', async () => {
  const accts = [...JSON.parse(accountsJson()), { ...admin2Account(), enabled: false }];
  const { app, a } = await setup(accts);
  const list = (await a.admin.get('/api/accounts')).body.accounts;
  assert.equal(list.find((x: any) => x.id === 'admin2').enabled, false);
  assert.equal(list.find((x: any) => x.id === 'lawyer').enabled, true);
  assert.equal((await request(app).post('/auth/login').send({ email: EMAIL_ADMIN2, password: PW_ADMIN2 })).status, 401);
  assert.equal((await request(app).post('/auth/login').send({ email: EMAIL.lawyer, password: PW.lawyer })).status, 200);
});
