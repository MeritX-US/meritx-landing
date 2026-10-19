import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, agents, download } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n% synthetic test fixture\n');

async function seeded(extra: Record<string, string> = {}) {
  const { app, cfg } = makeApp({ PILOT_QUESTIONNAIRE_FILE: '', ...extra });
  const a = await agents(app);
  assert.equal((await a.employee.post('/api/consent').send({ agree: true })).status, 200);
  const e = await a.employee.post('/api/materials').attach('file', PDF, { filename: 'synthetic-cv.pdf', contentType: 'application/pdf' });
  assert.equal(e.status, 201);
  const l = await a.lawyer.post('/api/materials').attach('file', PDF, { filename: 'lawyer-internal-note.pdf', contentType: 'application/pdf' });
  assert.equal(l.status, 201);
  return { app, cfg, a, empMaterial: e.body.id as string, lawyerMaterial: l.body.id as string };
}

// ---------------- employee ----------------
test('employee: sees only own materials, own questionnaire, status, published todos', async () => {
  const { a, empMaterial, lawyerMaterial } = await seeded();
  await a.lawyer.post('/api/todos').send({ text: 'unpublished request' });
  const t = await a.lawyer.post('/api/todos').send({ text: 'Please upload degree certificate' });
  await a.lawyer.put(`/api/todos/${t.body.id}/publish`).send({ published: true });
  await a.lawyer.put('/api/case/visa-type').send({ visaType: 'SYNTHETIC-VISA' });

  const list = await a.employee.get('/api/materials');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((m: any) => m.id), [empMaterial]);
  assert.equal(list.body[0].category, undefined);

  const c = await a.employee.get('/api/case');
  assert.equal(c.body.role, 'employee');
  assert.deepEqual(c.body.materials.map((m: any) => m.id), [empMaterial]);
  assert.deepEqual(c.body.todos.map((x: any) => x.text), ['Please upload degree certificate']);
  assert.equal(c.body.visaType, undefined, 'employee must not see visa decision fields');
  assert.equal(c.body.assessment, null);
  assert.match(c.body.disclaimer, /is legal advice/);
  assert.match(c.body.disclaimer, /not a law firm/);

  assert.equal((await download(a.employee, empMaterial)).status, 200);
  assert.equal((await download(a.employee, lawyerMaterial)).status, 404);
  assert.equal((await a.employee.delete(`/api/materials/${lawyerMaterial}`)).status, 404);
});

test('employee: cannot use lawyer-only or admin routes', async () => {
  const { a, empMaterial } = await seeded();
  const denied: [string, string, any?][] = [
    ['put', '/api/case/status', { status: 'filed' }], ['put', '/api/case/visa-type', { visaType: 'X' }],
    ['put', `/api/materials/${empMaterial}/category`, { category: 'x' }], ['post', '/api/todos', { text: 'x' }],
    ['put', '/api/assessment', { text: 'x' }], ['post', '/api/assessment/approve'], ['post', '/api/assessment/revoke'],
    ['get', '/api/access-log'],
  ];
  for (const [m, p, body] of denied) {
    const r = await (a.employee as any)[m](p).send(body);
    assert.equal(r.status, 403, `${m} ${p} => ${r.status}`);
  }
});

test('employee: must sign consent before questionnaire or upload', async () => {
  const { app } = makeApp();
  const a = await agents(app);
  assert.equal((await a.employee.put('/api/questionnaire').send({ answers: { notes: 'x' } })).status, 412);
  assert.equal((await a.employee.post('/api/materials').attach('file', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })).status, 412);
  await a.employee.post('/api/consent').send({ agree: true });
  assert.equal((await a.employee.put('/api/questionnaire').send({ answers: { notes: 'synthetic answer', injected: 'dropped' }, submit: true })).status, 200);
  const q = await a.lawyer.get('/api/questionnaire');
  assert.deepEqual(q.body.answers, { notes: 'synthetic answer' });
  assert.ok(q.body.submittedAt);
});

