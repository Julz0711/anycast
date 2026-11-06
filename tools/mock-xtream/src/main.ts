/** CLI: pnpm --filter @anycast/mock-xtream start [--port 8899] [--size full|small|huge|real] [--timezone Europe/Berlin] [--username test] [--password test] */
import { parseArgs } from 'node:util';
import { createMockXtream } from './server.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    username: { type: 'string' },
    password: { type: 'string' },
    size: { type: 'string' },
    'max-connections': { type: 'string' },
    seed: { type: 'string' },
    timezone: { type: 'string' },
    log: { type: 'boolean' },
  },
});

const env = process.env;
const size = values.size ?? env.SIZE ?? 'full';
if (size !== 'full' && size !== 'small' && size !== 'huge' && size !== 'real') throw new Error(`SIZE must be full, small, huge or real, got ${size}`);

const mock = await createMockXtream({
  port: Number(values.port ?? env.PORT ?? 8899),
  host: values.host ?? env.HOST ?? '0.0.0.0',
  username: values.username ?? env.MOCK_USERNAME ?? env.USERNAME ?? 'test',
  password: values.password ?? env.MOCK_PASSWORD ?? env.PASSWORD ?? 'test',
  size,
  maxConnections: Number(values['max-connections'] ?? env.MAX_CONNECTIONS ?? 2),
  seed: Number(values.seed ?? env.SEED ?? 42),
  timezone: values.timezone ?? env.MOCK_TIMEZONE ?? 'Europe/Berlin',
  logger: values.log ?? false,
});

const s = mock.state();
console.log(`[mock-xtream] ${mock.url}  user=${mock.username} pass=${mock.password}  size=${size}`);
console.log(`[mock-xtream] ${s.catalog.live} live, ${s.catalog.movies} movies, ${s.catalog.series} series (${s.catalog.episodes} episodes)`);
console.log(`[mock-xtream] player_api: ${mock.url}/player_api.php?username=${mock.username}&password=${mock.password}`);
if (!s.ffmpeg.drawtext) console.warn('[mock-xtream] drawtext/font unavailable: videos carry no burned-in clock (PTS/header convention still works)');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void mock.close().finally(() => process.exit(0));
  });
}
