import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config';
import { testEnv, accountsJson, admin2Account } from './helpers';

test('refuses to start without PRIVATE_MODE=true', () => {
  assert.throws(() => loadConfig(testEnv({ PRIVATE_MODE: '' })), ConfigError);
  assert.throws(() => loadConfig(testEnv({ PRIVATE_MODE: 'false' })), ConfigError);
});

test('account cap is configurable via PILOT_MAX_ACCOUNTS (default 4)', () => {
  const four = JSON.parse(accountsJson());
  const five = [...four, admin2Account()];
  assert.equal(loadConfig(testEnv()).maxAccounts, 4);
  assert.equal(loadConfig(testEnv()).accounts.length, 4);
  assert.throws(() => loadConfig(testEnv({ PILOT_ACCOUNTS: JSON.stringify(five) })), /at most PILOT_MAX_ACCOUNTS=4/);
  const cfg = loadConfig(testEnv({ PILOT_ACCOUNTS: JSON.stringify(five), PILOT_MAX_ACCOUNTS: '5' }));
  assert.equal(cfg.accounts.filter(x => x.role === 'admin').length, 2, 'more than one admin allowed');
  for (const bad of ['3', '11', 'x', '4.5']) {
    assert.throws(() => loadConfig(testEnv({ PILOT_MAX_ACCOUNTS: bad })), /PILOT_MAX_ACCOUNTS/);
  }
});

test('exactly one employee, one lawyer, one enterprise; at least one admin', () => {
  const base = JSON.parse(accountsJson());
  for (const role of ['employee', 'lawyer', 'enterprise']) {
    const dup = [...base, { ...admin2Account(), role }];
    assert.throws(() => loadConfig(testEnv({ PILOT_ACCOUNTS: JSON.stringify(dup), PILOT_MAX_ACCOUNTS: '5' })), new RegExp(`exactly one "${role}"`));
    const missing = base.filter((x: any) => x.role !== role);
    assert.throws(() => loadConfig(testEnv({ PILOT_ACCOUNTS: JSON.stringify(missing) })), new RegExp(`exactly one "${role}"`));
  }
  const noAdmin = base.filter((x: any) => x.role !== 'admin');
  assert.throws(() => loadConfig(testEnv({ PILOT_ACCOUNTS: JSON.stringify(noAdmin) })), /at least one "admin"/);
});

test('rejects plaintext passwords and duplicate emails', () => {
  const a = JSON.parse(accountsJson());
  a[0].passwordHash = 'hunter2';
  assert.throws(() => loadConfig(testEnv({ PILOT_ACCOUNTS: JSON.stringify(a) })), /scrypt/);
  const b = JSON.parse(accountsJson());
  b[1].email = b[0].email.toUpperCase();
  assert.throws(() => loadConfig(testEnv({ PILOT_ACCOUNTS: JSON.stringify(b) })), /unique/);
});

test('requires a strong SESSION_SECRET', () => {
  assert.throws(() => loadConfig(testEnv({ SESSION_SECRET: 'short' })), /SESSION_SECRET/);
});

test('rejects wildcard CORS origin', () => {
  assert.throws(() => loadConfig(testEnv({ PILOT_ALLOWED_ORIGINS: '*' })), /\*/);
});

test('LAWYER_APPROVED_PUBLISH defaults to off', () => {
  assert.equal(loadConfig(testEnv()).lawyerApprovedPublish, false);
  assert.equal(loadConfig(testEnv({ LAWYER_APPROVED_PUBLISH: 'true' })).lawyerApprovedPublish, true);
});
