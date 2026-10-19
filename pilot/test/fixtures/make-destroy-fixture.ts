/**
 * Writes a SYNTHETIC closed-case data dir for the destroy-case tests (unit tests and the CI job that
 * runs the compiled script inside the production image). No real data.
 *
 *   node dist/test/fixtures/make-destroy-fixture.js <dataDir> [closed|in_review]
 * Key: PILOT_ENCRYPTION_KEY, or PILOT_ENCRYPTION_KEY_FILE (read if it exists, else created with a random key).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EncryptedFileStore } from '../../src/store';
import { AccessLog } from '../../src/accessLog';
import { Cipher } from '../../src/crypto';
import { ANCHOR_EMAIL_STATE_FILE } from '../../src/anchorEmail';

export function makeDestroyFixture(dataDir: string, key: string, status: 'closed' | 'in_review' = 'closed') {
  const cipher = new Cipher(key);
  const store = new EncryptedFileStore(dataDir, cipher);
  store.putBlob('11111111-1111-1111-1111-111111111111', Buffer.from('synthetic blob 1'));
  store.putBlob('22222222-2222-2222-2222-222222222222', Buffer.from('synthetic blob 2'));
  store.update(s => { s.case.status = status; });
  new AccessLog(dataDir, cipher, { anchorSink: null }).append({ actor: 'lawyer', role: 'lawyer', action: 'case.close', outcome: 'ok' });
  fs.writeFileSync(path.join(dataDir, ANCHOR_EMAIL_STATE_FILE), JSON.stringify({ lastSentDay: '2026-01-01' }));
  fs.writeFileSync(path.join(dataDir, 'unrelated-notes.md'), 'not a case artefact');
}

if (require.main === module) {
  const [dataDir, status] = process.argv.slice(2);
  if (!dataDir) { console.error('usage: make-destroy-fixture <dataDir> [closed|in_review]'); process.exit(2); }
  let key = process.env.PILOT_ENCRYPTION_KEY;
  const kf = process.env.PILOT_ENCRYPTION_KEY_FILE;
  if (!key && kf) {
    if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    key = fs.readFileSync(kf, 'utf8').trim();
  }
  if (!key) { console.error('PILOT_ENCRYPTION_KEY or PILOT_ENCRYPTION_KEY_FILE is required'); process.exit(2); }
  makeDestroyFixture(dataDir, key, status === 'in_review' ? 'in_review' : 'closed');
  console.log(JSON.stringify({ fixture: 'ok', files: fs.readdirSync(dataDir).sort() }));
}
