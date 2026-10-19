import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Cipher } from './crypto';

/**
 * Access log (pilot item #5). Append-only JSON lines in the private data dir.
 * Records who/when/what action/which resource id -- never file contents,
 * filenames, questionnaire answers, emails, or AI prompts/outputs.
 *
 * Tamper evidence: every entry carries `seq`, `prev` (hash of the previous
 * entry) and `hash` = SHA-256(prev || canonical JSON of the entry). Editing,
 * deleting, inserting or reordering any line breaks the chain and is reported
 * by verify(). Truncating the tail is only detectable against a head hash
 * recorded elsewhere (verify() returns the head so the lawyer can note it).
 */
export interface AccessEntry {
  ts: string;
  actor: string;      // account id (non-PII), or "anonymous"
  role: string;
  action: string;     // e.g. login.success, material.download, assessment.approve
  resource?: string;  // resource id only
  outcome: 'ok' | 'denied' | 'error';
  seq?: number;
  prev?: string;
  hash?: string;
}

export const GENESIS_HASH = '0'.repeat(64);

export function entryHash(prev: string, e: Omit<AccessEntry, 'hash' | 'prev'>): string {
  const body = JSON.stringify([e.seq, e.ts, e.actor, e.role, e.action, e.resource ?? null, e.outcome]);
  return crypto.createHash('sha256').update(prev).update('\n').update(body).digest('hex');
}

export interface ChainVerification { ok: boolean; entries: number; head: string; brokenAt?: number; reason?: string }

export class AccessLog {
  private file: string;
  private head = GENESIS_HASH;
  private seq = 0;
  /** With a cipher, each line is individually AES-GCM encrypted (base64), so the log is encrypted at rest too. */
  constructor(dataDir: string, private cipher?: Cipher) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, cipher ? 'access.log.enc' : 'access.log.jsonl');
    // Resume the chain from the last line. A damaged last line must not stop the app
    // from starting: keep appending (verify() will still report the break).
    const lines = this.lines();
    if (lines.length) {
      try {
        const last = this.parse(lines[lines.length - 1]);
        if (last?.hash && typeof last.seq === 'number') { this.head = last.hash; this.seq = last.seq + 1; }
      } catch {
        this.head = crypto.createHash('sha256').update(lines[lines.length - 1]).digest('hex');
        this.seq = lines.length;
      }
    }
  }
  append(e: Omit<AccessEntry, 'ts' | 'seq' | 'prev' | 'hash'>) {
    const base = { ts: new Date().toISOString(), actor: e.actor, role: e.role, action: e.action, resource: e.resource, outcome: e.outcome, seq: this.seq };
    const hash = entryHash(this.head, base);
    const json = JSON.stringify({ ...base, prev: this.head, hash });
    const line = this.cipher ? this.cipher.encrypt(Buffer.from(json, 'utf8'), 'accesslog').toString('base64') : json;
    fs.appendFileSync(this.file, line + '\n', { mode: 0o600 });
    this.head = hash; this.seq++;
  }
  private parse(l: string): AccessEntry {
    return JSON.parse(this.cipher ? this.cipher.decrypt(Buffer.from(l, 'base64'), 'accesslog').toString('utf8') : l);
  }
  private lines(): string[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
  }
  list(limit = 500): AccessEntry[] {
    return this.lines().slice(-limit).map(l => this.parse(l));
  }
  /** Walk the whole chain. Any undecryptable, edited, missing, inserted or reordered line => ok:false. */
  verify(): ChainVerification {
    let prev = GENESIS_HASH, i = 0;
    const lines = this.lines();
    for (; i < lines.length; i++) {
      let e: AccessEntry;
      try { e = this.parse(lines[i]); } catch { return { ok: false, entries: lines.length, head: prev, brokenAt: i, reason: 'unreadable line' }; }
      if (e.seq !== i) return { ok: false, entries: lines.length, head: prev, brokenAt: i, reason: 'sequence gap or reorder' };
      if (e.prev !== prev) return { ok: false, entries: lines.length, head: prev, brokenAt: i, reason: 'prev hash mismatch' };
      if (entryHash(prev, e) !== e.hash) return { ok: false, entries: lines.length, head: prev, brokenAt: i, reason: 'entry hash mismatch' };
      prev = e.hash!;
    }
    return { ok: true, entries: lines.length, head: prev };
  }
}
