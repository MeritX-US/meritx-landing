/**
 * Generate a scrypt password hash for PILOT_ACCOUNTS.
 * Reads the password from stdin so it never lands in shell history or argv:
 *   npm run --silent hash-password < /workspace/secrets/some-password-file
 * or type it interactively and press Ctrl-D.
 */
import { hashPassword } from '../auth';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (buf += d));
process.stdin.on('end', () => {
  const pw = buf.replace(/\r?\n$/, '');
  if (pw.length < 12) {
    console.error('password must be at least 12 characters');
    process.exit(1);
  }
  process.stdout.write(hashPassword(pw) + '\n');
});
