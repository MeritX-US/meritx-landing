import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, agents } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n% synthetic\n');

async function setup(extra: Record<string, string> = {}) {
  const { app } = makeApp(extra);
  const a = await agents(app);
  await a.employee.post('/api/consent').send({ agree: true });
  const id = (await a.employee.post('/api/materials').attach('file', PDF, { filename: 'cv.pdf', contentType: 'application/pdf' })).body.id;
  return { app, a, id };
}

test('signed URL works for the issuing account and is short-lived', async () => {
  const { a, id } = await setup();
  const u = await a.employee.post(`/api/materials/${id}/download-url`);
  assert.equal(u.status, 200);
  assert.match(u.body.url, /^\/files\/[a-f0-9-]+\?exp=\d+&sig=/);
  const ttl = (Date.parse(u.body.expiresAt) - Date.now()) / 1000;
  assert.ok(ttl > 0 && ttl <= 61, `ttl ${ttl}`);
  const r = await a.employee.get(u.body.url).buffer(true);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(r.body), PDF);
  assert.match(String(r.headers['content-disposition']), /^attachment/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(String(r.headers['x-robots-tag']), /noindex/);
});

test('signed URL is useless without a session or with another account', async () => {
  const { app, a, id } = await setup();
  const u = (await a.employee.post(`/api/materials/${id}/download-url`)).body.url;
  assert.equal((await request(app).get(u)).status, 401);
  assert.equal((await a.lawyer.get(u)).status, 403, 'bound to the issuing account');
  assert.equal((await a.enterprise.get(u)).status, 403);
});

test('tampered or expired signatures are rejected', async () => {
  const { a, id } = await setup();
  const u: string = (await a.employee.post(`/api/materials/${id}/download-url`)).body.url;
  const exp = Number(new URL(u, 'http://x').searchParams.get('exp'));
  assert.equal((await a.employee.get(u.replace(`exp=${exp}`, `exp=${exp + 1000}`))).status, 403);
  assert.equal((await a.employee.get(u.slice(0, -2) + 'xx')).status, 403);
  const sig = new URL(u, 'http://x').searchParams.get('sig');
  assert.equal((await a.employee.get(`/files/${id}?exp=1&sig=${sig}`)).status, 403);
});

test('expired after TTL', async () => {
  const { a, id } = await setup({ DOWNLOAD_URL_TTL_SECONDS: '1' });
  const u = (await a.employee.post(`/api/materials/${id}/download-url`)).body.url;
  await new Promise(r => setTimeout(r, 2100));
  assert.equal((await a.employee.get(u)).status, 403);
});

test('visibility is re-checked at download time (deleted file => 404)', async () => {
  const { a, id } = await setup();
  const u = (await a.employee.post(`/api/materials/${id}/download-url`)).body.url;
  await a.lawyer.delete(`/api/materials/${id}`);
  assert.equal((await a.employee.get(u)).status, 404);
});

test('employee cannot obtain a URL for a file that is not theirs', async () => {
  const { a } = await setup();
  const lid = (await a.lawyer.post('/api/materials').attach('file', PDF, { filename: 'internal.pdf', contentType: 'application/pdf' })).body.id;
  assert.equal((await a.employee.post(`/api/materials/${lid}/download-url`)).status, 404);
  assert.equal((await a.admin.post(`/api/materials/${lid}/download-url`)).status, 403);
});
