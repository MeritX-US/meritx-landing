import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AccessLog, stdoutAnchorSink, type AnchorEvent, type AccessEntry } from '../src/accessLog';
import { Cipher } from '../src/crypto';
import { loadConfig } from '../src/config';
import { makeApp, agents, testEnv, EMAIL, runCliScript } from './helpers';

const KEY = Buffer.alloc(32, 7).toString('base64'); // test-only constant key
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mx-anchor-'));
const fill = (l: AccessLog, n: number) => { for (let i = 0; i < n; i++) l.append({ actor: 'a', role: 'lawyer', action: `t.${i}`, outcome: 'ok' }); };
const quiet = (d: string) => new AccessLog(d, new Cipher(KEY), { anchorSink: null });

test('anchor: every append emits {event, seq, entries, hash} matching the chain head', () => {
  const got: AnchorEvent[] = [];
  const l = new AccessLog(dir(), new Cipher(KEY), { anchorSink: a => got.push(a) });
  fill(l, 3);
  const e = l.list() as AccessEntry[];
  assert.equal(got.length, 3);
  got.forEach((a, i) => assert.deepEqual(a, { event: 'access_log_anchor', seq: i, entries: i + 1, hash: e[i].hash }));
  assert.deepEqual(l.anchor(), got[2]);
});

