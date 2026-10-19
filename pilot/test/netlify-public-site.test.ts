import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
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
