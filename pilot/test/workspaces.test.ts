import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createApp } from '../src/app';
import { DraftRegister } from '../src/draftRegister';
import { accountsJson, agents, loginAs, makeApp, PW } from './helpers';

test('enterprise sends requests, revises a return, and tracks two cases without accessing private intake', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-enterprise-cases-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accounts = JSON.parse(accountsJson());
  const primary = accounts.find((account: { role: string }) => account.role === 'employee');
  const secondary = { ...primary, id: 'employee2', email: 'second@pilot.example.test' };
  const { app } = makeApp({
    PILOT_ACCOUNTS: JSON.stringify([...accounts, secondary]), PILOT_MAX_ACCOUNTS: '5', PILOT_PRIMARY_EMPLOYEE_ID: primary.id,
    PILOT_DRAFT_REGISTER_DIR: dir, PILOT_DRAFT_REGISTER_KEY: Buffer.alloc(32, 9).toString('base64'),
  });
  const { lawyer, employee, enterprise, admin } = await agents(app);
  const second = request.agent(app);
  await second.post('/auth/login').send({ email: secondary.email, password: PW.employee }).expect(200);
  const endpoint = '/api/enterprise/requests';
  const draft = '/api/draft-matters/';
  const requestA = { reference: 'HR-101', email: primary.email, summary: 'Synthetic request A' };
  await lawyer.post(endpoint).send(requestA).expect(403);
  await admin.get(endpoint).expect(403);
  await enterprise.post(endpoint).send({ ...requestA, email: 'invalid-email' }).expect(400);
  const a = (await enterprise.post(endpoint).send(requestA).expect(201)).body.id;
  const b = (await enterprise.post(endpoint).send({ ...requestA, reference: 'HR-102', email: secondary.email }).expect(201)).body.id;
  const progress = async (id: string, stage: string, next: string | null) => {
    const rows = (await enterprise.get(endpoint).expect(200)).body;
    assert.equal(rows.length, 2);
    const row = rows.find((entry: { id: string }) => entry.id === id);
    assert.equal(row.stage, stage);
    assert.equal(row.next, next);
    assert.ok(Object.keys(row).every(key => ['id', 'reference', 'email', 'summary', 'decision', 'note', 'stage', 'next', 'updatedAt'].includes(key)));
  };
  await progress(a, 'awaiting_firm', 'Law firm');
  await lawyer.post(draft + a + '/invite').send({ employeeId: primary.id }).expect(409);
  await lawyer.get(draft + a + '/intake/questionnaire').expect(404);
  await enterprise.post(draft + a + '/decision').send({ decision: 'accepted' }).expect(403);
  await lawyer.post(draft + b + '/decision').send({ decision: 'returned', note: 'Clarify the synthetic scope' }).expect(200);
  await progress(b, 'returned', 'HR');
  await enterprise.put(endpoint + '/' + b).send({ ...requestA, reference: 'HR-102', email: secondary.email }).expect(200);
  await progress(b, 'awaiting_firm', 'Law firm');
  await lawyer.post(draft + a + '/decision').send({ decision: 'accepted' }).expect(200);
  await lawyer.post(draft + b + '/decision').send({ decision: 'accepted' }).expect(200);
  await progress(a, 'accepted', 'Law firm');
  await lawyer.post(draft + a + '/invite').send({ employeeId: secondary.id }).expect(409);
  await lawyer.post(draft + a + '/invite').send({ employeeId: primary.id }).expect(200);
  await lawyer.post(draft + b + '/invite').send({ employeeId: secondary.id }).expect(200);
  await progress(a, 'invitation_sent', 'Employee');
  await employee.post('/api/matter-invitations/' + a + '/accept').expect(200);
  await second.post('/api/matter-invitations/' + b + '/accept').expect(200);
  await progress(a, 'employee_intake', 'Employee');
  await employee.get(draft + b + '/intake/questionnaire').expect(404);
  await second.get(draft + a + '/intake/materials').expect(404);
  await employee.post(draft + a + '/intake/consent').send({ agree: true }).expect(200);
  await employee.put(draft + a + '/intake/questionnaire').send({ answers: { notes: 'Private synthetic answer' }, submit: true }).expect(200);
  const material = (await employee.post(draft + a + '/intake/materials')
    .attach('file', Buffer.from('Synthetic file'), 'synthetic-evidence.txt').expect(201)).body.id;
  await second.post(draft + b + '/intake/consent').send({ agree: true }).expect(200);
  await second.put(draft + b + '/intake/questionnaire').send({ answers: { notes: 'Second private answer' } }).expect(200);
  await progress(a, 'intake_submitted', 'Law firm');
  await progress(b, 'employee_intake', 'Employee');
  await enterprise.get(draft + a + '/intake/questionnaire').expect(403);
  await enterprise.get(draft + a + '/intake/materials').expect(403);
  const results = (await enterprise.get(endpoint)).text;
  assert.doesNotMatch(results, /Private synthetic answer|Second private answer|synthetic-evidence/);
  await lawyer.put(draft + a + '/status').send({ status: 'in_review' }).expect(200);
  await progress(a, 'in_review', 'Law firm');

  const documents = draft + a + '/intake/document-requests';
  const item = (await lawyer.post(documents).send({ title: 'Private request title', instructions: 'Private request instructions' }).expect(201)).body;
  await progress(a, 'documents_needed', 'Employee');
  await progress(b, 'employee_intake', 'Employee');
  await enterprise.get(documents).expect(403);
  await second.get(documents).expect(404);
  await employee.post(documents).send({ title: 'Not permitted', instructions: '' }).expect(403);
  const inbox = (await employee.get('/api/matter-invitations').expect(200)).body;
  assert.equal(inbox.find((row: { id: string }) => row.id === a).pendingDocuments, 1);
  await employee.put(documents + '/' + item.id + '/submit').send({ materialIds: ['not-in-case'], revision: item.revision }).expect(400);
  const sent = (await employee.put(documents + '/' + item.id + '/submit')
    .send({ materialIds: [material], revision: item.revision }).expect(200)).body;
  await progress(a, 'documents_submitted', 'Law firm');
  const returned = (await lawyer.put(documents + '/' + item.id + '/review')
    .send({ decision: 'returned', feedback: 'Private review feedback', revision: sent.revision }).expect(200)).body;
  await progress(a, 'documents_needed', 'Employee');
  await employee.put(documents + '/' + item.id + '/submit').send({ materialIds: [material], revision: item.revision }).expect(409);
  const resent = (await employee.put(documents + '/' + item.id + '/submit')
    .send({ materialIds: [material], revision: returned.revision }).expect(200)).body;
  await lawyer.put(documents + '/' + item.id + '/review').send({ decision: 'accepted', revision: resent.revision }).expect(200);
  await progress(a, 'in_review', 'Law firm');
  assert.doesNotMatch((await enterprise.get(endpoint)).text, /Private request title|Private request instructions|Private review feedback/);
});

