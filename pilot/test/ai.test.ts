import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, loadAiConfig } from '../src/config';
import { AiClient, fillTemplate, type FetchLike } from '../src/ai/provider';
import { makeApp, agents, testEnv } from './helpers';
import { createApp } from '../src/app';
import { EncryptedFileStore, type Store } from '../src/store';
import { Cipher } from '../src/crypto';

// Synthetic, generic prompt file written to a temp dir (real prompts live only in untracked files).
function promptsFile() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mx-ai-')), 'prompts.json');
  fs.writeFileSync(f, JSON.stringify({ assessment: { system: 'TEST SYSTEM', user: 'Visa={{visaType}}\n{{questionnaire}}\n{{materials}}' } }));
  return f;
}
function aiEnv(provider: string, extra: Record<string, string> = {}) {
  return { AI_PROVIDER: provider, AI_MODEL: 'test-model', AI_API_KEY: 'test-key-not-real', AI_PAID_TIER_VERIFIED: 'true', AI_PROMPTS_FILE: promptsFile(), ...extra };
}
function mockFetch(reply: any, status = 200) {
  const calls: { url: string; init: any; body: any }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status < 400, status, headers: { get: (n: string) => (n === 'x-request-id' || n === 'request-id' ? 'req_test' : null) }, json: async () => reply };
  };
  return { f, calls };
}
const PDF = { mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4 synthetic'), filename: 'a.pdf' };
const DOCX = { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: Buffer.from('PK'), filename: 'b.docx' };

test('AI is off by default and enabling it requires the human verification gate', () => {
  assert.equal(loadConfig(testEnv()).ai.provider, 'none');
  assert.throws(() => loadAiConfig(aiEnv('gemini', { AI_PAID_TIER_VERIFIED: '' })), /AI_PAID_TIER_VERIFIED/);
  assert.throws(() => loadAiConfig(aiEnv('gemini', { AI_API_KEY: '' })), /AI_API_KEY/);
  assert.throws(() => loadAiConfig(aiEnv('gemini', { AI_PROMPTS_FILE: '' })), /AI_PROMPTS_FILE/);
  assert.throws(() => loadAiConfig(aiEnv('gemini', { AI_BASE_URL: 'http://insecure' })), /https/);
  assert.throws(() => loadAiConfig(aiEnv('someother')), /AI_PROVIDER/);
});

test('gemini: inline_data only (no Files API), key in header not URL', async () => {
  const { f, calls } = mockFetch({ candidates: [{ content: { parts: [{ text: 'draft' }] } }], responseId: 'r1' });
  const c = new AiClient(loadAiConfig(aiEnv('gemini')), f);
  const r = await c.generate({ system: 's', prompt: 'p', attachments: [PDF, DOCX] });
  assert.equal(r.text, 'draft');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/test-model:generateContent$/);
  assert.ok(!calls[0].url.includes('key='), 'API key must not be in the URL');
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-key-not-real');
  const parts = calls[0].body.contents[0].parts;
  assert.equal(parts.filter((p: any) => p.inline_data).length, 1, 'docx skipped, pdf inlined');
  assert.ok(!JSON.stringify(calls[0].body).includes('file_uri'), 'never references uploaded files');
});

test('openai: store=false, inline file part, bearer auth', async () => {
  const { f, calls } = mockFetch({ choices: [{ message: { content: 'draft' } }] });
  const c = new AiClient(loadAiConfig(aiEnv('openai')), f);
  const r = await c.generate({ system: 's', prompt: 'p', attachments: [PDF] });
  assert.equal(r.text, 'draft'); assert.equal(r.requestId, 'req_test');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key-not-real');
  assert.equal(calls[0].body.messages[1].content[0].type, 'file');
  assert.match(calls[0].body.messages[1].content[0].file.file_data, /^data:application\/pdf;base64,/);
});

test('anthropic: base64 document block, no Files API', async () => {
  const { f, calls } = mockFetch({ content: [{ type: 'text', text: 'draft' }] });
  const c = new AiClient(loadAiConfig(aiEnv('anthropic', { AI_BASE_URL: 'https://proxy.example.test/' })), f);
  await c.generate({ system: 's', prompt: 'p', attachments: [PDF] });
  assert.equal(calls[0].url, 'https://proxy.example.test/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'test-key-not-real');
  assert.equal(calls[0].body.messages[0].content[0].type, 'document');
  assert.equal(calls[0].body.messages[0].content[0].source.type, 'base64');
});

test('provider errors never echo the response body', async () => {
  const { f } = mockFetch({ error: { message: 'echo of SYNTHETIC-PII' } }, 400);
  const c = new AiClient(loadAiConfig(aiEnv('openai')), f);
  await assert.rejects(c.generate({ system: 's', prompt: 'p' }), (e: any) => !String(e.message).includes('SYNTHETIC-PII'));
});

test('fillTemplate', () => {
  assert.equal(fillTemplate('a {{x}} b {{y}}', { x: '1' }), 'a 1 b ');
  // Only own keys: an inherited name used to resolve to a function and land in the prompt.
  for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(fillTemplate(`a {{${k}}} b`, { x: '1' }), 'a  b', `{{${k}}} must not resolve`);
  }
  assert.equal(fillTemplate('{{x}}', { x: '$& $1 $`' }), '$& $1 $`', 'replacement is literal');
});

