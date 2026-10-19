import crypto from 'crypto';
import { promisify } from 'util';
import type { Request, Response, NextFunction } from 'express';
import type { Account, PilotConfig, Role } from './config';

// ---------- password hashing (scrypt, no external deps) ----------
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const scryptAsync = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

/** Async (libuv threadpool) verification: never blocks the event loop. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const actual = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Global cap on concurrent password verifications. Excess requests wait in a
 * bounded queue; beyond that they are rejected (caller returns 429) so a login
 * flood can't exhaust memory or the threadpool.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(readonly maxActive: number, readonly maxQueue: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T | typeof ConcurrencyLimiter.BUSY> {
    if (this.active >= this.maxActive) {
      if (this.queue.length >= this.maxQueue) return ConcurrencyLimiter.BUSY;
      await new Promise<void>(r => this.queue.push(r));
    }
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
  static readonly BUSY: unique symbol = Symbol('busy');
}

// A dummy hash so that unknown emails cost the same time as known ones.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// ---------- signed session cookie (HMAC-SHA256, stateless) ----------
export const SESSION_COOKIE = 'mx_pilot_session';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function signToken(payload: object, secret: Buffer): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyToken<T = any>(token: string, secret: Buffer): T | null {
  if (typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = fromB64url(mac);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(fromB64url(body).toString('utf8')) as T;
  } catch {
    return null;
  }
}

interface SessionPayload { sub: string; iat: number; exp: number; nonce: string }

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { /* malformed %-encoding: ignore this cookie (=> 401, never 500) */ }
  }
  return out;
}

export interface AuthedRequest extends Request {
  account?: Account;
}

/** Persistence for revoked session nonces (nonce -> exp, unix seconds). */
export interface RevocationStore {
  load(): Record<string, number>;
  save(revoked: Record<string, number>): void;
}

export class Auth {
  private failures = new Map<string, { count: number; first: number }>();
  /** Per-email exponential backoff (NOT a hard lock): count of consecutive failures + time of last one. */
  private backoff = new Map<string, { count: number; last: number }>();
  private revoked: Record<string, number>;
  static readonly MAX_FAILURES = 5;
  static readonly WINDOW_MS = 15 * 60 * 1000;
  static readonly BACKOFF_BASE_MS = 1000;
  static readonly BACKOFF_CAP_MS = 15 * 60 * 1000;
  readonly limiter = new ConcurrencyLimiter(4, 32);
  now: () => number = () => Date.now();

  constructor(private cfg: PilotConfig, private revocations?: RevocationStore) {
    this.revoked = { ...(revocations?.load() || {}) };
  }

  findByEmail(email: string): Account | undefined {
    const e = String(email || '').trim().toLowerCase();
    return this.cfg.accounts.find(a => a.email === e);
  }
  findById(id: string): Account | undefined {
    return this.cfg.accounts.find(a => a.id === id);
  }

  isLockedOut(key: string): boolean {
    const f = this.failures.get(key);
    if (!f) return false;
    if (this.now() - f.first > Auth.WINDOW_MS) { this.failures.delete(key); return false; }
    return f.count >= Auth.MAX_FAILURES;
  }
  recordFailure(key: string) {
    const f = this.failures.get(key);
    if (!f || this.now() - f.first > Auth.WINDOW_MS) this.failures.set(key, { count: 1, first: this.now() });
    else f.count++;
  }
  clearFailures(key: string) { this.failures.delete(key); }

  // ---- per-email exponential backoff: 1s, 2s, 4s ... capped at 15 min ----
  static backoffDelayMs(failures: number): number {
    if (failures <= 0) return 0;
    return Math.min(Auth.BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 30), Auth.BACKOFF_CAP_MS);
  }
  /** ms the email must still wait before another attempt (0 = may try now). */
  emailBackoffRemainingMs(email: string): number {
    const b = this.backoff.get(email);
    if (!b) return 0;
    return Math.max(0, b.last + Auth.backoffDelayMs(b.count) - this.now());
  }
  recordEmailFailure(email: string) {
    const b = this.backoff.get(email);
    this.backoff.set(email, { count: (b?.count || 0) + 1, last: this.now() });
  }
  emailFailureCount(email: string): number { return this.backoff.get(email)?.count || 0; }
  clearEmailBackoff(email: string) { this.backoff.delete(email); }
  /** Admin manual unlock: resets the email's backoff and every IP+email lock for it. */
  unlockEmail(email: string) {
    const e = String(email || '').trim().toLowerCase();
    this.backoff.delete(e);
    for (const k of [...this.failures.keys()]) if (k.endsWith(`|${e}`)) this.failures.delete(k);
  }

  /** Returns the account on success, null on any failure (never says which part was wrong). */
  async login(email: string, password: string): Promise<Account | null> {
    const acct = this.findByEmail(email);
    const ok = await verifyPassword(String(password || ''), acct ? acct.passwordHash : DUMMY_HASH);
    return acct && ok && acct.enabled ? acct : null;
  }

  issueSession(res: Response, acct: Account) {
    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = { sub: acct.id, iat: now, exp: now + this.cfg.sessionTtlSeconds, nonce: crypto.randomBytes(12).toString('hex') };
    const token = signToken(payload, this.cfg.sessionSecret);
    res.setHeader('Set-Cookie', this.cookie(token, this.cfg.sessionTtlSeconds));
  }

  clearSession(req: Request, res: Response) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const p = verifyToken<SessionPayload>(token, this.cfg.sessionSecret);
      if (p?.nonce && typeof p.exp === 'number') this.revoke(p.nonce, p.exp);
    }
    res.setHeader('Set-Cookie', this.cookie('', 0));
  }

  /** Revoke a session nonce and persist it (pruning entries whose token has expired anyway). */
  revoke(nonce: string, exp: number) {
    const nowS = Math.floor(this.now() / 1000);
    for (const [n, e] of Object.entries(this.revoked)) if (e < nowS) delete this.revoked[n];
    this.revoked[nonce] = exp;
    this.revocations?.save({ ...this.revoked });
  }

  private cookie(value: string, maxAge: number): string {
    const name = this.cfg.secureCookies ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
    const attrs = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
    if (this.cfg.secureCookies) attrs.push('Secure');
    return attrs.join('; ');
  }

  /** Resolve the current account from the session cookie; checks expiry, revocation and the live allowlist. */
  resolve(req: Request): Account | null {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[`__Host-${SESSION_COOKIE}`] || cookies[SESSION_COOKIE];
    if (!token) return null;
    const p = verifyToken<SessionPayload>(token, this.cfg.sessionSecret);
    if (!p || typeof p.sub !== 'string' || typeof p.exp !== 'number') return null;
    if (p.exp < Math.floor(this.now() / 1000)) return null;
    if (typeof p.nonce !== 'string' || Object.prototype.hasOwnProperty.call(this.revoked, p.nonce)) return null;
    const acct = this.findById(p.sub);
    return acct && acct.enabled ? acct : null; // removed or disabled => session dead
  }

  /** Middleware: every request under it must be authenticated. */
  requireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const acct = this.resolve(req);
    if (!acct) return res.status(401).json({ error: 'unauthenticated' });
    req.account = acct;
    next();
  };
}

/** Route-level role gate. Always used after requireAuth. */
export function allow(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.account || !roles.includes(req.account.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}
