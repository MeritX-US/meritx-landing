import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createDemoApp } from '../src/demoApp';

const password = 'synthetic test password for shared preview';
const organizerKey = 'different synthetic test organizer key';

function demo(t: TestContext, options: { organizerKey?: string; now?: () => number; secureCookies?: boolean } = { organizerKey }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-guided-trial-'));
  const { app, stopCleanup } = createDemoApp({ root, password, secureCookies: false, ...options });
  t.after(() => {
    stopCleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return app;
}

async function invitation(app: ReturnType<typeof demo>) {
  const { body } = await request(app).post('/trial/links').send({ key: organizerKey }).expect(200)
    .expect('Cache-Control', 'no-store');
  assert.match(body.path, /^\/#trial=/);
  return body.path.slice('/#trial='.length);
}

test('guided trial runs HR, attorney and employee handoffs without sharing case state with other browsers', async t => {
  const app = demo(t);
  const token = await invitation(app);
  const participant = request.agent(app);
  const stranger = request.agent(app);
  await participant.post('/trial/role').send({ role: 'lawyer' }).expect(401);
  await participant.post('/trial/redeem').send({ token }).expect(200);
  await participant.post('/trial/redeem').send({ token }).expect(200);
  await stranger.post('/trial/redeem').send({ token }).expect(409);
  await stranger.post('/trial/redeem').send({ token: await invitation(app) }).expect(200);

  const { body: me } = await participant.get('/api/me').expect(200);
  assert.equal(me.role, 'enterprise');
  assert.equal(me.guidedTrial, true);
  const { body: matter } = await participant.post('/api/enterprise/requests')
    .send({ reference: 'TRIAL-001', email: me.trialEmployeeEmail, summary: 'Fictional work authorization request' }).expect(201);
  assert.equal(matter.stage, 'awaiting_firm');
  await stranger.get('/api/enterprise/requests').expect(200, []);
  const matterUrl = `/api/draft-matters/${matter.id}`;
  const intake = `${matterUrl}/intake`;
  await participant.post('/trial/role').send({ role: 'admin' }).expect(400);
  await participant.post('/trial/role').send({ role: 'lawyer' }).expect(200);
  await participant.post(`${matterUrl}/decision`).send({ decision: 'accepted' }).expect(200);
  await participant.post(`${matterUrl}/invite`).send({ employeeId: 'employee' }).expect(200);
  await stranger.post('/trial/role').send({ role: 'lawyer' }).expect(200);
  await stranger.get('/api/draft-matters').expect(200, []);
  await stranger.get(`${intake}/questionnaire`).expect(404);
  await participant.post('/trial/role').send({ role: 'employee' }).expect(200);
  await participant.post(`/api/matter-invitations/${matter.id}/accept`).expect(200);
  await participant.post(`${intake}/consent`).send({ agree: true }).expect(200);
  await participant.put(`${intake}/questionnaire`).send({ answers: { notes: 'Sample answers' }, submit: true }).expect(200);
  await participant.post('/trial/role').send({ role: 'lawyer' }).expect(200);
  const docs = `${intake}/document-requests`;
  const { body: doc } = await participant.post(docs).send({ title: 'Sample letter', instructions: 'Upload a fictional letter.' }).expect(201);
  await participant.post('/trial/role').send({ role: 'employee' }).expect(200);
  const { body: file } = await participant.post(`${intake}/materials`)
    .attach('file', Buffer.from('Sample letter'), 'example.txt').expect(201);
  const { body: submission } = await participant.put(`${docs}/${doc.id}/submit`)
    .send({ materialIds: [file.id], revision: doc.revision }).expect(200);
  await participant.post('/trial/role').send({ role: 'lawyer' }).expect(200);
  await participant.put(`${docs}/${doc.id}/review`).send({ decision: 'accepted', revision: submission.revision }).expect(200);
  await participant.post('/trial/role').send({ role: 'enterprise' }).expect(200);
  const { body: progress } = await participant.get('/api/enterprise/requests').expect(200);
  assert.equal(progress[0].stage, 'intake_submitted');
  await participant.post('/auth/logout').expect(200);
  await participant.get('/api/me').expect(401);
  await participant.post('/trial/redeem').send({ token }).expect(200);
  await participant.get('/api/enterprise/requests').expect(200, []);
});

test('hosted trial uses separate HTTPS-only workspace and role cookies', async t => {
  const app = demo(t, { organizerKey, secureCookies: true });
  const response = await request(app).post('/trial/redeem').send({ token: await invitation(app) }).expect(200);
  const cookies: unknown = response.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.every(cookie => typeof cookie === 'string'));
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) {
    assert.match(cookie, /^__Host-mx_(guided_session|trial_workspace)=/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; SameSite=Strict/);
  }
  const pair = cookies.map(cookie => cookie.split(';', 1)[0]);
  assert.equal((await request(app).get('/api/me').set('Cookie', pair.join('; ')).expect(200)).body.role, 'enterprise');
  for (const cookie of pair) await request(app).get('/api/me').set('Cookie', cookie).expect(401);
});

test('trial links require organizer authorization and outlive a demo restart but expire after 48 hours', async t => {
  let time = Date.now();
  const app = demo(t, { organizerKey, now: () => time });
  await request(app).post('/trial/links').send({ key: password }).expect(403);
  await request(app).post('/trial/links').set('Origin', 'https://foreign.example.test').send({ key: organizerKey }).expect(403);
  const token = await invitation(app);
  await request(app).post('/trial/redeem').send({ token: (token[0] === 'a' ? 'b' : 'a') + token.slice(1) }).expect(410);
  const legacy = request.agent(app);
  await legacy.post('/auth/login').send({ email: 'enterprise@preview.example.test', password }).expect(200);
  await legacy.post('/trial/role').send({ role: 'lawyer' }).expect(401);
  await legacy.post('/trial/redeem').send({ token }).expect(200);
  time += 2 * 60 * 60 * 1000;
  await legacy.post('/trial/role').send({ role: 'lawyer' }).expect(401);
  assert.equal((await legacy.get('/api/me').expect(200)).body.guidedTrial, undefined);
  const restarted = demo(t, { organizerKey, now: () => time });
  await request(restarted).post('/trial/redeem').send({ token }).expect(200);
  time += 46 * 60 * 60 * 1000;
  await request(restarted).post('/trial/redeem').send({ token }).expect(410);
  const disabled = demo(t, {});
  await request(disabled).get('/healthz').expect(200, { ok: true, syntheticDemo: true });
  await request(disabled).post('/trial/links').send({ key: organizerKey }).expect(404);
});

test('trial progress follows the case state, points back after returns and finishes after HR checks progress', async t => {
  const app = demo(t);
  const participant = request.agent(app);
  await participant.get('/trial/progress').expect(401);
  await participant.post('/trial/redeem').send({ token: await invitation(app) }).expect(200);
  const progress = async () => (await participant.get('/trial/progress').expect(200).expect('Cache-Control', 'no-store')).body;
  const as = (role: string) => participant.post('/trial/role').send({ role }).expect(200);
  const expectNext = async (done: number, role: string | null, title?: RegExp) => {
    const body = await progress();
    assert.equal(body.steps.filter((step: { done: boolean }) => step.done).length, done);
    assert.equal(body.next?.role ?? null, role);
    if (title) assert.match(body.next.title, title);
    assert.ok(Date.parse(body.expiresAt) > Date.now());
  };
  await expectNext(0, 'enterprise', /Start a case request/);
  const { body: me } = await participant.get('/api/me').expect(200);
  const send = { reference: 'TRIAL-002', email: me.trialEmployeeEmail, summary: 'Fictional request' };
  const { body: matter } = await participant.post('/api/enterprise/requests').send(send).expect(201);
  await expectNext(1, 'lawyer', /Accept the HR request/);
  const matterUrl = `/api/draft-matters/${matter.id}`;
  const intake = `${matterUrl}/intake`;
  await as('lawyer');
  await participant.post(`${matterUrl}/decision`).send({ decision: 'returned', note: 'Add a start date.' }).expect(200);
  await expectNext(1, 'enterprise', /Revise the returned request/);
  await as('enterprise');
  await participant.put(`/api/enterprise/requests/${matter.id}`).send(send).expect(200);
  await as('lawyer');
  await participant.post(`${matterUrl}/decision`).send({ decision: 'accepted' }).expect(200);
  await participant.post(`${matterUrl}/invite`).send({ employeeId: 'employee' }).expect(200);
  await expectNext(3, 'employee', /Accept the case invitation/);
  await as('employee');
  await participant.post(`/api/matter-invitations/${matter.id}/accept`).expect(200);
  await participant.post(`${intake}/consent`).send({ agree: true }).expect(200);
  await expectNext(5, 'employee', /questionnaire/);
  await participant.put(`${intake}/questionnaire`).send({ answers: { notes: 'Sample' }, submit: true }).expect(200);
  await expectNext(6, 'lawyer', /Request a sample document/);
  await as('lawyer');
  const docs = `${intake}/document-requests`;
  const { body: doc } = await participant.post(docs).send({ title: 'Sample letter', instructions: '' }).expect(201);
  await as('employee');
  const { body: file } = await participant.post(`${intake}/materials`).attach('file', Buffer.from('Sample'), 'a.txt').expect(201);
  const { body: sent } = await participant.put(`${docs}/${doc.id}/submit`).send({ materialIds: [file.id], revision: doc.revision }).expect(200);
  await expectNext(8, 'lawyer', /Accept the submitted document/);
  await as('lawyer');
  const { body: returned } = await participant.put(`${docs}/${doc.id}/review`)
    .send({ decision: 'returned', feedback: 'Sign it.', revision: sent.revision }).expect(200);
  await expectNext(7, 'employee', /Replace the returned files/);
  await as('employee');
  const { body: resent } = await participant.put(`${docs}/${doc.id}/submit`)
    .send({ materialIds: [file.id], revision: returned.revision }).expect(200);
  await as('lawyer');
  // Opening case progress as another role or before the review does not count as the HR check.
  await participant.get('/api/enterprise/requests').expect(403);
  await participant.put(`${docs}/${doc.id}/review`).send({ decision: 'accepted', revision: resent.revision }).expect(200);
  await expectNext(9, 'enterprise', /Check case progress/);
  await as('enterprise');
  await expectNext(9, 'enterprise');
  await participant.get('/api/enterprise/requests').expect(200);
  await expectNext(10, null);
});

test('starting over replaces the trial case in place without extending the trial or its upload allowance', async t => {
  let time = Date.now();
  const app = demo(t, { organizerKey, now: () => time });
  const participant = request.agent(app);
  await participant.post('/trial/reset').expect(401);
  await participant.post('/trial/redeem').send({ token: await invitation(app) }).expect(200);
  const { body: before } = await participant.get('/trial/progress').expect(200);
  const { body: me } = await participant.get('/api/me').expect(200);
  const { body: matter } = await participant.post('/api/enterprise/requests')
    .send({ reference: 'TRIAL-003', email: me.trialEmployeeEmail, summary: 'Fictional request' }).expect(201);
  await participant.post('/trial/role').send({ role: 'lawyer' }).expect(200);
  await participant.post(`/api/draft-matters/${matter.id}/decision`).send({ decision: 'accepted' }).expect(200);
  await participant.post(`/api/draft-matters/${matter.id}/invite`).send({ employeeId: 'employee' }).expect(200);
  await participant.post('/trial/role').send({ role: 'employee' }).expect(200);
  await participant.post(`/api/matter-invitations/${matter.id}/accept`).expect(200);
  await participant.post(`/api/draft-matters/${matter.id}/intake/consent`).send({ agree: true }).expect(200);
  for (let i = 0; i < 20; i++)
    await participant.post(`/api/draft-matters/${matter.id}/intake/materials`).attach('file', Buffer.from('Sample ' + i), 'a.txt').expect(201);

  time += 30 * 60 * 1000;
  await participant.post('/trial/reset').expect(200);
  const { body: after } = await participant.get('/api/me').expect(200);
  assert.equal(after.role, 'enterprise');
  await participant.get('/api/enterprise/requests').expect(200, []);
  const { body: progress } = await participant.get('/trial/progress').expect(200);
  assert.equal(progress.expiresAt, before.expiresAt);
  assert.equal(progress.steps.filter((step: { done: boolean }) => step.done).length, 0);
  const { body: second } = await participant.post('/api/enterprise/requests')
    .send({ reference: 'TRIAL-004', email: me.trialEmployeeEmail, summary: 'Fictional request' }).expect(201);
  await participant.post('/trial/role').send({ role: 'lawyer' }).expect(200);
  await participant.post(`/api/draft-matters/${second.id}/decision`).send({ decision: 'accepted' }).expect(200);
  await participant.post(`/api/draft-matters/${second.id}/invite`).send({ employeeId: 'employee' }).expect(200);
  await participant.post('/trial/role').send({ role: 'employee' }).expect(200);
  await participant.post(`/api/matter-invitations/${second.id}/accept`).expect(200);
  await participant.post(`/api/draft-matters/${second.id}/intake/consent`).send({ agree: true }).expect(200);
  await participant.post(`/api/draft-matters/${second.id}/intake/materials`).attach('file', Buffer.from('Sample'), 'a.txt').expect(409);
  time += 90 * 60 * 1000;
  await participant.post('/trial/reset').expect(401);
});

test('organizers see link activity and participant feedback, and only with the organizer key', async t => {
  const app = demo(t);
  const activity = async () => (await request(app).post('/trial/activity').send({ key: organizerKey })
    .expect(200).expect('Cache-Control', 'no-store')).body;
  await request(app).post('/trial/activity').send({ key: password }).expect(403);
  await request(app).post('/trial/activity').send({}).expect(403);
  await request(app).post('/trial/links').send({ key: organizerKey, note: 'x'.repeat(61) }).expect(400);
  const { body: link } = await request(app).post('/trial/links').send({ key: organizerKey, note: ' Acme HR pilot ' }).expect(200);
  const token = link.path.slice('/#trial='.length);
  await invitation(app);
  let rows = await activity();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].note, 'Acme HR pilot');
  assert.equal(rows[1].openedAt, null);
  assert.equal(rows[1].active, false);
  assert.equal(rows[0].note, null);
  assert.ok(rows.every((row: { id: string }) => row.id.length === 6));

  const participant = request.agent(app);
  await participant.post('/trial/feedback').send({ ease: 5, stuck: 'none' }).expect(401);
  await participant.post('/trial/redeem').send({ token }).expect(200);
  const { body: me } = await participant.get('/api/me').expect(200);
  await participant.post('/api/enterprise/requests')
    .send({ reference: 'TRIAL-005', email: me.trialEmployeeEmail, summary: 'Fictional request' }).expect(201);
  rows = await activity();
  assert.equal(rows[1].active, true);
  assert.equal(rows[1].done, 1);
  assert.equal(rows[1].total, 10);
  assert.ok(rows[1].openedAt && rows[1].lastActiveAt);

  for (const bad of [{ ease: 0, stuck: 'none' }, { ease: 6, stuck: 'none' }, { ease: 2.5, stuck: 'none' },
    { ease: 3, stuck: 'not_a_step' }, { ease: 3, stuck: 'none', comment: 'x'.repeat(1001) }])
    await participant.post('/trial/feedback').send(bad).expect(400);
  await participant.post('/trial/feedback').send({ ease: 2, stuck: 'employee_consent', comment: ' Consent was long. ' }).expect(200);
  assert.equal((await participant.get('/trial/progress').expect(200)).body.feedbackSent, true);
  await participant.post('/trial/reset').expect(200);
  assert.equal((await participant.get('/trial/progress').expect(200)).body.feedbackSent, true);
  await participant.post('/auth/logout').expect(200);
  rows = await activity();
  assert.equal(rows[1].active, false);
  assert.equal(rows[1].resets, 1);
  assert.equal(rows[1].done, 0);
  assert.deepEqual({ ...rows[1].feedback, at: undefined }, { ease: 2, stuck: 'employee_consent', comment: 'Consent was long.', at: undefined });
});

