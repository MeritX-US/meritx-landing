import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, agents, LAWYER_NAME } from './helpers';

async function setup(flag?: string) {
  const { app } = makeApp(flag === undefined ? {} : { LAWYER_APPROVED_PUBLISH: flag });
  const a = await agents(app);
  await a.lawyer.put('/api/assessment').send({ text: 'SYNTHETIC assessment text', source: 'ai' });
  return a;
}

test('flag OFF (default): employee never sees assessment, even after lawyer approval', async () => {
  const a = await setup();
  assert.equal((await a.lawyer.post('/api/assessment/approve')).body.visibleToEmployee, false);
  assert.equal((await a.employee.get('/api/assessment')).status, 404);
  assert.equal((await a.employee.get('/api/case')).body.assessment, null);
});

test('flag ON: hidden until lawyer approves', async () => {
  const a = await setup('true');
  assert.equal((await a.employee.get('/api/assessment')).status, 404);
  assert.equal((await a.employee.get('/api/case')).body.assessment, null);
});

test("flag ON + approved: visible to employee under the lawyer's name", async () => {
  const a = await setup('true');
  await a.lawyer.post('/api/assessment/approve');
  const r = await a.employee.get('/api/assessment');
  assert.equal(r.status, 200);
  assert.equal(r.body.text, 'SYNTHETIC assessment text');
  assert.equal(r.body.approvedBy, LAWYER_NAME);
  assert.ok(r.body.label.includes(LAWYER_NAME));
  assert.equal(r.body.source, undefined, 'employee view must not expose AI/lawyer source internals');
  assert.equal((await a.employee.get('/api/case')).body.assessment.approvedBy, LAWYER_NAME);
});

test('flag ON: editing the text or revoking hides it again', async () => {
  const a = await setup('true');
  await a.lawyer.post('/api/assessment/approve');
  await a.lawyer.put('/api/assessment').send({ text: 'edited synthetic text' });
  assert.equal((await a.employee.get('/api/assessment')).status, 404);
  await a.lawyer.post('/api/assessment/approve');
  assert.equal((await a.employee.get('/api/assessment')).status, 200);
  await a.lawyer.post('/api/assessment/revoke');
  assert.equal((await a.employee.get('/api/assessment')).status, 404);
});

test('flag ON + approved: enterprise and admin still cannot see it', async () => {
  const a = await setup('true');
  await a.lawyer.post('/api/assessment/approve');
  assert.equal((await a.enterprise.get('/api/assessment')).status, 403);
  assert.equal((await a.admin.get('/api/assessment')).status, 403);
  assert.equal((await a.enterprise.get('/api/case')).body.assessment, undefined);
});
