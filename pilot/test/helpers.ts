import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
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
    PILOT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    ...extra,
  };
}

export function makeApp(extra: Record<string, string> = {}) {
  const cfg: PilotConfig = loadConfig(testEnv(extra));
  return { cfg, app: createApp(cfg) };
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
