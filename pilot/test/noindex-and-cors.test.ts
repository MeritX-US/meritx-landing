import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { makeApp, EMAIL, PW } from './helpers';

test('robots.txt disallows everything', async () => {
  const { app } = makeApp();
  const r = await request(app).get('/robots.txt');
  assert.equal(r.status, 200);
  assert.match(r.text, /User-agent: \*\s+Disallow: \//);
  assert.doesNotMatch(r.text, /^Allow:/m);
  assert.doesNotMatch(r.text, /Sitemap/i);
});

test('X-Robots-Tag noindex on every kind of response', async () => {
  const { app } = makeApp();
  for (const p of ['/', '/index.html', '/app.js', '/robots.txt', '/healthz', '/api/case', '/nope', '/sitemap.xml']) {
    const r = await request(app).get(p);
    assert.match(String(r.headers['x-robots-tag']), /noindex/, `${p} missing X-Robots-Tag`);
    assert.match(String(r.headers['x-robots-tag']), /nofollow/);
  }
  const r = await request(app).post('/auth/login').send({});
  assert.match(String(r.headers['x-robots-tag']), /noindex/);
});

test('HTML has meta robots noindex', async () => {
  const { app } = makeApp();
  const r = await request(app).get('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<meta name="robots" content="noindex[^"]*">/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /noindex/);
});

test('no public /uploads static route and no sitemap', async () => {
  const { app } = makeApp();
  assert.equal((await request(app).get('/uploads/anything.pdf')).status, 404);
  assert.equal((await request(app).get('/sitemap.xml')).status, 404);
});

test('security headers present; no X-Powered-By', async () => {
  const { app } = makeApp();
  const r = await request(app).get('/');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(r.headers['x-powered-by'], undefined);
});

test('CORS: never wildcard; foreign origins get no CORS headers and cannot mutate', async () => {
  const { app } = makeApp();
  const g = await request(app).get('/healthz').set('Origin', 'https://evil.example.test');
  assert.equal(g.headers['access-control-allow-origin'], undefined);
  const p = await request(app).post('/auth/login').set('Origin', 'https://evil.example.test').send({ email: EMAIL.lawyer, password: PW.lawyer });
  assert.equal(p.status, 403);
  const o = await request(app).options('/api/case').set('Origin', 'https://evil.example.test').set('Access-Control-Request-Method', 'GET');
  assert.equal(o.status, 403);
});

test('CORS: explicitly allowlisted origin gets exact-match headers', async () => {
  const { app } = makeApp({ PILOT_ALLOWED_ORIGINS: 'https://ui.pilot.example.test' });
  const r = await request(app).get('/healthz').set('Origin', 'https://ui.pilot.example.test');
  assert.equal(r.headers['access-control-allow-origin'], 'https://ui.pilot.example.test');
  assert.equal(r.headers['access-control-allow-credentials'], 'true');
});

test('production behind proxy redirects plain HTTP to HTTPS and sets HSTS', async () => {
  const { app } = makeApp({ NODE_ENV: 'production' });
  const r = await request(app).get('/').set('X-Forwarded-Proto', 'http').set('Host', 'pilot.example.test');
  assert.equal(r.status, 301);
  assert.match(String(r.headers.location), /^https:\/\//);
  const s = await request(app).get('/healthz').set('X-Forwarded-Proto', 'https');
  assert.match(String(s.headers['strict-transport-security']), /max-age=/);
});
