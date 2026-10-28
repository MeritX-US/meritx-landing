import { loadConfig, ConfigError } from './config';
import { createApp } from './app';

try {
  const cfg = loadConfig();
  const port = Number(process.env.PORT || 3101);
  createApp(cfg).listen(port, () => {
    // Never log emails, secrets, or data paths' contents.
    console.log(`[pilot] private pilot listening on :${port} (accounts=${cfg.accounts.length}, LAWYER_APPROVED_PUBLISH=${cfg.lawyerApprovedPublish})`);
  });
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`[pilot] config error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
