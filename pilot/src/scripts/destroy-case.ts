/**
 * Usage (dry run is the default and deletes nothing):
 *   npm run destroy-case -- --data-dir ./data
 *   npm run destroy-case -- --data-dir ./data --execute --confirm destroy-closed-case
 * Reads PILOT_ENCRYPTION_KEY / PILOT_ENCRYPTION_KEY_FILE from the environment to
 * check the case is closed; deletes PILOT_ENCRYPTION_KEY_FILE after the data.
 */
import { destroyCase, DestroyRefused } from '../destroyCase';
import fs from 'fs';

const args = process.argv.slice(2);
const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = val('--data-dir') || process.env.PILOT_DATA_DIR;
if (!dataDir) { console.error('PILOT_DATA_DIR or --data-dir is required'); process.exit(2); }
const keyFile = process.env.PILOT_ENCRYPTION_KEY_FILE;
const key = process.env.PILOT_ENCRYPTION_KEY || (keyFile && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : undefined);
try {
  const r = destroyCase({ dataDir, encryptionKey: key, keyFile, dryRun: !args.includes('--execute'), confirm: val('--confirm'), force: args.includes('--force') });
  console.log(JSON.stringify(r, null, 2));
} catch (e) {
  if (e instanceof DestroyRefused) { console.error(e.message); process.exit(1); }
  throw e;
}
