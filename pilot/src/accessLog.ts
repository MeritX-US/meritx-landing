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
 * recorded elsewhere. Every append prints {event:'access_log_anchor', seq, entries, hash}
 * to stdout (Render keeps its logs off the data disk), and verify(anchor) checks the chain
 * against such a recorded seq+hash.
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

/** A head hash recorded outside the data disk (Render log line, daily email, lawyer's notes). */
export interface Anchor { seq: number; hash: string }

export interface ChainVerification {
  ok: boolean; entries: number; head: string; brokenAt?: number; reason?: string;
  /** Present when verify() was given an external anchor. */
  anchor?: { seq: number; hash: string; match: boolean; reason?: string };
}

/** One row of GET /api/access-log: a readable entry, or a marker for a line that failed integrity checks. */
export type AccessListItem =
  | (AccessEntry & { line: number; corrupted_or_tampered?: false })
  | { line: number; corrupted_or_tampered: true; reason: string; seq?: number; ts?: string };

/** Structured stdout line emitted after every append: the external anchor copy (no PII). */
export interface AnchorEvent { event: 'access_log_anchor'; seq: number; entries: number; hash: string }
export type AnchorSink = (a: AnchorEvent) => void;
export const stdoutAnchorSink: AnchorSink = a => { process.stdout.write(JSON.stringify(a) + '\n'); };

export function parseAnchor(raw: { seq?: unknown; hash?: unknown }): Anchor | null {
  const seq = typeof raw.seq === 'number' ? raw.seq : Number(raw.seq);
  const hash = String(raw.hash ?? '').trim().toLowerCase();
  if (!Number.isInteger(seq) || seq < 0 || !/^[0-9a-f]{64}$/.test(hash)) return null;
  return { seq, hash };
}

export interface AccessLogOptions {
  /** Called after every append with {seq, entries, hash}. Default: one JSON line on stdout. null = off. */
  anchorSink?: AnchorSink | null;
}

export class AccessLog {
  private file: string;
  private head = GENESIS_HASH;
  private seq = 0;
  private sink: AnchorSink | null;
  /** With a cipher, each line is individually AES-GCM encrypted (base64), so the log is encrypted at rest too. */
  constructor(dataDir: string, private cipher?: Cipher, opts: AccessLogOptions = {}) {
    this.sink = opts.anchorSink === undefined ? stdoutAnchorSink : opts.anchorSink;
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
    // Second copy of the head, outside the data disk (e.g. Render's log store). Only seq/count/hash.
    if (this.sink) {
      try { this.sink(this.anchor()); } catch { /* never let anchoring break the request */ }
    }
  }
  /** Current head: seq of the last entry, number of entries, and its hash. */
  anchor(): AnchorEvent {
    return { event: 'access_log_anchor', seq: this.seq - 1, entries: this.seq, hash: this.head };
  }
  private parse(l: string): AccessEntry {
    const e = JSON.parse(this.cipher ? this.cipher.decrypt(Buffer.from(l, 'base64'), 'accesslog').toString('utf8') : l);
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('not an entry');
    return e;
  }
  private lines(): string[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
  }
  /**
   * Last `limit` lines. Never throws on a bad line: an undecryptable/unparseable line, or one whose
   * own hash or link to the previous line doesn't check out, is returned as
   * {line, corrupted_or_tampered: true, reason} (1-based line number) and the rest are returned as normal.
   */
  list(limit = 500): AccessListItem[] {
    const lines = this.lines();
    const out: AccessListItem[] = [];
    // Link checks are against the previous line only, so one deleted/edited line flags one or two
    // rows, not everything after it. null = previous line unreadable, link can't be checked.
    let prev: { seq: number; hash: string } | null = { seq: -1, hash: GENESIS_HASH };
    for (let i = 0; i < lines.length; i++) {
      const line = i + 1;
      let e: AccessEntry;
      try { e = this.parse(lines[i]); } catch {
        out.push({ line, corrupted_or_tampered: true, reason: 'unreadable line' }); prev = null; continue;
      }
      let reason: string | null = null;
      if (typeof e.hash !== 'string' || typeof e.seq !== 'number' || entryHash(String(e.prev), e) !== e.hash) reason = 'entry hash mismatch';
      else if (prev !== null && e.seq !== prev.seq + 1) reason = 'sequence gap or reorder';
      else if (prev !== null && e.prev !== prev.hash) reason = 'prev hash mismatch';
      if (reason) out.push({ line, corrupted_or_tampered: true, reason, seq: typeof e.seq === 'number' ? e.seq : undefined, ts: typeof e.ts === 'string' ? e.ts : undefined });
      else out.push({ ...e, line });
      prev = typeof e.hash === 'string' && typeof e.seq === 'number' ? { seq: e.seq, hash: e.hash } : null;
    }
    return out.slice(-limit);
  }
  /**
   * Walk the whole chain. Any undecryptable, edited, missing, inserted or reordered line => ok:false.
   * With an anchor (seq+hash recorded off-disk), also require that the entry at anchor.seq exists and
   * has exactly that hash -- this is what catches truncation of the tail or a rewritten chain.
   */
  verify(anchor?: Anchor): ChainVerification {
    const lines = this.lines();
    const r = this.walk(lines);
    if (!anchor) return r;
    let match = false, reason: string | undefined;
    if (anchor.seq >= lines.length) reason = `log has ${lines.length} entries; anchor seq ${anchor.seq} missing (truncated or replaced)`;
    else if (r.brokenAt !== undefined && r.brokenAt <= anchor.seq) reason = `chain broken at seq ${r.brokenAt}, before the anchor`;
    else {
      const h = this.hashAt(lines, anchor.seq);
      match = h === anchor.hash;
      if (!match) reason = 'hash at anchor seq differs from anchor (chain rewritten)';
    }
    return { ...r, ok: r.ok && match, anchor: { seq: anchor.seq, hash: anchor.hash, match, ...(reason ? { reason } : {}) } };
  }
  private hashAt(lines: string[], seq: number): string | undefined {
    try { return this.parse(lines[seq]).hash; } catch { return undefined; }
  }
  private walk(lines: string[]): ChainVerification {
    let prev = GENESIS_HASH, i = 0;
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
