/**
 * Verify the access-log hash chain, optionally against an external anchor (seq + hash) taken from
 * Render's logs (the `{"event":"access_log_anchor",...}` stdout line), the daily anchor email, or
 * the lawyer's notes. Read-only: never writes to the data dir.
 *
 *   npm run verify-access-log -- --data-dir ./data [--seq 41 --hash <64 hex>]
 *   npm run verify-access-log -- --data-dir ./data --anchor '{"event":"access_log_anchor","seq":41,"entries":42,"hash":"..."}'
 *   (production image)  npm run verify-access-log:prod -- --seq 41 --hash <64 hex>
 *
 * Reads PILOT_ENCRYPTION_KEY / PILOT_ENCRYPTION_KEY_FILE (the production log is encrypted).
 * Exit codes: 0 = chain ok (and anchor matches, if given); 1 = broken/mismatch; 2 = usage error.
 */
import fs from 'fs';
import { AccessLog, parseAnchor, type Anchor } from '../accessLog';
import { Cipher } from '../crypto';

const args = process.argv.slice(2);
const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const usage = (m: string) => { console.error(m); process.exit(2); };

const dataDir = val('--data-dir') || process.env.PILOT_DATA_DIR;
if (!dataDir) usage('PILOT_DATA_DIR or --data-dir is required');
if (!fs.existsSync(dataDir!)) usage('data dir does not exist');
const keyFile = process.env.PILOT_ENCRYPTION_KEY_FILE;
const key = process.env.PILOT_ENCRYPTION_KEY || (keyFile && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : undefined);

let anchor: Anchor | undefined;
const rawAnchor = val('--anchor');
if (rawAnchor !== undefined || val('--seq') !== undefined || val('--hash') !== undefined) {
  let src: { seq?: unknown; hash?: unknown } = { seq: val('--seq'), hash: val('--hash') };
  if (rawAnchor !== undefined) { try { src = JSON.parse(rawAnchor); } catch { usage('--anchor must be the JSON anchor line'); } }
  anchor = parseAnchor(src) || usage('anchor needs seq (non-negative integer) and hash (64 hex chars)');
}

const log = new AccessLog(dataDir!, key ? new Cipher(key) : undefined, { anchorSink: null });
const v = log.verify(anchor);
console.log(JSON.stringify(v, null, 2));
process.exit(v.ok ? 0 : 1);
