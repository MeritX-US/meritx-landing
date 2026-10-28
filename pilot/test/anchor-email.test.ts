import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { loadConfig, ConfigError } from '../src/config';
import { AnchorEmailer, createSmtpTransport, ANCHOR_EMAIL_STATE_FILE, type AnchorEmailConfig, type MailMessage } from '../src/anchorEmail';
import { AccessLog } from '../src/accessLog';
import { testEnv, EMAIL } from './helpers';

// Synthetic SMTP settings only (.test TLD); no real provider, no real credentials.
const SMTP = { PILOT_ANCHOR_EMAIL_ENABLED: 'true', SMTP_HOST: 'smtp.pilot.example.test', SMTP_FROM: 'pilot-anchor@pilot.example.test' };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mx-anchor-mail-'));
const HEAD = { event: 'access_log_anchor' as const, seq: 41, entries: 42, hash: 'a'.repeat(64) };

class MockTransport {
  sent: MailMessage[] = [];
  failNext = 0;
  async sendMail(m: MailMessage) {
    if (this.failNext > 0) { this.failNext--; throw new Error('smtp down: smtp.pilot.example.test user=secret'); }
    this.sent.push(m); return { messageId: 'mock' };
  }
}
const cfgOf = (extra: Record<string, string> = {}) => loadConfig(testEnv({ ...SMTP, ...extra })).anchorEmail;

test('anchor email: disabled by default (no SMTP env needed)', () => {
  const c = loadConfig(testEnv()).anchorEmail;
  assert.equal(c.enabled, false);
});

test('anchor email config: required fields, defaults to the lawyer account, TLS rules', () => {
  const c = cfgOf();
  assert.equal(c.enabled, true); assert.equal(c.to, EMAIL.lawyer); assert.equal(c.port, 587);
  assert.equal(c.secure, false); assert.equal(c.requireTls, true);
  assert.equal(cfgOf({ SMTP_PORT: '465' }).secure, true);
  assert.equal(cfgOf({ SMTP_TO: 'other@pilot.example.test' }).to, 'other@pilot.example.test');
  const pwFile = path.join(dir(), 'smtp.pw'); fs.writeFileSync(pwFile, 'test-only-smtp-password\n');
  assert.equal(cfgOf({ SMTP_USER: 'u', SMTP_PASSWORD_FILE: pwFile }).password, 'test-only-smtp-password');
  const bad: Record<string, string>[] = [
    { SMTP_HOST: '' }, { SMTP_FROM: '' }, { SMTP_PORT: 'abc' }, { SMTP_PORT: '70000' },
    { SMTP_USER: 'u' }, { SMTP_PASSWORD: 'p' },
  ];
  for (const b of bad) assert.throws(() => cfgOf(b), ConfigError, JSON.stringify(b));
  assert.throws(() => cfgOf({ SMTP_REQUIRE_TLS: 'false', NODE_ENV: 'production' }), /SMTP_REQUIRE_TLS=false is not allowed in production/);
});

test('anchor email: sends seq+hash once per UTC day, persisted across restarts, again the next day', async () => {
  const d = dir(); const t = new MockTransport(); const out: string[] = [];
  let now = new Date('2026-10-19T08:00:00Z');
  const mk = () => new AnchorEmailer(cfgOf(), () => HEAD, d, t, () => now, l => out.push(l));
  const m = mk();
  assert.equal(await m.tick(), 'sent');
  assert.equal(await m.tick(), 'skipped');
  now = new Date('2026-10-19T23:59:00Z');
  assert.equal(await mk().tick(), 'skipped'); // "restart" same day
  assert.equal(t.sent.length, 1);
  const msg = t.sent[0];
  assert.equal(msg.to, EMAIL.lawyer); assert.equal(msg.from, SMTP.SMTP_FROM);
  assert.equal(msg.subject, 'Pilot access-log anchor 2026-10-19');
  assert.match(msg.text, /seq: 41\n/); assert.match(msg.text, new RegExp(`hash: ${HEAD.hash}`)); assert.match(msg.text, /entries: 42/);
  assert.doesNotMatch(msg.subject + msg.text, /@/); // no addresses or names in the content
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, ANCHOR_EMAIL_STATE_FILE), 'utf8')), { lastSentDay: '2026-10-19' });
  now = new Date('2026-10-20T00:01:00Z');
  assert.equal(await mk().tick(), 'sent');
  assert.equal(t.sent.length, 2);
  assert.ok(out.every(l => !l.includes('@')));
  assert.deepEqual(JSON.parse(out[0]), { event: 'access_log_anchor_email', day: '2026-10-19', seq: 41, hash: HEAD.hash, ok: true });
});

test('anchor email: disabled config never sends', async () => {
  const t = new MockTransport();
  const m = new AnchorEmailer(loadConfig(testEnv()).anchorEmail, () => HEAD, dir(), t);
  assert.equal(await m.tick(), 'disabled'); assert.equal(t.sent.length, 0);
});

test('anchor email: SMTP failure is retried on the next tick; error line has no host/user details', async () => {
  const d = dir(); const t = new MockTransport(); t.failNext = 1; const out: string[] = [];
  const m = new AnchorEmailer(cfgOf(), () => HEAD, d, t, () => new Date('2026-10-19T08:00:00Z'), l => out.push(l));
  assert.equal(await m.tick(), 'error');
  assert.equal(fs.existsSync(path.join(d, ANCHOR_EMAIL_STATE_FILE)), false);
  assert.doesNotMatch(out[0], /smtp|secret|example/);
  assert.equal(await m.tick(), 'sent'); assert.equal(t.sent.length, 1);
});

test('anchor email: uses the live access-log head', async () => {
  const d = dir(); const log = new AccessLog(d, undefined, { anchorSink: null });
  log.append({ actor: 'a', role: 'lawyer', action: 'x', outcome: 'ok' });
  const t = new MockTransport();
  await new AnchorEmailer(cfgOf(), () => log.anchor(), d, t, () => new Date('2026-10-19T08:00:00Z'), () => {}).tick();
  assert.match(t.sent[0].text, new RegExp(`seq: 0\\n[\\s\\S]*hash: ${log.anchor().hash}`));
});

/** Minimal fake SMTP server (plain, no TLS) that records the DATA section. Local test only. */
function fakeSmtp(): Promise<{ port: number; messages: string[]; close: () => void }> {
  const messages: string[] = [];
  const srv = net.createServer(sock => {
    let buf = '', inData = false, data = '';
    sock.write('220 fake.example.test ESMTP\r\n');
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; messages.push(data); data = ''; sock.write('250 OK queued\r\n'); } else data += line + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake.example.test\r\n250 OK\r\n');
        else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ port: (srv.address() as net.AddressInfo).port, messages, close: () => srv.close() })));
}

test('anchor email: real SMTP transport (nodemailer) delivers to a local fake SMTP server', async () => {
  const s = await fakeSmtp();
  try {
    const c: AnchorEmailConfig = { ...cfgOf({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(s.port), SMTP_REQUIRE_TLS: 'false' }) };
    assert.equal(c.requireTls, false);
    const r = await new AnchorEmailer(c, () => HEAD, dir(), createSmtpTransport(c), () => new Date('2026-10-19T08:00:00Z'), () => {}).tick();
    assert.equal(r, 'sent');
    assert.equal(s.messages.length, 1);
    assert.match(s.messages[0], /Subject: Pilot access-log anchor 2026-10-19/);
    assert.match(s.messages[0], new RegExp(HEAD.hash));
  } finally { s.close(); }
});
