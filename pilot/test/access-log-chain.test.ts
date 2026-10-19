import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AccessLog, GENESIS_HASH, type AccessEntry } from '../src/accessLog';
import { Cipher } from '../src/crypto';
import { makeApp, agents } from './helpers';

const KEY = Buffer.alloc(32, 7).toString('base64'); // test-only constant key
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mx-chain-'));
const fill = (l: AccessLog, n: number) => { for (let i = 0; i < n; i++) l.append({ actor: 'a', role: 'lawyer', action: `t.${i}`, outcome: 'ok' }); };

for (const encrypted of [false, true]) {
  const mk = (d: string) => new AccessLog(d, encrypted ? new Cipher(KEY) : undefined, { anchorSink: null });
  const label = encrypted ? 'encrypted' : 'plain';

  test(`hash chain links every entry and verifies (${label})`, () => {
    const d = dir(); const l = mk(d); fill(l, 5);
    const e = l.list() as AccessEntry[];
    assert.equal(e[0].prev, GENESIS_HASH);
    for (let i = 1; i < e.length; i++) { assert.equal(e[i].prev, e[i - 1].hash); assert.equal(e[i].seq, i); }
    const v = l.verify();
    assert.equal(v.ok, true); assert.equal(v.entries, 5); assert.equal(v.head, e[4].hash);
  });

  test(`chain continues across restart (${label})`, () => {
    const d = dir(); fill(mk(d), 3);
    const l2 = mk(d); fill(l2, 2);
    assert.equal(l2.verify().ok, true);
    assert.equal((l2.list() as AccessEntry[])[3].seq, 3);
  });

  test(`deleting, reordering or duplicating a line is detected (${label})`, () => {
    const d = dir(); const l = mk(d); fill(l, 4);
    const f = fs.readdirSync(d).find(n => n.startsWith('access.log'))!;
    const p = path.join(d, f);
    const orig = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(p, [orig[0], orig[2], orig[3]].join('\n') + '\n');
    let v = mk(d).verify(); assert.equal(v.ok, false); assert.equal(v.brokenAt, 1);
    fs.writeFileSync(p, [orig[1], orig[0], orig[2], orig[3]].join('\n') + '\n');
    v = mk(d).verify(); assert.equal(v.ok, false); assert.equal(v.brokenAt, 0);
    fs.writeFileSync(p, [orig[0], orig[1], orig[1], orig[2]].join('\n') + '\n');
    assert.equal(mk(d).verify().ok, false);
  });
}

test('editing a field and re-serialising (plaintext log) breaks the hash', () => {
  const d = dir(); const l = new AccessLog(d, undefined, { anchorSink: null }); fill(l, 3);
  const p = path.join(d, 'access.log.jsonl');
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const e = JSON.parse(lines[1]); e.actor = 'someone-else';
  lines[1] = JSON.stringify(e);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  const v = new AccessLog(d, undefined, { anchorSink: null }).verify();
  assert.equal(v.ok, false); assert.equal(v.brokenAt, 1); assert.equal(v.reason, 'entry hash mismatch');
});

test('encrypted log: a corrupted ciphertext line is reported as unreadable', () => {
  const d = dir(); const l = new AccessLog(d, new Cipher(KEY), { anchorSink: null }); fill(l, 2);
  const p = path.join(d, 'access.log.enc');
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const b = Buffer.from(lines[1], 'base64'); b[b.length - 1] ^= 1; lines[1] = b.toString('base64');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  const v = new AccessLog(d, new Cipher(KEY), { anchorSink: null }).verify();
  assert.equal(v.ok, false); assert.equal(v.reason, 'unreadable line');
});

test('GET /api/access-log/verify: lawyer/admin only, reports ok + head', async () => {
  const { app } = makeApp();
  const a = await agents(app);
  const r = await a.lawyer.get('/api/access-log/verify');
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.match(r.body.head, /^[0-9a-f]{64}$/);
  assert.equal((await a.admin.get('/api/access-log/verify')).status, 200);
  assert.equal((await a.employee.get('/api/access-log/verify')).status, 403);
  assert.equal((await a.enterprise.get('/api/access-log/verify')).status, 403);
});