test('trial activity keeps the last step count after a trial expires and tracks activity on trial routes', async t => {
  let time = Date.UTC(2026, 10, 24, 12);
  const app = demo(t, { organizerKey, now: () => time });
  const activity = async () => (await request(app).post('/trial/activity').send({ key: organizerKey }).expect(200)).body;
  const participant = request.agent(app);
  await participant.post('/trial/redeem').send({ token: await invitation(app) }).expect(200);
  const { body: me } = await participant.get('/api/me').expect(200);
  await participant.post('/api/enterprise/requests')
    .send({ reference: 'TRIAL-006', email: me.trialEmployeeEmail, summary: 'Fictional request' }).expect(201);
  time += 10 * 60 * 1000;
  await participant.get('/trial/progress').expect(200);
  const lastActive = new Date(time).toISOString();
  // Expire the trial before the organizer ever looks: the count must survive the cleanup.
  time += 2 * 60 * 60 * 1000;
  const [row] = await activity();
  assert.equal(row.active, false);
  assert.equal(row.done, 1);
  assert.equal(row.lastActiveAt, lastActive);
  await participant.get('/trial/progress').expect(401);
});

test('trial activity drops records a day after their link expires and keeps at most 200', async t => {
  let time = Date.UTC(2026, 10, 24, 12);
  const app = demo(t, { organizerKey, now: () => time });
  const link = (note: string) => request(app).post('/trial/links').send({ key: organizerKey, note }).expect(200);
  const notes = async () => (await request(app).post('/trial/activity').send({ key: organizerKey }).expect(200))
    .body.map((row: { note: string }) => row.note);
  await link('old');
  time += (48 + 24) * 60 * 60 * 1000 - 1000;
  await link('recent');
  assert.deepEqual(await notes(), ['recent', 'old']);
  time += 1000;
  await link('new');
  assert.deepEqual(await notes(), ['new', 'recent']);
  for (let i = 0; i < 200; i++) await link('bulk ' + i);
  const kept = await notes();
  assert.equal(kept.length, 200);
  assert.equal(kept[0], 'bulk 199');
  assert.ok(!kept.includes('new') && !kept.includes('recent'));
});