test('route: lawyer-only, requires visa type, result unapproved and hidden from employee', async () => {
  const { f, calls } = mockFetch({ choices: [{ message: { content: 'AI DRAFT (synthetic)' } }] });
  const { app } = makeApp({ ...aiEnv('openai'), LAWYER_APPROVED_PUBLISH: 'true', PILOT_QUESTIONNAIRE_FILE: '' }, { fetch: f });
  const a = await agents(app);
  await a.employee.post('/api/consent').send({ agree: true });
  const mid = (await a.employee.post('/api/materials').attach('file', Buffer.from('%PDF-1.4 x'), { filename: 'cv.pdf', contentType: 'application/pdf' })).body.id;
  for (const r of ['employee', 'enterprise', 'admin'] as const) assert.equal((await a[r].post('/api/assessment/generate')).status, 403);
  assert.equal((await a.lawyer.post('/api/assessment/generate')).status, 409, 'visa type must be chosen first');
  assert.equal(calls.length, 0);
  await a.lawyer.put('/api/case/visa-type').send({ visaType: 'SYNTHETIC-VISA' });
  const g = await a.lawyer.post('/api/assessment/generate').send({ materialIds: [mid] });
  assert.equal(g.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.messages[1].content.at(-1).text, /Visa=SYNTHETIC-VISA/);
  const la = (await a.lawyer.get('/api/assessment')).body;
  assert.equal(la.source, 'ai'); assert.equal(la.approval, null);
  assert.equal((await a.employee.get('/api/assessment')).status, 404, 'AI output is never shown before lawyer approval');
  await a.lawyer.post('/api/assessment/approve');
  assert.equal((await a.employee.get('/api/assessment')).body.text, 'AI DRAFT (synthetic)');
  const log = JSON.stringify((await a.lawyer.get('/api/access-log')).body);
  assert.match(log, /ai\.assessment\.generate/);
  assert.ok(!log.includes('AI DRAFT'), 'AI output not in access log');
});

test('route: 503 when AI disabled', async () => {
  const { app } = makeApp();
  const a = await agents(app);
  assert.equal((await a.lawyer.post('/api/assessment/generate')).status, 503);
});

test('generate: a material whose blob cannot be read is reported, never a crash or a hang', async () => {
  // Express 4 ignores a rejected promise from an async handler, so a throwing store used to
  // hang the request and bring the process down with an unhandled rejection.
  const { f, calls } = mockFetch({ choices: [{ message: { content: 'AI DRAFT (synthetic)' } }] });
  const { cfg } = makeApp(aiEnv('openai'));
  const good = Buffer.from('%PDF-1.4 readable');
  const store = new EncryptedFileStore(cfg.dataDir, new Cipher(cfg.encryptionKey));
  const app = createApp(cfg, { fetch: f, store });
  const a = await agents(app);
  await a.employee.post('/api/consent').send({ agree: true });
  const ok = (await a.employee.post('/api/materials').attach('file', good, { filename: 'ok.pdf', contentType: 'application/pdf' })).body.id;
  const bad = (await a.employee.post('/api/materials').attach('file', good, { filename: 'bad.pdf', contentType: 'application/pdf' })).body.id;
  await a.lawyer.put('/api/case/visa-type').send({ visaType: 'SYNTHETIC-VISA' });

  // Corrupt one blob on disk, exactly as a rotated key or a damaged disk would: decrypt throws.
  const blob = path.join(cfg.dataDir, 'blobs', bad);
  const ct = fs.readFileSync(blob); ct[ct.length - 1] ^= 0xff; fs.writeFileSync(blob, ct);
  assert.throws(() => store.getBlob(bad), /authenticate|decrypt/i, 'fixture really is undecryptable');

  const g = await a.lawyer.post('/api/assessment/generate').send({ materialIds: [ok, bad] });
  assert.equal(g.status, 200, 'the readable material is still assessed');
  assert.deepEqual(g.body.unreadableMaterialIds, [bad], 'the lawyer is told which file to review by hand');
  assert.equal(calls.length, 1);
  const parts = calls[0].body.messages[1].content;
  assert.equal(parts.filter((x: any) => x.type === 'file').length, 1, 'only the readable file is sent on');

  // A store that fails mid-request answers 500 from the error handler instead of hanging.
  let armed = false;
  const flaky: Store = {
    read: () => { if (armed) throw new Error('state unreadable'); return store.read(); },
    update: m => store.update(m),
    putBlob: (i, d) => store.putBlob(i, d),
    getBlob: i => store.getBlob(i),
    deleteBlob: i => store.deleteBlob(i),
  };
  const b = await agents(createApp(cfg, { fetch: f, store: flaky }));
  armed = true;
  assert.equal((await b.lawyer.post('/api/assessment/generate').send({})).status, 500);
});

