import fs from 'fs';
import path from 'path';

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
  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, 'access.log.jsonl');
  }
  append(e: Omit<AccessEntry, 'ts'>) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n';
    fs.appendFileSync(this.file, line, { mode: 0o600 });
  }
  list(limit = 500): AccessEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(l));
  }
}
