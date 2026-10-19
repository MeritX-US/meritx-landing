import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config';
import { testEnv, accountsJson } from './helpers';

test('refuses to start without PRIVATE_MODE=true', () => {
  assert.throws(() => loadConfig(testEnv({ PRIVATE_MODE: '' })), ConfigError);
  assert.throws(() => loadConfig(testEnv({ PRIVATE_MODE: 'false' })), ConfigError);
});

test('requires exactly 4 accounts', () => {
  const four = JSON.parse(accountsJson());
  assert.throws(() => loadConfig(testEnv({ PILOT_ACCOUNTS: JSON.stringify(four.slice(0, 3)) })), /exactly 4/);
  const five = [...four, { ...four[0], id: 'x', email: 'x@pilot.example.test' }];
  assert.throws(() => loadConfig(testEnv({ PILOT_ACCOUNTS: JSON.stringify(five) })), /exactly 4/);
  assert.equal(loadConfig(testEnv()).accounts.length, 4);
});

test('requires exactly one account per role', () => {
  const a = JSON.parse(accountsJson());
  a[3].role = 'lawyer';
  assert.throws(() => loadConfig(testEnv({ PILOT_ACCOUNTS: JSON.stringify(a) })), /exactly one/);
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
