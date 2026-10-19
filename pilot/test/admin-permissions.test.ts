import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, agents, accountsJson, admin2Account, EMAIL_ADMIN2, PW_ADMIN2 } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n% synthetic\n');

async function seeded() {
  const env = { PILOT_ACCOUNTS: JSON.stringify([...JSON.parse(accountsJson()), admin2Account()]), PILOT_MAX_ACCOUNTS: '5', LAWYER_APPROVED_PUBLISH: 'true', PILOT_QUESTIONNAIRE_FILE: '' };
  const { app } = makeApp(env);
  const a = await agents(app);
  const admin2 = request.agent(app);
  assert.equal((await admin2.post('/auth/login').send({ email: EMAIL_ADMIN2, password: PW_ADMIN2 })).status, 200);
  await a.employee.post('/api/consent').send({ agree: true });
  await a.employee.put('/api/questionnaire').send({ answers: { notes: 'SYNTHETIC-ANSWER' }, submit: true });
  const emp = (await a.employee.post('/api/materials').attach('file', PDF, { filename: 'emp.pdf', contentType: 'application/pdf' })).body.id;
  const law = (await a.lawyer.post('/api/materials').attach('file', PDF, { filename: 'law.pdf', contentType: 'application/pdf' })).body.id;
  await a.lawyer.put('/api/assessment').send({ text: 'SYNTHETIC-ASSESSMENT' });
  await a.lawyer.post('/api/assessment/approve');
  return { app, a, admins: [a.admin, admin2], emp, law };
}

test('5-account pilot (PILOT_MAX_ACCOUNTS=5, 2 admins): BOTH admins are blocked from all materials, questionnaire and assessment', async () => {
  const { admins, emp, law } = await seeded();
  for (const adm of admins) {
    const denied: [string, string][] = [
      ['get', '/api/materials'],
      ['get', `/api/materials/${emp}/download`], ['post', `/api/materials/${emp}/download-url`],
      ['get', `/api/materials/${law}/download`], ['post', `/api/materials/${law}/download-url`],
      ['get', '/api/questionnaire'], ['put', '/api/questionnaire'],
      ['get', '/api/assessment'], ['put', '/api/assessment'], ['post', '/api/assessment/approve'],
      ['post', '/api/materials'], ['delete', `/api/materials/${emp}`], ['put', `/api/materials/${emp}/category`],
      ['put', '/api/case/status'], ['put', '/api/case/visa-type'], ['post', '/api/todos'],
    ];
    for (const [m, p] of denied) {
      const r = await (adm as any)[m](p).send({});
      assert.ok([403, 404].includes(r.status), `admin ${m.toUpperCase()} ${p} => ${r.status}`);
      assert.ok(!JSON.stringify(r.body || {}).includes('SYNTHETIC'), `admin ${p} leaked content`);
    }
    const c = await adm.get('/api/case');
    assert.deepEqual(Object.keys(c.body).sort(), ['role', 'status', 'updatedAt']);
    assert.ok(!JSON.stringify(c.body).includes('SYNTHETIC'));
  }
});

test('admin can only do account management, status and access log', async () => {
  const { a, admins } = await seeded();
  for (const adm of admins) {
    const acc = await adm.get('/api/accounts');
    assert.equal(acc.status, 200);
    assert.equal(acc.body.accounts.length, 5);
    assert.ok(acc.body.accounts.every((x: any) => x.passwordHash === undefined), 'never expose hashes');
    assert.equal((await adm.get('/api/case/status')).status, 200);
    const log = await adm.get('/api/access-log');
    assert.equal(log.status, 200);
    assert.ok(!JSON.stringify(log.body).includes('SYNTHETIC'));
  }
  for (const r of ['employee', 'lawyer', 'enterprise'] as const) {
    assert.equal((await a[r].get('/api/accounts')).status, 403, `${r} must not manage accounts`);
  }
});

test('only the lawyer sees all materials', async () => {
  const { a, admins, emp, law } = await seeded();
  const lawyerIds = new Set((await a.lawyer.get('/api/materials')).body.map((m: any) => m.id));
  assert.deepEqual(lawyerIds, new Set([emp, law]));
  assert.deepEqual((await a.employee.get('/api/materials')).body.map((m: any) => m.id), [emp], 'employee: own only');
  assert.equal((await a.enterprise.get('/api/materials')).status, 403);
  for (const adm of admins) assert.equal((await adm.get('/api/materials')).status, 403);
  assert.equal((await a.lawyer.get('/api/case')).body.materials.length, 2);
  for (const r of [a.employee, a.enterprise, ...admins]) {
    const n = ((await r.get('/api/case')).body.materials || []).length;
    assert.ok(n <= 1);
  }
});

test('admin cannot use a signed download URL issued to the lawyer or employee', async () => {
  const { a, admins, emp } = await seeded();
  for (const owner of [a.lawyer, a.employee]) {
    const url = (await owner.post(`/api/materials/${emp}/download-url`)).body.url;
    assert.ok(url);
    for (const adm of admins) assert.equal((await adm.get(url)).status, 403);
  }
});
