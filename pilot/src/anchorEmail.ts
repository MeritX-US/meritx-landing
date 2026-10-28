import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import type { AnchorEvent } from './accessLog';

/**
 * Optional daily access-log anchor email (DISABLED by default).
 *
 * Once per UTC day, mails the current access-log head {seq, entries, hash} to the lawyer, so a
 * copy of the head lives outside the data disk AND outside the hosting provider. It is a second
 * copy next to the per-append stdout anchor line (Render logs); it does not replace it.
 * The message carries only seq/count/hash/date -- no names, emails, filenames or case content.
 *
 * No SMTP provider is chosen in this repo and no credentials are committed: the MeritX owner
 * picks the provider before launch and sets SMTP_* in the host's secret store.
 */
export interface AnchorEmailConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;       // implicit TLS (465). Otherwise STARTTLS is required unless requireTls=false.
  requireTls: boolean;   // false only for local testing; refused in production
  user: string;
  password: string;      // never logged
  from: string;
  to: string;            // lawyer's address (defaults to the lawyer account's email)
}

export const ANCHOR_EMAIL_DISABLED: AnchorEmailConfig = {
  enabled: false, host: '', port: 587, secure: false, requireTls: true, user: '', password: '', from: '', to: '',
};

export interface MailMessage { from: string; to: string; subject: string; text: string }
export interface MailTransport { sendMail(m: MailMessage): Promise<unknown> }

export function createSmtpTransport(c: AnchorEmailConfig): MailTransport {
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    requireTLS: !c.secure && c.requireTls,
    auth: c.user ? { user: c.user, pass: c.password } : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export function anchorMessage(c: AnchorEmailConfig, a: AnchorEvent, day: string): MailMessage {
  return {
    from: c.from,
    to: c.to,
    subject: `Pilot access-log anchor ${day}`,
    text: [
      `Access-log anchor for ${day} (UTC).`,
      '',
      `seq: ${a.seq}`,
      `entries: ${a.entries}`,
      `hash: ${a.hash}`,
      '',
      'Keep this email. To check the log was not truncated or rewritten since this point, run',
      `  npm run verify-access-log:prod -- --seq ${a.seq} --hash ${a.hash}`,
      'or call GET /api/access-log/verify?seq=<seq>&hash=<hash> as lawyer/admin.',
      a.seq < 0 ? '(The log was empty at this time.)' : '',
    ].join('\n'),
  };
}

export const ANCHOR_EMAIL_STATE_FILE = 'anchor-email.state.json';

/**
 * Sends at most one anchor email per UTC day; the last sent day is persisted in the data dir so a
 * restart doesn't send a second one. Call tick() periodically (server.ts: at start, then every 15 min).
 */
export class AnchorEmailer {
  private stateFile: string;
  private inFlight = false;
  constructor(
    private cfg: AnchorEmailConfig,
    private head: () => AnchorEvent,
    dataDir: string,
    private transport: MailTransport = createSmtpTransport(cfg),
    private now: () => Date = () => new Date(),
    private out: (line: string) => void = l => process.stdout.write(l + '\n'),
  ) {
    this.stateFile = path.join(dataDir, ANCHOR_EMAIL_STATE_FILE);
  }
  lastSentDay(): string | null {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')).lastSentDay || null; } catch { return null; }
  }
  /** Returns 'sent' | 'skipped' | 'disabled' | 'error'. Never throws. */
  async tick(): Promise<'sent' | 'skipped' | 'disabled' | 'error'> {
    if (!this.cfg.enabled) return 'disabled';
    const day = utcDay(this.now());
    if (this.inFlight || this.lastSentDay() === day) return 'skipped';
    this.inFlight = true;
    const a = this.head();
    try {
      await this.transport.sendMail(anchorMessage(this.cfg, a, day));
      fs.writeFileSync(this.stateFile, JSON.stringify({ lastSentDay: day }), { mode: 0o600 });
      this.out(JSON.stringify({ event: 'access_log_anchor_email', day, seq: a.seq, hash: a.hash, ok: true }));
      return 'sent';
    } catch {
      // No error details: they can contain the SMTP host/user. Retried on the next tick.
      this.out(JSON.stringify({ event: 'access_log_anchor_email', day, seq: a.seq, ok: false }));
      return 'error';
    } finally {
      this.inFlight = false;
    }
  }
}
