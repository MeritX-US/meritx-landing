import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Cipher } from './crypto';
import { EncryptedFileStore, type CaseStatus } from './store';

interface EnterpriseRequest {
  by: string;
  email: string;
  summary: string;
  decision: 'pending' | 'accepted' | 'returned';
  note?: string;
}

export interface DraftMatter {
  id: string; label: string; status: CaseStatus;
  updatedAt?: string;
  invitation?: { employeeId: string; accepted: boolean };
  request?: EnterpriseRequest;
}

// One encrypted register per lawyer. Synchronous read-modify-write for the single pilot process.
export class DraftRegister {
  private cipher: Cipher;
  constructor(private dir: string, private key: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.cipher = new Cipher(key);
  }
  private file(owner: string) {
    return path.join(this.dir, crypto.createHash('sha256').update(owner).digest('hex') + '.enc');
  }
  list(owner: string): DraftMatter[] {
    const file = this.file(owner);
    if (!fs.existsSync(file)) return [];
    return JSON.parse(this.cipher.decrypt(fs.readFileSync(file), 'drafts|' + owner).toString('utf8'));
  }
  private save(owner: string, rows: DraftMatter[]) {
    const file = this.file(owner);
    const tmp = file + '.' + crypto.randomUUID();
    try {
      fs.writeFileSync(tmp, this.cipher.encrypt(Buffer.from(JSON.stringify(rows)), 'drafts|' + owner), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  create(owner: string, label: string) {
    const row: DraftMatter = { id: crypto.randomUUID(), label, status: 'intake' };
    this.save(owner, [...this.list(owner), row]);
    return row;
  }
  submit(owner: string, label: string, request: Omit<EnterpriseRequest, 'decision'>, id?: string) {
    const rows = this.list(owner);
    const row = id ? rows.find(entry => entry.id === id) : undefined;
    if (id && (!row || row.request?.by !== request.by)) return 'missing';
    if (row && row.request?.decision !== 'returned') return 'conflict';
    const fields = { label, updatedAt: new Date().toISOString(), request: { ...request, decision: 'pending' as const } };
    if (row) Object.assign(row, fields);
    const saved = row ?? { id: crypto.randomUUID(), status: 'invited' as const, ...fields };
    if (!row) rows.push(saved);
    this.save(owner, rows);
    return saved;
  }
  decide(owner: string, id: string, decision: 'accepted' | 'returned', note?: string) {
    const rows = this.list(owner);
    const row = rows.find(entry => entry.id === id);
    if (!row?.request) return 'missing';
    if (row.request.decision !== 'pending') return 'conflict';
    row.request.decision = decision;
    row.request.note = note;
    row.updatedAt = new Date().toISOString();
    this.save(owner, rows);
    return row;
  }
  invite(owner: string, id: string, employeeId: string) {
    const rows = this.list(owner);
    const row = rows.find(r => r.id === id);
    if (!row) return 'missing';
    if (row.request && row.request.decision !== 'accepted') return 'pending';
    if (row.invitation) return row.invitation.employeeId === employeeId ? row.invitation : 'assigned';
    row.invitation = { employeeId, accepted: false };
    row.updatedAt = new Date().toISOString();
    this.save(owner, rows);
    return row.invitation;
  }
  accept(owner: string, id: string, employeeId: string) {
    const rows = this.list(owner);
    const row = rows.find(r => r.id === id);
    if (!row?.invitation || row.invitation.employeeId !== employeeId) return false;
    if (row.invitation.accepted) return true;
    row.invitation.accepted = true;
    row.updatedAt = new Date().toISOString();
    this.save(owner, rows);
    return true;
  }
  private intakeDir(row: DraftMatter) { return path.join(this.dir, 'intake', row.id); }
  intakeStore(row: DraftMatter) {
    const key = crypto.createHmac('sha256', Buffer.from(this.key, 'base64')).update('matter-intake|' + row.id).digest('base64');
    return new EncryptedFileStore(this.intakeDir(row), new Cipher(key));
  }
  submissionTime(row: DraftMatter) {
    if (!row.invitation?.accepted || !fs.existsSync(path.join(this.intakeDir(row), 'state.enc'))) return null;
    const state = this.intakeStore(row).read();
    return state.questionnaire.ownerId === row.invitation.employeeId ? state.questionnaire.submittedAt : null;
  }
  setStatus(owner: string, id: string, status: CaseStatus) {
    const rows = this.list(owner);
    const row = rows.find(r => r.id === id);
    if (!row) return undefined;
    if (row.request && row.request.decision !== 'accepted') return undefined;
    row.status = status;
    if (row.request) row.updatedAt = new Date().toISOString();
    this.save(owner, rows);
    return row;
  }
}