test('production intake displays and records agreement to the exact consent document', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-consent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agreement.txt');
  const env = {
    NODE_ENV: 'production', SECURE_COOKIES: 'false', PILOT_DATA_DIR: path.join(dir, 'case'),
  };
  const pending = await loginAs(makeApp(env).app, 'employee');
  await pending.get('/api/consent').expect(200, { signed: false, document: null });
  await pending.post('/api/consent').send({ agree: true }).expect(412);
  fs.writeFileSync(file, 'Synthetic agreement for testing.');
  const configured = { ...env, PILOT_CONSENT_FILE: file, PILOT_CONSENT_VERSION: 'synthetic-v1' };
  const app = makeApp(configured).app;
  const employee = await loginAs(app, 'employee');
  const doc = (await employee.get('/api/consent').expect(200)).body.document;
  assert.equal(doc.text, 'Synthetic agreement for testing.');
  assert.equal(doc.preview, false);
  await employee.post('/api/consent').send({ agree: true, digest: 'stale' }).expect(409);
  await employee.post('/api/consent').send({ agree: true, digest: doc.digest }).expect(200);
  await employee.put('/api/questionnaire').send({ answers: { notes: 'Synthetic answer' } }).expect(200);
  const lawyer = await loginAs(app, 'lawyer');
  const signature = (await lawyer.get('/api/case').expect(200)).body.consent;
  assert.equal(signature.digest, doc.digest);
  assert.equal(signature.version, 'synthetic-v1');
  fs.writeFileSync(file, 'Revised synthetic agreement.');
  const returning = await loginAs(makeApp(configured).app, 'employee');
  assert.equal((await returning.get('/api/case').expect(200)).body.consentSigned, false);
  await returning.put('/api/questionnaire').send({ answers: { notes: 'Second answer' } }).expect(412);
});

