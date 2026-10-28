import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { execFileSync } from 'child_process';
import { hashPassword } from '../src/auth';
import { loadConfig, type PilotConfig } from '../src/config';
import { createApp } from '../src/app';

// Synthetic fixtures only. Emails use the reserved .test TLD (RFC 2606); no real people or cases.
export const PW = {
  employee: 'employee-test-password-1',
  lawyer: 'lawyer-test-password-1',
  enterprise: 'enterprise-test-password-1',
  admin: 'admin-test-password-1',
};
export const EMAIL = {
  employee: 'employee@pilot.example.test',
  lawyer: 'lawyer@pilot.example.test',
  enterprise: 'hr@pilot.example.test',
  admin: 'ops@pilot.example.test',
};
export const LAWYER_NAME = 'Test Attorney';

export const PW_ADMIN2 = 'admin2-test-password-1';
export const EMAIL_ADMIN2 = 'ops2@pilot.example.test';
let cachedAdmin2: any = null;
/** A second synthetic admin account (for >1 admin tests). */
export function admin2Account() {
  if (!cachedAdmin2) cachedAdmin2 = { id: 'admin2', email: EMAIL_ADMIN2, name: 'Test Ops 2', role: 'admin', passwordHash: hashPassword(PW_ADMIN2) };
  return cachedAdmin2;
}

let cachedAccounts: string | null = null;
export function accountsJson(): string {
  if (!cachedAccounts) {
    cachedAccounts = JSON.stringify([
      { id: 'employee', email: EMAIL.employee, name: 'Test Employee', role: 'employee', passwordHash: hashPassword(PW.employee) },
      { id: 'lawyer', email: EMAIL.lawyer, name: LAWYER_NAME, role: 'lawyer', passwordHash: hashPassword(PW.lawyer) },
      { id: 'enterprise', email: EMAIL.enterprise, name: 'Test HR', role: 'enterprise', passwordHash: hashPassword(PW.enterprise) },
      { id: 'admin', email: EMAIL.admin, name: 'Test Ops', role: 'admin', passwordHash: hashPassword(PW.admin) },
    ]);
  }
  return cachedAccounts;
}

export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-pilot-test-'));
  return {
    PRIVATE_MODE: 'true',
    PILOT_ACCOUNTS: accountsJson(),
    SESSION_SECRET: 'test-only-session-secret-0123456789abcdef',
    PILOT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), // test-only constant key
    DOWNLOAD_URL_SECRET: 'test-only-download-url-secret-0123456789',
    PILOT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    PILOT_ACCESS_LOG_ANCHOR_STDOUT: 'false', // tests assert on the anchor via an injected sink
    ...extra,
  };
}

export function makeApp(extra: Record<string, string> = {}, deps: Parameters<typeof createApp>[1] = {}) {
  const cfg: PilotConfig = loadConfig(testEnv(extra));
  return { cfg, app: createApp(cfg, deps) };
}

/** Signed-URL download flow: ask for a URL, then fetch it with the same session. */
export async function download(agent: any, id: string) {
  const u = await agent.post(`/api/materials/${id}/download-url`);
  if (u.status !== 200) return u;
  return agent.get(u.body.url).buffer(true);
}

export type RoleName = keyof typeof PW;

export async function loginAs(app: any, role: RoleName) {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ email: EMAIL[role], password: PW[role] });
  if (r.status !== 200) throw new Error(`login ${role} failed: ${r.status}`);
  return agent;
}

export async function agents(app: any) {
  return {
    employee: await loginAs(app, 'employee'),
    lawyer: await loginAs(app, 'lawyer'),
    enterprise: await loginAs(app, 'enterprise'),
    admin: await loginAs(app, 'admin'),
  };
}

/**
 * Run one of the src/scripts CLIs the way a developer would, portably. node_modules/.bin/tsx
 * is a shell shim with no extension on Windows and so cannot be spawned directly; resolving
 * tsx's own entrypoint and running it under this node works on every platform.
 */
export function runCliScript(scriptRelPath: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const script = path.join(__dirname, '..', scriptRelPath);
  return execFileSync(process.execPath, [require.resolve('tsx/cli'), script, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** True when this platform/account can create symlinks (Windows needs Developer Mode or admin). */
export function canSymlink(): boolean {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-symlink-'));
  try {
    fs.writeFileSync(path.join(d, 'target'), 'x');
    fs.symlinkSync(path.join(d, 'target'), path.join(d, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}
