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
if (config.scheduler && services.source.credentials()) services.sync.start();
if (!services.users.hasUsers()) app.log.warn('No users yet: set ANYCAST_ADMIN_USER and ANYCAST_ADMIN_PASSWORD and restart');
if (!services.source.credentials()) app.log.warn('No provider configured: set XTREAM_URL, XTREAM_USERNAME and XTREAM_PASSWORD');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
