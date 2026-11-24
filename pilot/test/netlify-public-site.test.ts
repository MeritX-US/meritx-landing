import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { parse } from 'smol-toml';

// The public landing site (Netlify, publish = ".") must never serve the private pilot.
const toml = parse(fs.readFileSync(path.join(__dirname, '..', '..', 'netlify.toml'), 'utf8')) as any;

test('netlify.toml blocks /pilot and /pilot/* with a forced 404', () => {
  const rules: any[] = toml.redirects || [];
  for (const from of ['/pilot', '/pilot/*']) {
    const r = rules.find(x => x.from === from);
    assert.ok(r, `missing redirect rule for ${from}`);
    assert.equal(r.status, 404, `${from} must be 404`);
    assert.equal(r.force, true, `${from} must be forced (shadow existing files)`);
  }
});

test('the block rules come before any other redirect (first match wins)', () => {
  const rules: any[] = toml.redirects || [];
  const firstOther = rules.findIndex(x => !String(x.from).startsWith('/pilot'));
  const lastPilot = rules.map(x => String(x.from).startsWith('/pilot')).lastIndexOf(true);
  assert.ok(firstOther === -1 || lastPilot < firstOther);
});

test('public site build settings unchanged', () => {
  assert.equal(toml.build.publish, '.');
  assert.match(toml.build.command, /app\/client/);
});

test('workspace handoff is generated only for a configured HTTPS workspace origin', t => {
  const repo = path.join(__dirname, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-workspace-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  const script = path.join(dir, 'scripts', 'configure-workspace.mjs');
  fs.copyFileSync(path.join(repo, 'scripts', 'configure-workspace.mjs'), script);
  const run = (url: string) => execFileSync(process.execPath, [script], {
    env: { ...process.env, MERITX_WORKSPACE_URL: url }, stdio: 'pipe',
  });
  const rules = () => fs.readFileSync(path.join(dir, '_redirects'), 'utf8');
  run('');
  assert.doesNotMatch(rules(), /^\/workspace/m);
  assert.match(fs.readFileSync(path.join(repo, 'workspace', 'index.html'), 'utf8'), /Use the private sign-in link/);
  run('https://workspace.example.test/');
  assert.match(rules(), /^\/workspace\/  https:\/\/workspace\.example\.test\/  302!$/m);
  for (const invalid of ['http://workspace.example.test', 'https://meritx.us', 'https://workspace.example.test/?token=x'])
    assert.throws(() => run(invalid), /separate workspace HTTPS origin/);
});
