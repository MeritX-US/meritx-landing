/**
 * Content-based file type detection (magic bytes). The client-reported MIME
 * type is never trusted. Returns one of the allowed MIME types, or null.
 */
const startsWith = (b: Buffer, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);

function isZipWithEntry(b: Buffer, entryPrefix: string): boolean {
  if (!startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return false;
  // Walk local file headers looking for an entry name with the given prefix.
  let off = 0, n = 0;
  while (off + 30 <= b.length && n++ < 2000 && b.readUInt32LE(off) === 0x04034b50) {
    const flags = b.readUInt16LE(off + 6);
    const compSize = b.readUInt32LE(off + 18);
    const nameLen = b.readUInt16LE(off + 26), extraLen = b.readUInt16LE(off + 28);
    const name = b.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    if (name.startsWith(entryPrefix)) return true;
    if (flags & 0x08) break; // data descriptor: sizes unknown here; fall back to central directory scan
    off += 30 + nameLen + extraLen + compSize;
  }
  // Fallback: central directory entries (signature PK\x01\x02), filename at +46.
  for (let i = b.indexOf('PK\x01\x02', 0, 'latin1'); i >= 0 && i + 46 <= b.length; i = b.indexOf('PK\x01\x02', i + 4, 'latin1')) {
    const nameLen = b.readUInt16LE(i + 28);
    if (b.subarray(i + 46, i + 46 + nameLen).toString('utf8').startsWith(entryPrefix)) return true;
  }
  return false;
}

function isPlainText(b: Buffer): boolean {
  if (b.length === 0) return false;
  if (b.includes(0)) return false;
  const s = b.toString('utf8');
  if (s.includes('\uFFFD')) return false; // invalid UTF-8
  // Reject control chars other than tab/newline/CR/formfeed.
  if (/[\x01-\x08\x0B\x0E-\x1F\x7F]/.test(s)) return false;
  // Refuse markup that browsers could render as active content.
  if (/^\s*<(!doctype|html|script|svg|\?xml)/i.test(s)) return false;
  return true;
}

export function detectFileType(b: Buffer): string | null {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';            // %PDF-
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (isZipWithEntry(b, 'word/')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (startsWith(b, [0x50, 0x4b])) return null; // other zip archives
  if (isPlainText(b)) return 'text/plain';
  return null;
}