test('anchor: default sink writes exactly one JSON line per append to stdout, only seq/entries/hash', () => {
  const lines: string[] = [];
  const orig = process.stdout.write;
  (process.stdout as any).write = (c: any) => { lines.push(String(c)); return true; };
  try {
    const l = new AccessLog(dir(), new Cipher(KEY)); // default = stdout
    l.append({ actor: 'lawyer', role: 'lawyer', action: 'material.download', resource: 'm-1', outcome: 'ok' });
    l.append({ actor: 'anonymous', role: 'none', action: 'login.failure', outcome: 'denied' });
  } finally { (process.stdout as any).write = orig; }
  assert.equal(lines.length, 2);
  for (const raw of lines) {
    assert.ok(raw.endsWith('\n'));
    const o = JSON.parse(raw);
    assert.deepEqual(Object.keys(o).sort(), ['entries', 'event', 'hash', 'seq']);
    assert.equal(o.event, 'access_log_anchor'); assert.match(o.hash, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(raw, /@|lawyer|material|login|m-1/);
  }
  assert.equal(JSON.parse(lines[1]).seq, 1);
  assert.equal(typeof stdoutAnchorSink, 'function');
});

test('anchor: a throwing sink never breaks the append', () => {
  const l = new AccessLog(dir(), undefined, { anchorSink: () => { throw new Error('boom'); } });
  fill(l, 2);
  assert.equal(l.verify().entries, 2);
});

test('anchor: stdout anchoring is on by default in config, can be turned off', () => {
  const env = testEnv(); delete env.PILOT_ACCESS_LOG_ANCHOR_STDOUT;
  assert.equal(loadConfig(env).accessLogAnchorStdout, true);
  assert.equal(loadConfig(testEnv({ PILOT_ACCESS_LOG_ANCHOR_STDOUT: 'false' })).accessLogAnchorStdout, false);
});

test('anchor: app emits one anchor per audited request and none contain an email', async () => {
  const got: AnchorEvent[] = [];
  const { app } = makeApp({}, { anchorSink: a => got.push(a) });
  const a = await agents(app);
  await a.lawyer.get('/api/access-log');
  assert.ok(got.length >= 5); // 4 logins + view
  got.forEach((x, i) => assert.equal(x.seq, i));
  const all = JSON.stringify(got);
  for (const e of Object.values(EMAIL)) assert.ok(!all.includes(e));
  assert.doesNotMatch(all, /@/);
});

test('verify(anchor): matches a recorded anchor, also an older one', () => {
  const d = dir(); const l = quiet(d); fill(l, 5);
  const old = (l.list() as AccessEntry[])[2];
  assert.deepEqual(l.verify({ seq: 4, hash: l.anchor().hash }).anchor, { seq: 4, hash: l.anchor().hash, match: true });
  const v = l.verify({ seq: 2, hash: old.hash! });
  assert.equal(v.ok, true); assert.equal(v.anchor!.match, true);
});

test('verify(anchor): tail truncation is caught (chain alone still looks fine)', () => {
  const d = dir(); const l = quiet(d); fill(l, 5);
  const a = l.anchor();
  const p = path.join(d, 'access.log.enc');
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(p, lines.slice(0, 3).join('\n') + '\n');
  const l2 = quiet(d);
  assert.equal(l2.verify().ok, true); // the remaining prefix is a valid chain
  const v = l2.verify({ seq: a.seq, hash: a.hash });
  assert.equal(v.ok, false); assert.equal(v.anchor!.match, false); assert.match(v.anchor!.reason!, /truncated/);
});

test('verify(anchor): a fully re-generated chain of the same length is caught', () => {
  const d = dir(); const l = quiet(d); fill(l, 3);
  const a = l.anchor();
  fs.rmSync(path.join(d, 'access.log.enc'));
  const l2 = quiet(d); fill(l2, 3); // valid chain, different content/timestamps
  assert.equal(l2.verify().ok, true);
  const v = l2.verify(a);
  assert.equal(v.ok, false); assert.match(v.anchor!.reason!, /rewritten/);
});

test('GET /api/access-log/verify?seq=&hash=: compares against the anchor; 400 on a malformed anchor', async () => {
  const got: AnchorEvent[] = [];
  const { app } = makeApp({}, { anchorSink: a => got.push(a) });
  const a = await agents(app);
  const anc = got[got.length - 1];
  let r = await a.lawyer.get(`/api/access-log/verify?seq=${anc.seq}&hash=${anc.hash}`);
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.anchor.match, true);
  r = await a.admin.get(`/api/access-log/verify?seq=${anc.seq}&hash=${'0'.repeat(64)}`);
  assert.equal(r.status, 200); assert.equal(r.body.ok, false); assert.equal(r.body.anchor.match, false);
  r = await a.lawyer.get('/api/access-log/verify?seq=999&hash=' + anc.hash);
  assert.equal(r.body.ok, false); assert.match(r.body.anchor.reason, /missing/);
  assert.equal((await a.lawyer.get('/api/access-log/verify?seq=x&hash=zz')).status, 400);
  assert.equal((await a.lawyer.get('/api/access-log/verify?seq=1')).status, 400);
  assert.equal((await a.employee.get(`/api/access-log/verify?seq=0&hash=${anc.hash}`)).status, 403);
});

test('CLI verify-access-log: exit 0 on match (--seq/--hash and --anchor line), 1 on truncation, 2 on bad input', () => {
  const d = dir(); const l = quiet(d); fill(l, 4);
  const a = l.anchor();
  const env = { ...process.env, PILOT_ENCRYPTION_KEY: KEY };
  const cli = (args: string[]) => runCliScript('src/scripts/verify-access-log.ts', args, env);
  let out = JSON.parse(cli(['--data-dir', d, '--seq', String(a.seq), '--hash', a.hash]));
  assert.equal(out.ok, true); assert.equal(out.anchor.match, true);
  out = JSON.parse(cli(['--data-dir', d, '--anchor', JSON.stringify(a)]));
  assert.equal(out.anchor.match, true);
  const p = path.join(d, 'access.log.enc');
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(p, lines.slice(0, 2).join('\n') + '\n');
  assert.throws(() => cli(['--data-dir', d, '--seq', String(a.seq), '--hash', a.hash]), (e: any) => e.status === 1);
  assert.throws(() => cli(['--data-dir', d, '--seq', '1', '--hash', 'nothex']), (e: any) => e.status === 2);
});
