import crypto from 'crypto';

/**
 * App-level encryption at rest: AES-256-GCM with a 32-byte key from env
 * (PILOT_ENCRYPTION_KEY, base64). Every record/blob gets a fresh 96-bit IV and
 * is bound to its identity via AAD, so ciphertexts can't be swapped between
 * records. Format: "MXE1" | iv(12) | tag(16) | ciphertext.
 *
 * Destroying the key (case close) crypto-shreds everything, including backups.
 */
const MAGIC = Buffer.from('MXE1');

export class Cipher {
  private key: Buffer;
  constructor(keyB64: string) {
    const key = Buffer.from(keyB64 || '', 'base64');
    if (key.length !== 32) throw new Error('PILOT_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
    this.key = key;
  }

  encrypt(plain: Buffer, aad: string): Buffer {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer, aad: string): Buffer {
    if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error('not an encrypted pilot blob');
    const iv = blob.subarray(4, 16), tag = blob.subarray(16, 32), ct = blob.subarray(32);
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]); // throws on wrong key / tamper
  }
}