test('AI numeric env vars are validated, never silently NaN', () => {
  // setTimeout(abort, NaN) fires immediately, which aborted every request as it was sent.
  assert.throws(() => loadAiConfig(aiEnv('openai', { AI_TIMEOUT_MS: '30s' }) as any), /AI_TIMEOUT_MS/);
  assert.throws(() => loadAiConfig(aiEnv('openai', { AI_TIMEOUT_MS: '0' }) as any), /AI_TIMEOUT_MS/);
  assert.throws(() => loadAiConfig(aiEnv('openai', { AI_MAX_OUTPUT_TOKENS: 'lots' }) as any), /AI_MAX_OUTPUT_TOKENS/);
  assert.throws(() => loadAiConfig(aiEnv('openai', { AI_MAX_OUTPUT_TOKENS: '-1' }) as any), /AI_MAX_OUTPUT_TOKENS/);
  const ok = loadAiConfig(aiEnv('openai', { AI_TIMEOUT_MS: '5000', AI_MAX_OUTPUT_TOKENS: '2048' }) as any);
  assert.equal(ok.timeoutMs, 5000); assert.equal(ok.maxOutputTokens, 2048);
  const dflt = loadAiConfig(aiEnv('openai') as any);
  assert.equal(dflt.timeoutMs, 120000); assert.equal(dflt.maxOutputTokens, 4096);
});

test('generate: when every selected material is unreadable, nothing is sent to the vendor (409)', async () => {
  const { f, calls } = mockFetch({ choices: [{ message: { content: 'AI DRAFT (synthetic)' } }] });
  const { cfg } = makeApp(aiEnv('openai'));
  const store = new EncryptedFileStore(cfg.dataDir, new Cipher(cfg.encryptionKey));
  const a = await agents(createApp(cfg, { fetch: f, store }));
  await a.employee.post('/api/consent').send({ agree: true });
  const bad = (await a.employee.post('/api/materials').attach('file', Buffer.from('%PDF-1.4 x'), { filename: 'bad.pdf', contentType: 'application/pdf' })).body.id;
  await a.lawyer.put('/api/case/visa-type').send({ visaType: 'SYNTHETIC-VISA' });
  const blob = path.join(cfg.dataDir, 'blobs', bad);
  const ct = fs.readFileSync(blob); ct[ct.length - 1] ^= 0xff; fs.writeFileSync(blob, ct);

  const g = await a.lawyer.post('/api/assessment/generate').send({ materialIds: [bad] });
  assert.equal(g.status, 409);
  assert.deepEqual(g.body.unreadableMaterialIds, [bad]);
  assert.equal(calls.length, 0, 'the vendor is never called with none of the chosen evidence');
  assert.equal((await a.lawyer.get('/api/assessment')).body, null, 'no draft was written');
  assert.match(JSON.stringify((await a.lawyer.get('/api/access-log')).body), /"action":"ai\.assessment\.generate","resource":"unreadable-materials=1","outcome":"denied"/);

  // Choosing no materials at all is a different thing and still allowed (questionnaire only).
  const none = await a.lawyer.post('/api/assessment/generate').send({ materialIds: [] });
  assert.equal(none.status, 200);
  assert.equal(calls.length, 1);
});

test('generate: the disclosure is logged before the draft is saved', async () => {
  // Once ai.generate returns, the case files have already reached the vendor. If persisting
  // the draft then fails, the access log must still record that they went out.
  const { f, calls } = mockFetch({ choices: [{ message: { content: 'AI DRAFT (synthetic)' } }] });
  const { cfg } = makeApp(aiEnv('openai'));
  const inner = new EncryptedFileStore(cfg.dataDir, new Cipher(cfg.encryptionKey));
  let failWrites = false;
  const store: Store = {
    read: () => inner.read(),
    update: m => { if (failWrites) throw new Error('disk full'); return inner.update(m); },
    putBlob: (i, d) => inner.putBlob(i, d),
    getBlob: i => inner.getBlob(i),
    deleteBlob: i => inner.deleteBlob(i),
  };
  const a = await agents(createApp(cfg, { fetch: f, store }));
  await a.lawyer.put('/api/case/visa-type').send({ visaType: 'SYNTHETIC-VISA' });

  failWrites = true;
  const g = await a.lawyer.post('/api/assessment/generate').send({});
  assert.equal(g.status, 500, 'the lawyer is told the save failed');
  assert.equal(calls.length, 1, 'the request did reach the vendor');

  failWrites = false;
  const log = (await a.lawyer.get('/api/access-log')).body;
  const sent = log.filter((e: any) => e.action === 'ai.assessment.generate');
  assert.equal(sent.length, 1, 'the disclosure is on record despite the failed save');
  assert.equal(sent[0].outcome, 'ok');
  assert.equal((await a.lawyer.get('/api/assessment')).body, null, 'and no draft was persisted');
});
