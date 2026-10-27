import fs from 'fs';
import path from 'path';

/**
 * Pilot configuration. Everything sensitive comes from environment variables
 * (or a file under a secrets directory referenced by env). Nothing real is
 * ever committed: see .env.example for the shape.
 */

export type Role = 'employee' | 'lawyer' | 'enterprise' | 'admin';
export const ROLES: readonly Role[] = ['employee', 'lawyer', 'enterprise', 'admin'] as const;

export interface Account {
  id: string;            // stable, non-PII id, e.g. "employee"
  email: string;         // lowercased login email (from env only)
  name: string;          // display name (lawyer's name is shown on approved assessments)
  role: Role;
  passwordHash: string;  // scrypt$N$r$p$salt$hash (see scripts/hash-password.ts)
  enabled: boolean;      // optional "enabled": false in config disables login without removing the entry
}

export interface PilotConfig {
  accounts: Account[];
  maxAccounts: number;            // PILOT_MAX_ACCOUNTS (default 4)
  sessionSecret: Buffer;
  sessionTtlSeconds: number;
  dataDir: string;
  allowedOrigins: string[];       // strict CORS allowlist; empty = same-origin only
  lawyerApprovedPublish: boolean; // LAWYER_APPROVED_PUBLISH feature flag (default off)
  secureCookies: boolean;
  trustProxy: boolean;
  maxUploadBytes: number;
  questions: { id: string; text: string }[]; // questionnaire prompts, from untracked config
}

export class ConfigError extends Error {}

/** Default cap on allowlisted accounts (PILOT_MAX_ACCOUNTS). 1 employee + 1 lawyer + 1 enterprise + >=1 admin. */
export const DEFAULT_MAX_ACCOUNTS = 4;
/** Roles that must have exactly one account in a single-case pilot. */
export const SINGLETON_ROLES: readonly Role[] = ['employee', 'lawyer', 'enterprise'];

function parseBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

/**
 * Integer env var with an inclusive range. A malformed value is a startup error, never a
 * silent NaN: NaN propagates into cookie Max-Age, multer's fileSize limit and setTimeout,
 * where it breaks login sessions and uploads without any error anyone can see.
 */
export function parseIntEnv(v: string | undefined, name: string, dflt: number, min: number, max: number): number {
  if (v === undefined || v.trim() === '') return dflt;
  const raw = v.trim();
  // Plain decimal digits only. Number() would also accept 0x10, 1e3, 0b11 and 0o17 as
  // integers, so a value meant literally would quietly become a different number.
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${v}")`);
  }
  return n;
}