test('voice calls and recordings stay scoped to the case and import is idempotent', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-voice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const callSid = 'CA' + '2'.repeat(32);
  const recordingSid = 'RE' + '3'.repeat(32);
  const requests: string[] = [];
  const voiceFetch: typeof fetch = async (url, init) => {
    requests.push(String(url));
    if (String(url).endsWith('/Calls.json')) {
      assert.match(String(init?.body), /record-from-answer-dual/);
      return Response.json({ sid: callSid });
    }
    if (String(url).endsWith('/Calls/' + callSid + '/Recordings.json')) {
      return Response.json({ recordings: [{ sid: recordingSid, status: 'completed', call_sid: callSid }] });
    }
    if (String(url).endsWith('/Recordings/' + recordingSid + '.mp3')) return new Response('ID3synthetic');
    return new Response(null, { status: 404 });
  };
  const { app } = makeApp({
    PILOT_DRAFT_REGISTER_DIR: dir, PILOT_DRAFT_REGISTER_KEY: Buffer.alloc(32, 9).toString('base64'),
    PILOT_TWILIO_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'AC' + '1'.repeat(32), TWILIO_API_KEY_SID: 'SK' + '4'.repeat(32),
    TWILIO_API_KEY_SECRET: 'synthetic', TWILIO_PHONE_NUMBER: '+12025550101', PILOT_LAWYER_PHONE: '+12025550102',
  }, { voiceFetch });
  const { lawyer, employee } = await agents(app);
  const endpoint = '/api/case-tools/calls';
  const payload = { phone: '+12025550103', recordingAgreed: true };
  await employee.post(endpoint).send(payload).expect(403);
  await lawyer.post(endpoint).send(payload).expect(412);
  assert.equal(requests.length, 0);
  await employee.post('/api/consent').send({ agree: true }).expect(200);
  await lawyer.post(endpoint).send({ ...payload, recordingAgreed: false }).expect(412);
  const call = (await lawyer.post(endpoint).send(payload).expect(201)).body.id;
  const matter = (await lawyer.post('/api/draft-matters').send({ label: 'Other matter' }).expect(201)).body.id;
  const other = '/api/draft-matters/' + matter + '/intake';
  await lawyer.post(other + '/case-tools/calls/' + call + '/import').expect(412);
  const url = endpoint + '/' + call + '/import';
  const recording = (await lawyer.post(url).expect(201)).body.id;
  assert.deepEqual((await lawyer.post(url).expect(200)).body, { id: recording });
  assert.equal(requests.length, 3);
  assert.equal((await lawyer.get('/api/case-tools').expect(200)).body.materials[0].id, recording);
  assert.deepEqual((await lawyer.get(other + '/materials').expect(200)).body, []);
  assert.deepEqual((await employee.get('/api/materials').expect(200)).body, []);
});

