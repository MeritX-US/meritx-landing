import fs from 'fs';
import path from 'path';
import type { Cipher } from './crypto';

/**
 * Basic access-log STUB (pilot item #5). Append-only JSON lines in the private
 * data dir. Records who/when/what action/which resource id -- never file
 * contents, filenames, questionnaire answers, or AI prompts/outputs.
 *
 * TODO(audit-log, before first real upload): see docs/TODO_audit_log_and_case_destruction.md
 *  - ship to tamper-evident storage (hash chain or write-once bucket)
 *  - include AI vendor call ids, retention + export for the lawyer
 */
export interface AccessEntry {
  ts: string;
  actor: string;      // account id (non-PII), or "anonymous"
  role: string;
  action: string;     // e.g. login.success, material.download, assessment.approve
  resource?: string;  // resource id only
  outcome: 'ok' | 'denied' | 'error';
}

export class AccessLog {
  private file: string;
  /** With a cipher, each line is individually AES-GCM encrypted (base64), so the log is encrypted at rest too. */
  constructor(dataDir: string, private cipher?: Cipher) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, cipher ? 'access.log.enc' : 'access.log.jsonl');
  }
  append(e: Omit<AccessEntry, 'ts'>) {
    const json = JSON.stringify({ ts: new Date().toISOString(), ...e });
    const line = this.cipher ? this.cipher.encrypt(Buffer.from(json, 'utf8'), 'accesslog').toString('base64') : json;
    fs.appendFileSync(this.file, line + '\n', { mode: 0o600 });
  }
  list(limit = 500): AccessEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(this.cipher
      ? this.cipher.decrypt(Buffer.from(l, 'base64'), 'accesslog').toString('utf8')
      : l));
  }
}