export function parseAccounts(raw: string, maxAccounts = DEFAULT_MAX_ACCOUNTS): Account[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('PILOT_ACCOUNTS is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new ConfigError('PILOT_ACCOUNTS must be a JSON array');
  if (parsed.length > maxAccounts) {
    throw new ConfigError(`PILOT_ACCOUNTS has ${parsed.length} accounts; at most PILOT_MAX_ACCOUNTS=${maxAccounts} allowed`);
  }
  const accounts: Account[] = parsed.map((a: any, i: number) => {
    for (const k of ['id', 'email', 'name', 'role', 'passwordHash']) {
      if (typeof a?.[k] !== 'string' || a[k].trim() === '') {
        throw new ConfigError(`PILOT_ACCOUNTS[${i}].${k} is required`);
      }
    }
    if (!ROLES.includes(a.role)) throw new ConfigError(`PILOT_ACCOUNTS[${i}].role is invalid`);
    if (!/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(a.passwordHash)) {
      throw new ConfigError(`PILOT_ACCOUNTS[${i}].passwordHash must be a scrypt hash (run npm run hash-password)`);
    }
    if (a.enabled !== undefined && typeof a.enabled !== 'boolean') throw new ConfigError(`PILOT_ACCOUNTS[${i}].enabled must be a boolean`);
    return { id: a.id.trim(), email: a.email.trim().toLowerCase(), name: a.name.trim(), role: a.role, passwordHash: a.passwordHash, enabled: a.enabled !== false };
  });
  const ids = new Set(accounts.map(a => a.id));
  const emails = new Set(accounts.map(a => a.email));
  if (ids.size !== accounts.length) throw new ConfigError('PILOT_ACCOUNTS ids must be unique');
  if (emails.size !== accounts.length) throw new ConfigError('PILOT_ACCOUNTS emails must be unique');
  // Single case: exactly one employee, one partner lawyer, one enterprise contact; one or more MeritX admins.
  for (const r of SINGLETON_ROLES) {
    const n = accounts.filter(a => a.role === r).length;
    if (n !== 1) throw new ConfigError(`PILOT_ACCOUNTS must contain exactly one "${r}" account (got ${n})`);
  }
  if (!accounts.some(a => a.role === 'admin')) throw new ConfigError('PILOT_ACCOUNTS must contain at least one "admin" account');
  return accounts;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PilotConfig {
  // Hard gate: this app only ever runs as the private pilot. The repo is public, so
  // nothing private lives in it; all private config comes from env / untracked files.
  if (env.PRIVATE_MODE !== 'true') {
    throw new ConfigError('PRIVATE_MODE=true is required to start the private pilot');
  }
  let rawAccounts = env.PILOT_ACCOUNTS;
  if (!rawAccounts && env.PILOT_ACCOUNTS_FILE) {
    rawAccounts = fs.readFileSync(env.PILOT_ACCOUNTS_FILE, 'utf8');
  }
  if (!rawAccounts) throw new ConfigError('PILOT_ACCOUNTS (or PILOT_ACCOUNTS_FILE) is required');
  const maxAccounts = parseIntEnv(env.PILOT_MAX_ACCOUNTS, 'PILOT_MAX_ACCOUNTS', DEFAULT_MAX_ACCOUNTS, 4, 10);
  const accounts = parseAccounts(rawAccounts, maxAccounts);

  const secret = env.SESSION_SECRET || '';
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new ConfigError('SESSION_SECRET must be set and at least 32 bytes (e.g. openssl rand -base64 48)');
  }

  const dataDir = path.resolve(env.PILOT_DATA_DIR || path.join(process.cwd(), 'data'));
  for (const p of [path.resolve(__dirname, '..', 'public'), path.resolve(__dirname, '..', '..', 'public')]) {
    if (dataDir === p || dataDir.startsWith(p + path.sep)) {
      throw new ConfigError('PILOT_DATA_DIR must not be inside the static public directory');
    }
  }

  const allowedOrigins = (env.PILOT_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allowedOrigins.includes('*')) throw new ConfigError('PILOT_ALLOWED_ORIGINS must not contain "*"');

  const isProd = env.NODE_ENV === 'production';
  return {
    accounts,
    maxAccounts,
    sessionSecret: Buffer.from(secret, 'utf8'),
    sessionTtlSeconds: parseIntEnv(env.SESSION_TTL_SECONDS, 'SESSION_TTL_SECONDS', 8 * 3600, 60, 7 * 24 * 3600),
    dataDir,
    allowedOrigins,
    lawyerApprovedPublish: parseBool(env.LAWYER_APPROVED_PUBLISH, false),
    secureCookies: parseBool(env.SECURE_COOKIES, isProd),
    trustProxy: parseBool(env.TRUST_PROXY, isProd),
    maxUploadBytes: parseIntEnv(env.MAX_UPLOAD_BYTES, 'MAX_UPLOAD_BYTES', 25 * 1024 * 1024, 1, 200 * 1024 * 1024),
    questions: loadQuestions(env),
  };
}

/** Questionnaire prompts are loaded from an untracked JSON file; a generic placeholder is used otherwise. */
export function loadQuestions(env: NodeJS.ProcessEnv): { id: string; text: string }[] {
  const file = env.PILOT_QUESTIONNAIRE_FILE;
  if (!file) return [{ id: 'notes', text: 'Anything you would like your attorney to know (free text).' }];
  const q = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(q) || !q.every((x: any) => typeof x?.id === 'string' && typeof x?.text === 'string')) {
    throw new ConfigError('PILOT_QUESTIONNAIRE_FILE must be a JSON array of {id, text}');
  }
  return q;
}

/** Static UI dir: pilot/public both when run from src/ (tsx) and from dist/src/ (compiled). */
export function publicDir(): string {
  const candidates = [path.resolve(__dirname, '..', 'public'), path.resolve(__dirname, '..', '..', 'public')];
  return candidates.find(p => fs.existsSync(path.join(p, 'index.html'))) || candidates[0];
}
