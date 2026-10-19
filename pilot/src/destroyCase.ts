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
  /** Mandatory manual confirmation 1: hosting (Render) disk snapshots/backups deleted. */
  ackSnapshotsDeleted?: boolean;
  /**
   * Mandatory manual confirmation 2: retained request data at each AI vendor used is deleted or
   * expired, with the retention period per that vendor's terms (days, or zero retention).
   * Use vendor "none" with zero retention if no AI provider was ever enabled.
   */
  aiVendorRetention?: VendorRetention[];
}

export interface VendorRetention { vendor: string; retentionDays: number | null /* null = zero retention */ }

export interface ChecklistItem {
  id: 'render_snapshots_deleted' | 'ai_vendor_data_deleted';
  mandatory: true;
  text: string;
  howToConfirm: string;
  confirmed: boolean;
  vendors?: { vendor: string; retention: string }[];
}

/** Parse `vendor=days` / `vendor=zero` (e.g. gemini=30, openai=zero, none=zero). */
export function parseVendorRetention(s: string): VendorRetention {
  const m = /^([a-z0-9][a-z0-9._-]{0,40})=(.+)$/i.exec(String(s || '').trim());
  if (!m) throw new DestroyRefused(`invalid AI vendor retention "${s}": use vendor=<days> or vendor=zero`);
  const vendor = m[1].toLowerCase(), v = m[2].trim().toLowerCase();
  if (['zero', 'zero-retention', 'zero retention', '0'].includes(v)) return { vendor, retentionDays: null };
  if (!/^\d{1,4}$/.test(v) || Number(v) > 3650) throw new DestroyRefused(`invalid retention "${m[2]}" for ${vendor}: days (1-3650) or zero`);
  if (vendor === 'none') throw new DestroyRefused('vendor "none" (no AI provider used) must be none=zero');
  return { vendor, retentionDays: Number(v) };
}

export const retentionLabel = (r: VendorRetention) => r.retentionDays === null ? 'zero retention' : `${r.retentionDays} days`;

export function buildChecklist(o: Pick<DestroyOptions, 'ackSnapshotsDeleted' | 'aiVendorRetention'>): ChecklistItem[] {
  const vendors = o.aiVendorRetention || [];
  return [
    {
      id: 'render_snapshots_deleted', mandatory: true,
      text: '[ ] Render (hosting) disk snapshots and backups for the pilot disk are deleted.',
      howToConfirm: '--ack-render-snapshots-deleted',
      confirmed: o.ackSnapshotsDeleted === true,
    },
    {
      id: 'ai_vendor_data_deleted', mandatory: true,
      text: '[ ] Request data retained by every AI vendor used is deleted or its retention period has expired. Record the retention period per the vendor terms (days, or zero retention).',
      howToConfirm: '--ack-ai-vendor-data <vendor>=<days>|<vendor>=zero (repeat per vendor; none=zero if no AI provider was ever enabled)',
      confirmed: vendors.length > 0,
      vendors: vendors.map(v => ({ vendor: v.vendor, retention: retentionLabel(v) })),
    },
  ];
}

export interface DestroyReport {
  dryRun: boolean;
  caseStatus: string | 'unknown';
  files: string[];       // paths relative to dataDir (plus the key file path, if any)
  deleted: number;
  keyFileDeleted: boolean;
  remindersForHuman: string[];
  /** Mandatory manual confirmations; the case-close is complete only when all are confirmed. */
  checklist: ChecklistItem[];
  /** true only after a real (non-dry) run deleted the data AND every checklist item was confirmed. */
  complete: boolean;
  pendingConfirmations: string[];
  at: string;
}

const KNOWN_TOP = [/^state\.(enc|json)$/, /^access\.log\.(enc|jsonl)$/, /^anchor-email\.state\.json$/, /\.tmp$/];
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
      'Delete the hosting disk/service, then its disk snapshots/backups (checklist item 1).',
      'Confirm no files/request data remain at any AI vendor and record its retention period (checklist item 2; see docs/AI_VENDOR_TERMS_CHECKLIST.md).',
      'Record this report in the case-close deletion certificate.',
    ],
    checklist: [], complete: false, pendingConfirmations: [],
    at: new Date().toISOString(),
  };
  report.checklist = buildChecklist(o);
  report.pendingConfirmations = report.checklist.filter(c => c.mandatory && !c.confirmed).map(c => c.id);
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
  report.complete = report.pendingConfirmations.length === 0;
  return report;
}
