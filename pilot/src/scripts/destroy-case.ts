/**
 * Usage (dry run is the default and deletes nothing):
 *   npm run destroy-case -- --data-dir ./data
 *   npm run destroy-case -- --data-dir ./data --execute --confirm destroy-closed-case \
 *     --ack-render-snapshots-deleted --ack-ai-vendor-data gemini=30 [--report-file ./case-close-report.json]
 * In the production image (compiled JS, no dev dependencies):
 *   npm run destroy-case:prod -- ...      (= node dist/src/scripts/destroy-case.js ...)
 *
 * Reads PILOT_ENCRYPTION_KEY / PILOT_ENCRYPTION_KEY_FILE from the environment to
 * check the case is closed; deletes PILOT_ENCRYPTION_KEY_FILE after the data.
 *
 * Mandatory manual confirmations (the run is NOT reported complete without both):
 *   --ack-render-snapshots-deleted          Render disk snapshots/backups are deleted
 *   --ack-ai-vendor-data <vendor>=<days|zero>  per AI vendor used: retained request data deleted/expired,
 *                                           retention period per vendor terms (none=zero if AI was never on)
 * They can be given in the same run, or in a later run after the data is already gone
 * (`--execute --confirm destroy-closed-case --force --ack...` on the emptied data dir).
 *
 * Exit codes: 0 = dry run printed, or executed AND complete; 1 = refused; 2 = usage;
 *             3 = data deleted but checklist confirmations still pending (NOT complete).
 */
import { destroyCase, DestroyRefused, parseVendorRetention } from '../destroyCase';
import fs from 'fs';

const args = process.argv.slice(2);
const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const all = (k: string) => args.flatMap((a, i) => (a === k && args[i + 1] !== undefined ? [args[i + 1]] : []));
const dataDir = val('--data-dir') || process.env.PILOT_DATA_DIR;
if (!dataDir) { console.error('PILOT_DATA_DIR or --data-dir is required'); process.exit(2); }
const keyFile = process.env.PILOT_ENCRYPTION_KEY_FILE;
const key = process.env.PILOT_ENCRYPTION_KEY || (keyFile && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : undefined);
try {
  const r = destroyCase({
    dataDir, encryptionKey: key, keyFile,
    dryRun: !args.includes('--execute'), confirm: val('--confirm'), force: args.includes('--force'),
    ackSnapshotsDeleted: args.includes('--ack-render-snapshots-deleted'),
    aiVendorRetention: all('--ack-ai-vendor-data').map(parseVendorRetention),
  });
  const json = JSON.stringify(r, null, 2);
  console.log(json);
  const reportFile = val('--report-file');
  if (reportFile) fs.writeFileSync(reportFile, json + '\n', { mode: 0o600 });
  console.error('\nCase-close checklist (mandatory manual confirmations):');
  for (const c of r.checklist) console.error(`  ${c.confirmed ? '[x]' : '[ ]'} ${c.text.replace(/^\[ \] /, '')}${c.vendors?.length ? ` -- ${c.vendors.map(v => `${v.vendor}: ${v.retention}`).join(', ')}` : ''}\n        confirm with: ${c.howToConfirm}`);
  if (r.dryRun) { console.error('\nDRY RUN: nothing deleted.'); process.exit(0); }
  if (!r.complete) {
    console.error(`\nData deleted (${r.deleted} files), but the case-close is NOT complete. Pending: ${r.pendingConfirmations.join(', ')}`);
    process.exit(3);
  }
  console.error('\nCase-close destruction complete: data deleted and all confirmations recorded.');
} catch (e) {
  if (e instanceof DestroyRefused) { console.error(e.message); process.exit(1); }
  throw e;
}
