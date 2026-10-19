import { loadConfig, ConfigError } from './config';
import { createApp } from './app';
import { AccessLog } from './accessLog';
import { AnchorEmailer } from './anchorEmail';
import { Cipher } from './crypto';

try {
  const cfg = loadConfig();
  const port = Number(process.env.PORT || 3101);
  const log = new AccessLog(cfg.dataDir, new Cipher(cfg.encryptionKey), cfg.accessLogAnchorStdout ? {} : { anchorSink: null });
  createApp(cfg, { log }).listen(port, () => {
    // Never log emails, secrets, or data paths' contents.
    console.log(`[pilot] private pilot listening on :${port} (accounts=${cfg.accounts.length}, LAWYER_APPROVED_PUBLISH=${cfg.lawyerApprovedPublish})`);
  });
  // Optional daily anchor email (off unless PILOT_ANCHOR_EMAIL_ENABLED=true). At most once per UTC day.
  if (cfg.anchorEmail.enabled) {
    const mailer = new AnchorEmailer(cfg.anchorEmail, () => log.anchor(), cfg.dataDir);
    void mailer.tick();
    setInterval(() => { void mailer.tick(); }, 15 * 60 * 1000).unref();
    console.log('[pilot] daily access-log anchor email: enabled');
  }
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`[pilot] config error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
