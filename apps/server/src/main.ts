import { buildApp } from './app';
import { configFromEnv, loadEnvFiles } from './config';

loadEnvFiles();
let config;
try {
  config = configFromEnv();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const { app, services } = await buildApp(config);
// check the hardware encoders once now, so the first conversion does not wait for it
void services.playback.hw.check().then((s) => app.log.info({ videoEncoder: s.active, setting: s.setting }, 'video encoder'));
// the scheduler waits while no provider is set; a login saved in the app starts a sync itself
if (config.scheduler) services.sync.start();
if (config.scheduler) services.backups.start();
if (!services.users.hasUsers()) app.log.warn('No users yet: set ANYCAST_ADMIN_USER and ANYCAST_ADMIN_PASSWORD and restart');
if (!services.source.credentials()) app.log.warn('No provider yet: sign in as an admin and enter it in the app (or set XTREAM_URL, XTREAM_USERNAME and XTREAM_PASSWORD)');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