test('one lawyer can invite two employees and each can access only their assigned cases', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-multi-employee-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accounts = JSON.parse(accountsJson());
  const secondEmployee = { ...accounts[0], id: 'employee2', email: 'second@pilot.example.test', name: 'Second Employee' };
  accounts.push(secondEmployee);
  const env = {
    PILOT_ACCOUNTS: JSON.stringify(accounts), PILOT_MAX_ACCOUNTS: '5',
    PILOT_DATA_DIR: path.join(root, 'original'), PILOT_DRAFT_REGISTER_DIR: path.join(root, 'register'),
    PILOT_DRAFT_REGISTER_KEY: Buffer.alloc(32, 9).toString('base64'),
  };
  assert.throws(() => makeApp(env), /PILOT_PRIMARY_EMPLOYEE_ID/);
  const { app, cfg } = makeApp({ ...env, PILOT_PRIMARY_EMPLOYEE_ID: 'employee' });
  const lawyer = await loginAs(app, 'lawyer');
  const first = await loginAs(app, 'employee');
  const second = request.agent(app);
  await second.post('/auth/login').send({ email: secondEmployee.email, password: PW.employee }).expect(200);
  assert.deepEqual((await lawyer.get('/api/me').expect(200)).body.invitees.map((a: { id: string }) => a.id),
    ['employee', 'employee2']);
  assert.equal((await second.get('/api/me').expect(200)).body.originalCaseAccess, false);
  await first.get('/api/case').expect(200);
  for (const url of ['/api/case', '/api/case/status', '/api/questionnaire', '/api/assessment', '/api/materials', '/files/example']) {
    await second.get(url).expect(403);
  }
  await second.post('/api/consent').send({ agree: true }).expect(403);

  const matters = '/api/draft-matters';
  const invitations = '/api/matter-invitations';
  const a = (await lawyer.post(matters).send({ label: 'Synthetic Alpha' }).expect(201)).body.id;
  const b = (await lawyer.post(matters).send({ label: 'Synthetic Beta' }).expect(201)).body.id;
  await lawyer.post(matters + '/' + a + '/invite').send({ employeeId: 'employee' }).expect(200);
  await lawyer.post(matters + '/' + b + '/invite').send({ employeeId: 'employee2' }).expect(200);
  await lawyer.post(matters + '/' + a + '/invite').send({ employeeId: 'employee2' }).expect(409);
  for (const [employee, own, other, answer] of [[first, a, b, 'Alpha'], [second, b, a, 'Beta']] as const) {
    const listed = (await employee.get(invitations).expect(200)).body;
    assert.deepEqual(listed.map((row: { id: string }) => row.id), [own]);
    const intake = matters + '/' + own + '/intake';
    await employee.get(intake + '/questionnaire').expect(404);
    await employee.post(invitations + '/' + other + '/accept').expect(404);
    await employee.post(invitations + '/' + own + '/accept').expect(200);
    await employee.post(intake + '/consent').send({ agree: true }).expect(200);
    await employee.put(intake + '/questionnaire').send({ answers: { notes: answer }, submit: true }).expect(200);
    await employee.get(matters + '/' + other + '/intake/questionnaire').expect(404);
    assert.deepEqual((await lawyer.get(intake + '/questionnaire').expect(200)).body.answers, { notes: answer });
  }
  const retry = await lawyer.post(matters + '/' + a + '/invite').send({ employeeId: 'employee' }).expect(200);
  assert.equal(retry.body.invitation.accepted, true);
  assert.throws(() => createApp({ ...cfg, primaryEmployeeId: 'employee2' }), /original case employee/);
});