// ---------------- lawyer ----------------
test('lawyer: sees all materials and full case, can manage case', async () => {
  const { a, empMaterial, lawyerMaterial } = await seeded();
  const c = await a.lawyer.get('/api/case');
  assert.equal(c.body.role, 'lawyer');
  assert.deepEqual(new Set(c.body.materials.map((m: any) => m.id)), new Set([empMaterial, lawyerMaterial]));
  assert.ok('questionnaire' in c.body && 'assessment' in c.body && 'consent' in c.body);
  assert.equal((await download(a.lawyer, empMaterial)).status, 200);
  assert.equal((await a.lawyer.put(`/api/materials/${empMaterial}/category`).send({ category: 'CV' })).status, 200);
  assert.equal((await a.lawyer.put('/api/case/status').send({ status: 'in_review' })).status, 200);
  assert.equal((await a.lawyer.put('/api/case/status').send({ status: 'bogus' })).status, 400);
  assert.equal((await a.lawyer.get('/api/access-log')).status, 200);
  const dl = await download(a.lawyer, empMaterial);
  assert.match(String(dl.headers['content-disposition']), /^attachment/);
  assert.equal(dl.headers['cache-control'], 'no-store');
});

// ---------------- enterprise ----------------
test('enterprise: sees only progress/status, nothing else', async () => {
  const { a, empMaterial } = await seeded();
  await a.lawyer.put('/api/case/status').send({ status: 'documents_needed' });
  await a.lawyer.put('/api/assessment').send({ text: 'synthetic assessment' });
  await a.lawyer.post('/api/assessment/approve');
  const c = await a.enterprise.get('/api/case');
  assert.equal(c.status, 200);
  assert.deepEqual(Object.keys(c.body).sort(), ['role', 'status', 'updatedAt']);
  assert.equal(c.body.status, 'documents_needed');
  assert.deepEqual(Object.keys((await a.enterprise.get('/api/case/status')).body).sort(), ['status', 'updatedAt']);
  const denied: [string, string, any?][] = [
    ['get', '/api/materials'], ['post', `/api/materials/${empMaterial}/download-url`], ['post', '/api/materials'],
    ['get', '/api/questionnaire'], ['put', '/api/questionnaire', { answers: {} }], ['post', '/api/consent', { agree: true }],
    ['get', '/api/assessment'], ['put', '/api/case/status', { status: 'filed' }], ['get', '/api/access-log'],
    ['delete', `/api/materials/${empMaterial}`], ['post', '/api/todos', { text: 'x' }],
  ];
  for (const [m, p, body] of denied) {
    const r = await (a.enterprise as any)[m](p).send(body);
    assert.equal(r.status, 403, `${m} ${p} => ${r.status}`);
  }
});

// ---------------- admin (MeritX operator) ----------------
test('admin: status + access log only, no case materials', async () => {
  const { a, empMaterial } = await seeded();
  const c = await a.admin.get('/api/case');
  assert.deepEqual(Object.keys(c.body).sort(), ['role', 'status', 'updatedAt']);
  assert.equal((await a.admin.get('/api/access-log')).status, 200);
  for (const [m, p] of [['get', '/api/materials'], ['post', `/api/materials/${empMaterial}/download-url`], ['get', '/api/questionnaire'], ['get', '/api/assessment'], ['put', '/api/case/status']]) {
    const r = await (a.admin as any)[m](p).send({ status: 'filed' });
    assert.equal(r.status, 403, `${m} ${p} => ${r.status}`);
  }
});

test('access log records actions without content or filenames', async () => {
  const { a, empMaterial } = await seeded();
  await download(a.lawyer, empMaterial);
  await a.enterprise.get('/api/materials');
  const rows = (await a.lawyer.get('/api/access-log')).body as any[];
  const text = JSON.stringify(rows);
  assert.ok(rows.some(r => r.action === 'material.download' && r.actor === 'lawyer' && r.resource === empMaterial));
  assert.ok(rows.some(r => r.action === 'login.success' && r.actor === 'enterprise'));
  assert.ok(!text.includes('synthetic-cv.pdf'), 'filenames must not be logged');
  assert.ok(!text.includes('@pilot.example.test'), 'emails must not be logged');
});

test('upload rejects unsupported types and oversize files', async () => {
  const { app } = makeApp({ MAX_UPLOAD_BYTES: '64' });
  const a = await agents(app);
  await a.employee.post('/api/consent').send({ agree: true });
  assert.equal((await a.employee.post('/api/materials').attach('file', Buffer.from('<html>'), { filename: 'x.html', contentType: 'text/html' })).status, 415);
  assert.equal((await a.employee.post('/api/materials').attach('file', Buffer.alloc(100), { filename: 'big.pdf', contentType: 'application/pdf' })).status, 413);
});
