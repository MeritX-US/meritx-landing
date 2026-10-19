import fs from 'fs';
import path from 'path';
import { Cipher } from './crypto';

/**
 * Case-close destruction (pilot item #6).
 *
 * Deletes every encrypted case artefact in PILOT_DATA_DIR (state.enc, blobs/*,
 * access.log.enc, plus any leftover plaintext/tmp files the app may have
 * written) and, if given, the encryption key file. Deleting the key
 * crypto-shreds any copy of the ciphertext that survives elsewhere (backups,
 * disk snapshots). Default is a DRY RUN that only lists what would be deleted.
 *
 * Safety rails:
 *  - refuses unless `confirm` equals the exact phrase DESTROY_CONFIRM_PHRASE;
 *  - refuses unless the case status is `closed` (checked by decrypting state
 *    with the key) -- `force` overrides only when the state can't be read;
 *  - only deletes files it recognises inside the data dir; never recurses
 *    outside it and never follows symlinks.
 */
export const DESTROY_CONFIRM_PHRASE = 'destroy-closed-case';

export interface DestroyOptions {
  dataDir: string;
  /** base64 key (to check the case is closed). */
  encryptionKey?: string;
  /** Path of a key file to delete after the data (PILOT_ENCRYPTION_KEY_FILE). */
  keyFile?: string;
  dryRun?: boolean;
  confirm?: string;
  force?: boolean;
}

export interface DestroyReport {
  dryRun: boolean;
  caseStatus: string | 'unknown';
  files: string[];       // paths relative to dataDir (plus the key file path, if any)
  deleted: number;
  keyFileDeleted: boolean;
  remindersForHuman: string[];
  at: string;
}

const KNOWN_TOP = [/^state\.(enc|json)$/, /^access\.log\.(enc|jsonl)$/, /\.tmp$/];
const BLOB = /^[a-f0-9-]{8,64}(\..*\.tmp)?$/;

function listTargets(dataDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dataDir)) return out;
  for (const name of fs.readdirSync(dataDir)) {
    const p = path.join(dataDir, name);
    const st = fs.lstatSync(p);
    if (st.isFile() && KNOWN_TOP.some(r => r.test(name))) out.push(name);
  }
  const blobDir = path.join(dataDir, 'blobs');
  if (fs.existsSync(blobDir) && fs.lstatSync(blobDir).isDirectory()) {
    for (const name of fs.readdirSync(blobDir)) {
      const st = fs.lstatSync(path.join(blobDir, name));
      if (st.isFile() && BLOB.test(name)) out.push(path.join('blobs', name));
    }
  }
  return out.sort();
}

function readStatus(dataDir: string, key?: string): string | 'unknown' {
  const f = path.join(dataDir, 'state.enc');
  if (!key || !fs.existsSync(f)) return 'unknown';
  try {
    const s = JSON.parse(new Cipher(key).decrypt(fs.readFileSync(f), 'state').toString('utf8'));
    return String(s?.case?.status || 'unknown');
  } catch {
    return 'unknown';
  }
}

export class DestroyRefused extends Error {}

export function destroyCase(o: DestroyOptions): DestroyReport {
  const dryRun = o.dryRun !== false;
  const dataDir = path.resolve(o.dataDir);
  const status = readStatus(dataDir, o.encryptionKey);
  const files = listTargets(dataDir);
  const keyFile = o.keyFile ? path.resolve(o.keyFile) : null;
  const report: DestroyReport = {
    dryRun, caseStatus: status,
    files: keyFile && fs.existsSync(keyFile) ? [...files, keyFile] : files,
    deleted: 0, keyFileDeleted: false,
    remindersForHuman: [
      'Export anything the lawyer must keep BEFORE running without --dry-run.',
      'If PILOT_ENCRYPTION_KEY is set as an env var (not a file), delete it from the host secret store.',
      'Delete the hosting disk/service and any disk snapshots or backups.',
      'Confirm no files remain at any AI vendor (the pilot sends inline only; verify per docs/AI_VENDOR_TERMS_CHECKLIST.md).',
      'Record this report in the case-close deletion certificate.',
    ],
    at: new Date().toISOString(),
  };
  if (dryRun) return report;

  if (o.confirm !== DESTROY_CONFIRM_PHRASE) throw new DestroyRefused(`refusing: pass --confirm ${DESTROY_CONFIRM_PHRASE}`);
  if (status !== 'closed') {
    if (status !== 'unknown') throw new DestroyRefused(`refusing: case status is "${status}", not "closed"`);
    if (!o.force) throw new DestroyRefused('refusing: case status could not be read (missing/wrong key); pass --force to override');
  }
  for (const rel of files) {
    fs.unlinkSync(path.join(dataDir, rel));
    report.deleted++;
  }
  const blobDir = path.join(dataDir, 'blobs');
  if (fs.existsSync(blobDir) && fs.readdirSync(blobDir).length === 0) fs.rmdirSync(blobDir);
  if (keyFile && fs.existsSync(keyFile) && fs.lstatSync(keyFile).isFile()) {
    fs.unlinkSync(keyFile);
    report.keyFileDeleted = true;
  }
  return report;
}