test('employee accepts an invitation and submits intake scoped to that matter', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-intake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { app } = makeApp({ PILOT_DRAFT_REGISTER_DIR: dir, PILOT_DRAFT_REGISTER_KEY: Buffer.alloc(32, 9).toString('base64') });
  const { lawyer, employee, enterprise, admin } = await agents(app);
  const matters = '/api/draft-matters';
  const first = (await lawyer.post(matters).send({ label: 'Matter A' }).expect(201)).body.id;
  const second = (await lawyer.post(matters).send({ label: 'Matter B' }).expect(201)).body.id;
  const intake = matters + '/' + first + '/intake';
  const other = matters + '/' + second + '/intake';
  const invitations = '/api/matter-invitations';
  await employee.post(invitations + '/' + second + '/accept').expect(404);
  await lawyer.post(matters + '/' + first + '/invite').send({ employeeId: 'employee' }).expect(200);
  assert.deepEqual((await employee.get(invitations).expect(200)).body, [{ id: first, label: 'Matter A', accepted: false }]);
  await employee.get(intake + '/materials').expect(404);
  await employee.post(invitations + '/' + first + '/accept').expect(200);
  for (const agent of [enterprise, admin]) await agent.get(intake + '/questionnaire').expect(403);
  await employee.post('/api/consent').send({ agree: true }).expect(200);
  await employee.put(intake + '/questionnaire').send({ answers: {} }).expect(412);
  await employee.post(intake + '/consent').send({ agree: true }).expect(200);
  await employee.put(intake + '/questionnaire').send({ answers: { notes: 'Synthetic answer' }, submit: true }).expect(200);
  const file = await employee.post(intake + '/materials').attach('file', Buffer.from('Synthetic text'), 'fixture.txt').expect(201);
  const petition = intake + '/petition';
  await employee.get(petition).expect(403);
  await lawyer.get(petition + '/pdf').expect(409);
  await lawyer.get(petition + '/forms/I-140/pdf').expect(409);
  let draft = (await lawyer.get(petition).expect(200)).body;
  const facts = { beneficiary_given_name: { value: 'Synthetic', source: file.body.id } };
  const petitionEdits = { facts, followUps: ['Confirm dates'], letter: 'Synthetic petition letter.', exhibitIds: [file.body.id] };
  await lawyer.put(petition).send({ ...petitionEdits, revision: draft.revision }).expect(200);
  const form = (await lawyer.get(petition + '/forms/I-140').expect(200)).body;
  assert.ok(form.rows.some((row: { value: string; source: string }) => row.value === 'Synthetic' && row.source === file.body.id));
  await lawyer.post(petition + '/forms/I-140/review').send({ revision: form.revision }).expect(409);
  draft = (await lawyer.get(petition).expect(200)).body;
  await lawyer.post(petition + '/review').send({ revision: draft.revision }).expect(200);
  await lawyer.get(petition + '/pdf').expect('Content-Type', /pdf/).expect(200);
  await lawyer.get(other + '/petition/pdf').expect(409);
  draft = (await lawyer.get(petition).expect(200)).body;
  await lawyer.put(petition).send({ ...petitionEdits, revision: draft.revision, letter: 'Revised draft.' }).expect(200);
  await lawyer.get(petition + '/pdf').expect(409);
  const g28 = petition + '/forms/G-28';
  let g28Review = (await lawyer.get(g28).expect(200)).body;
  const changes = Object.fromEntries(g28Review.rows.filter((row: { required?: boolean }) => row.required !== false)
    .map((row: { fieldId: string; type: string; options: { value: string }[] }) => [
      row.fieldId,
      row.type === 'toggle' ? 'false' : row.type === 'select' ? row.options[0].value :
        row.fieldId.includes('State') ? 'CA' : '1',
    ]));
  await lawyer.put(g28).send({ revision: g28Review.revision, changes }).expect(200);
  g28Review = (await lawyer.get(g28).expect(200)).body;
  await lawyer.post(g28 + '/review').send({ revision: g28Review.revision }).expect(200);
  await lawyer.get(g28 + '/pdf').expect('Content-Type', /pdf/).expect(200);
  g28Review = (await lawyer.get(g28).expect(200)).body;
  await lawyer.put(g28).send({ revision: g28Review.revision, changes: { G28_AttyState: 'NY' } }).expect(200);
  await lawyer.get(g28 + '/pdf').expect(409);
  const checklist = intake + '/playbook-checklist';
  const selection = { id: 'eb1a_v1', scenario: 'I140_Only' };
  await employee.get(checklist).expect(403);
  await lawyer.put(checklist).send({ ...selection, scenario: 'toString' }).expect(400);
  await lawyer.put(checklist).send(selection).expect(200);
  const assignment = { playbookId: selection.id, scenario: selection.scenario, documentId: 'beneficiary_passport' };
  await lawyer.put(checklist + '/materials/' + file.body.id).send({ ...assignment, documentId: 'i94_record' }).expect(400);
  await lawyer.put(checklist + '/materials/' + file.body.id).send(assignment).expect(200);
  const review = (await lawyer.get(checklist).expect(200)).body;
  assert.deepEqual(review.selection, selection);
  assert.deepEqual(review.materials, [{ id: file.body.id, filename: 'fixture.txt', documentId: 'beneficiary_passport' }]);
  assert.equal(review.documents.some((d: { id: string }) => d.id === 'i94_record'), false);
  await lawyer.put(checklist).send({ ...selection, scenario: 'Concurrent_AOS' }).expect(200);
  await lawyer.put(checklist + '/materials/' + file.body.id).send(assignment).expect(409);
  assert.equal((await lawyer.get(intake + '/questionnaire')).body.answers.notes, 'Synthetic answer');
  const url = (await lawyer.post(intake + '/materials/' + file.body.id + '/download-url').expect(200)).body.url;
  assert.equal((await lawyer.get(url).expect(200)).text, 'Synthetic text');
  await employee.get(url).expect(403);
  await lawyer.get(url.replace(first, second)).expect(403);
  await employee.get(other + '/questionnaire').expect(404);
  for (const base of [other, '/api']) {
    const unrelatedChecklist = (await lawyer.get(base + '/playbook-checklist').expect(200)).body;
    assert.equal(unrelatedChecklist.selection, undefined);
    assert.deepEqual(unrelatedChecklist.materials, []);
    assert.deepEqual((await lawyer.get(base + '/materials')).body, []);
    assert.deepEqual((await lawyer.get(base + '/questionnaire')).body.answers, {});
  }
});

