import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { makeApp } from './helpers';

const XTREAM = { url: 'http://secret-panel.example.net:8080', username: 'log-user-8812', password: 'log-pass-1177' };

test('logs never contain provider credentials or URLs', async () => {
  const stream = new PassThrough();
  let out = '';
  stream.on('data', (d: Buffer) => (out += d));
  const { app, services } = await makeApp(XTREAM, { logger: true, logStream: stream, config: { logLevel: 'info' } });
  app.log.error({ err: new Error(`fetch ${XTREAM.url}/player_api.php?username=${XTREAM.username}&password=${XTREAM.password} failed`) }, 'boom');
  app.log.warn(`connecting as ${XTREAM.username} to secret-panel.example.net`);
  // a failing sync (unreachable host) logs its error through the same path
  await services.sync.syncCatalog().catch(() => undefined);
  await app.close();
  expect(out).toContain('boom');
  for (const s of [XTREAM.username, XTREAM.password, 'secret-panel.example.net', 'example.net']) expect(out).not.toContain(s);
}, 60_000);

test('source credentials are encrypted at rest', async () => {
  const { app, services } = await makeApp(XTREAM);
  const row = services.db.prepare('SELECT credentials FROM source').get() as { credentials: string };
  for (const s of [XTREAM.username, XTREAM.password, 'secret-panel']) expect(row.credentials).not.toContain(s);
  expect(services.source.credentials()).toEqual(XTREAM);
  await app.close();
});

test('serves the built web app with SPA fallback, API 404s stay JSON', async () => {
  const dist = mkdtempSync(path.join(os.tmpdir(), 'anycast-web-'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>AnyCast</title>');
  writeFileSync(path.join(dist, 'app.js'), 'console.log(1)');
  const { app } = await makeApp(null, { config: { webDist: dist } });
  expect((await app.inject({ url: '/app.js' })).body).toBe('console.log(1)');
  expect((await app.inject({ url: '/live/123' })).body).toContain('<title>AnyCast</title>');
  const api = await app.inject({ url: '/api/nope', headers: {} });
  expect(api.statusCode).toBe(401);
  expect((await app.inject({ url: '/api/source' })).statusCode).toBe(401);
  await app.close();
});
