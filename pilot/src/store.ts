import fs from 'fs';
import path from 'path';

/**
 * Single-case data model for the private pilot. One case, one employee,
 * one lawyer, one enterprise contact. No multi-tenant logic on purpose.
 */

export const CASE_STATUSES = [
  'invited',          // accounts created, nothing submitted yet
  'intake',           // employee filling questionnaire / uploading
  'in_review',        // lawyer reviewing
  'documents_needed', // lawyer asked for more materials
  'drafting',         // lawyer drafting
  'filed',            // lawyer filed outside the system
  'closed',           // case closed; destruction pending/done
] as const;
export type CaseStatus = typeof CASE_STATUSES[number];

export interface Material {
  id: string;
  ownerId: string;     // account id of uploader
  filename: string;    // original name (only shown to owner + lawyer)
  mimeType: string;
  size: number;
  uploadedAt: string;
  category: string | null; // lawyer-editable classification
}

export interface Todo { id: string; text: string; createdAt: string; published: boolean }

export interface Assessment {
  text: string;
  source: 'ai' | 'lawyer';
  updatedAt: string;
  approval: { by: string; at: string } | null; // lawyer account id + time
}

export interface PilotState {
  case: {
    status: CaseStatus;
    updatedAt: string;
    visaType: string | null; // set by lawyer only
    visaTypeSetAt: string | null;
  };
  consent: { accountId: string; signedAt: string; version: string } | null;
  questionnaire: { ownerId: string | null; answers: Record<string, string>; updatedAt: string | null; submittedAt: string | null };
  materials: Material[];
  todos: Todo[];
  assessment: Assessment | null;
  /** Logged-out session nonces -> token exp (unix s). Persisted so revocation survives restarts. */
  revokedSessions?: Record<string, number>;
}

export function emptyState(now = new Date().toISOString()): PilotState {
  return {
    case: { status: 'invited', updatedAt: now, visaType: null, visaTypeSetAt: null },
    consent: null,
    questionnaire: { ownerId: null, answers: {}, updatedAt: null, submittedAt: null },
    materials: [],
    todos: [],
    assessment: null,
  };
}

/**
 * Storage boundary. PR1 ships a plaintext file implementation that keeps
 * everything in a private data dir (never served statically). PR2 swaps in
 * an app-level-encrypted implementation behind the same interface.
 */
export interface Store {
  read(): PilotState;
  update(mutator: (s: PilotState) => void): PilotState;
  putBlob(id: string, data: Buffer): void;
  getBlob(id: string): Buffer | null;
  deleteBlob(id: string): void;
}

function writeAtomic(file: string, data: string | Buffer) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const SAFE_ID = /^[a-f0-9-]{8,64}$/;

export class FileStore implements Store {
  private stateFile: string;
  private blobDir: string;

  constructor(private dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.blobDir = path.join(dataDir, 'blobs');
    fs.mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    this.stateFile = path.join(dataDir, 'state.json');
    if (!fs.existsSync(this.stateFile)) writeAtomic(this.stateFile, JSON.stringify(emptyState()));
  }

  read(): PilotState {
    return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as PilotState;
  }

  update(mutator: (s: PilotState) => void): PilotState {
    const s = this.read();
    mutator(s);
    writeAtomic(this.stateFile, JSON.stringify(s));
    return s;
  }

  private blobPath(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error('invalid blob id');
    return path.join(this.blobDir, id);
  }
  putBlob(id: string, data: Buffer) { writeAtomic(this.blobPath(id), data); }
  getBlob(id: string): Buffer | null {
    const p = this.blobPath(id);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  deleteBlob(id: string) {
    const p = this.blobPath(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