test('case directory is projected only for its lawyer and accepts plain HTTPS origins', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-directory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'directory.json');
  const setOrigin = (origin: string) => fs.writeFileSync(file, JSON.stringify([
    { lawyerId: 'lawyer', label: 'Matter B', origin }
  ]));
  const env = { PILOT_WORKSPACES_FILE: file };
  setOrigin('https://case-b.example.test');
  const users = await agents(makeApp(env).app);
  const lawyer = await users.lawyer.get('/api/me').expect(200);
  assert.deepEqual(lawyer.body.workspaces, [{ label: 'Matter B', origin: 'https://case-b.example.test' }]);
  for (const user of [users.admin, users.employee, users.enterprise]) {
    const res = await user.get('/api/me').expect(200);
    assert.equal('workspaces' in res.body, false);
  }
  setOrigin('https://case-b.example.test/?token=x');
  assert.throws(() => makeApp(env), /plain HTTPS origin/);
});

test('draft matters persist per lawyer and do not change the active pilot case', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-drafts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 9).toString('base64');
  const { app } = makeApp({ PILOT_DRAFT_REGISTER_DIR: dir, PILOT_DRAFT_REGISTER_KEY: key });
  const users = await agents(app);
  const url = '/api/draft-matters';
  const before = await users.lawyer.get('/api/case/status').expect(200);
  const a = (await users.lawyer.post(url).send({ label: 'Synthetic A' }).expect(201)).body;
  const b = (await users.lawyer.post(url).send({ label: 'Synthetic B' }).expect(201)).body;
  for (const user of [users.admin, users.employee, users.enterprise]) {
    await user.get(url).expect(403);
    await user.post(url).send({ label: 'Hidden' }).expect(403);
    await user.put(url + '/' + a.id + '/status').send({ status: 'closed' }).expect(403);
  }
  await users.lawyer.put(url + '/' + b.id + '/status').send({ status: 'closed' }).expect(200);
  const reopened = new DraftRegister(dir, key);
  assert.deepEqual(reopened.list('lawyer'), [a, { ...b, status: 'closed' }]);
  assert.deepEqual(reopened.list('another-lawyer'), []);
  assert.equal(reopened.setStatus('another-lawyer', a.id, 'closed'), undefined);
  assert.deepEqual((await users.lawyer.get('/api/case/status')).body, before.body);
});
