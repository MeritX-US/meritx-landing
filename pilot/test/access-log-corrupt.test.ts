import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AccessLog } from '../src/accessLog';
import { Cipher } from '../src/crypto';
import { makeApp, agents } from './helpers';

const KEY = Buffer.alloc(32, 7).toString('base64'); // test-only constant key
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mx-corrupt-'));
const fill = (l: AccessLog, n: number) => { for (let i = 0; i < n; i++) l.append({ actor: 'a', role: 'lawyer', action: `t.${i}`, outcome: 'ok' }); };
const rd = (p: string) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
const wr = (p: string, lines: string[]) => fs.writeFileSync(p, lines.join('\n') + '\n');

test('list(): corrupted ciphertext line is marked (with line number), all other entries returned', () => {
  const d = dir(); fill(new AccessLog(d, new Cipher(KEY), { anchorSink: null }), 4);
  const p = path.join(d, 'access.log.enc'); const lines = rd(p);
  const b = Buffer.from(lines[1], 'base64'); b[b.length - 1] ^= 1; lines[1] = b.toString('base64');
  wr(p, lines);
  const rows = new AccessLog(d, new Cipher(KEY), { anchorSink: null }).list() as any[];
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], { line: 2, corrupted_or_tampered: true, reason: 'unreadable line' });
  assert.deepEqual([rows[0], rows[2], rows[3]].map(r => [r.line, r.action, r.corrupted_or_tampered]), [[1, 't.0', undefined], [3, 't.2', undefined], [4, 't.3', undefined]]);
});

test('list(): edited plaintext line => that line marked "entry hash mismatch", neighbours fine', () => {
  const d = dir(); fill(new AccessLog(d, undefined, { anchorSink: null }), 3);
  const p = path.join(d, 'access.log.jsonl'); const lines = rd(p);
  const e = JSON.parse(lines[1]); e.action = 'something.else'; lines[1] = JSON.stringify(e);
  wr(p, lines);
  const rows = new AccessLog(d, undefined, { anchorSink: null }).list() as any[];
  assert.deepEqual(rows.map(r => !!r.corrupted_or_tampered), [false, true, false]);
  assert.equal(rows[1].line, 2); assert.equal(rows[1].reason, 'entry hash mismatch'); assert.equal(rows[1].action, undefined);
});

test('list(): a deleted line flags only the line after the gap; garbage / non-object JSON lines flagged', () => {
  const d = dir(); fill(new AccessLog(d, undefined, { anchorSink: null }), 5);
  const p = path.join(d, 'access.log.jsonl'); const lines = rd(p);
  wr(p, [lines[0], lines[1], lines[3], 'not json at all', '42', lines[4]]);
  const rows = new AccessLog(d, undefined, { anchorSink: null }).list() as any[];
  assert.deepEqual(rows.map(r => r.corrupted_or_tampered ? `${r.line}:${r.reason}` : `${r.line}:ok`),
    ['1:ok', '2:ok', '3:sequence gap or reorder', '4:unreadable line', '5:unreadable line', '6:ok']);
  // line 6 follows unreadable lines, so its link can't be checked -- but its own hash is intact.
});

test('list(): an inserted forged entry with a valid-looking shape is flagged', () => {
  const d = dir(); fill(new AccessLog(d, undefined, { anchorSink: null }), 2);
  const p = path.join(d, 'access.log.jsonl'); const lines = rd(p);
  const forged = { ...JSON.parse(lines[1]), action: 'forged' };
  wr(p, [lines[0], JSON.stringify(forged), lines[1]]);
  const rows = new AccessLog(d, undefined, { anchorSink: null }).list() as any[];
  assert.equal(rows[1].corrupted_or_tampered, true);
  assert.equal(rows[2].corrupted_or_tampered, true); // duplicate seq after the forged row
});

test('GET /api/access-log: 200 with a corrupted line; bad line marked, others intact', async () => {
  const { app, cfg } = makeApp();
  const a = await agents(app);
  const p = path.join(cfg.dataDir, 'access.log.enc'); const lines = rd(p);
  lines[2] = 'Zm9yZ2Vk' + lines[2].slice(8); // overwrite part of the ciphertext
  wr(p, lines);
  const r = await a.lawyer.get('/api/access-log');
  assert.equal(r.status, 200);
  const bad = r.body.filter((x: any) => x.corrupted_or_tampered);
  assert.deepEqual(bad, [{ line: 3, corrupted_or_tampered: true, reason: 'unreadable line' }]);
  assert.ok(r.body.filter((x: any) => !x.corrupted_or_tampered).length >= 4);
  assert.ok(r.body.every((x: any) => typeof x.line === 'number'));
  assert.equal((await a.admin.get('/api/access-log')).status, 200);
  const v = await a.lawyer.get('/api/access-log/verify');
  assert.equal(v.body.ok, false); assert.equal(v.body.brokenAt, 2);
});

test('UI: access-log table renders corrupted_or_tampered rows as such (with line number)', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(js, /r\.corrupted_or_tampered/);
  assert.match(js, /CORRUPTED OR TAMPERED/);
  assert.match(js, /line \$\{r\.line\}/);
});
