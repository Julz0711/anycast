import { readdirSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { BufferStatus } from '../src/playback/buffer';
import { BUFFER_TEST, channelStatus, until } from './buffer-helpers';
import { createMockXtream, login, makeApp, testConfig } from './helpers';

let mock: Awaited<ReturnType<typeof createMockXtream>>;

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', maxConnections: 3, username: 'caps-user', password: 'caps-pass-9921' });
});
afterAll(async () => {
  await mock.close();
});

const xtream = () => ({ url: mock.url, username: mock.username, password: mock.password });
const noArchive = () => mock.catalog.live.filter((c) => !c.archive && c.profile === 'live_h264_aac').map((c) => String(c.id));

async function start(config: ReturnType<typeof testConfig>) {
  const built = await makeApp(xtream(), { config });
  await built.services.sync.syncCatalog();
  const cookie = await login(built.app);
  const base = await built.app.listen({ port: 0, host: '127.0.0.1' });
  const viewers: AbortController[] = [];
  const watch = async (id: string) => {
    const ac = new AbortController();
    viewers.push(ac);
    const res = await fetch(`${base}/api/stream/live/${id}.ts`, { headers: { cookie }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    void (async () => {
      try {
        while (!(await reader.read()).done);
      } catch {
        /* aborted */
      }
    })();
  };
  const status = async () => (await (await fetch(`${base}/api/buffer/status`, { headers: { cookie } })).json()) as BufferStatus;
  return { built, watch, status, stopViewers: () => viewers.splice(0).forEach((a) => a.abort()) };
}

const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => path.join(e.parentPath, e.name));

test('caps are never exceeded: oldest segments are evicted first', async () => {
  const maxMsPerChannel = 5000;
  const maxBytes = 150_000;
  const app = await start(testConfig(xtream(), { buffer: { ...BUFFER_TEST, graceMs: 0, maxMsPerChannel, maxBytes } }));
  const [a, b] = noArchive();
  await Promise.all([app.watch(a!), app.watch(b!)]);
  const db = app.built.services.db;
  let samples = 0;
  const deadline = Date.now() + 14_000;
  let evicted = false;
  const recorded = new Set<string>();
  while (Date.now() < deadline) {
    const s = await app.status();
    expect(s.totalBytes).toBeLessThanOrEqual(maxBytes);
    for (const c of s.channels) {
      expect(c.durationMs).toBeLessThanOrEqual(maxMsPerChannel);
      if (c.bytes > 0) recorded.add(c.channelId);
    }
    const minSeq = db.prepare('SELECT MIN(seq) AS n FROM buffer_segments').get() as { n: number | null };
    evicted ||= (minSeq.n ?? 0) > 0;
    samples++;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(samples).toBeGreaterThan(50);
  expect(evicted).toBe(true);
  const s = await app.status();
  expect(s.caps).toMatchObject({ maxHoursPerChannel: maxMsPerChannel / 3600_000, maxBytes });
  expect(recorded.size).toBe(2);
  // the index and the disk agree: every indexed file exists with its size, evicted files are gone
  const rows = db.prepare('SELECT run_id, seq, bytes FROM buffer_segments').all() as { run_id: number; seq: number; bytes: number }[];
  for (const r of rows) expect(statSync(app.built.services.playback.buffer!.segmentPath(r)!).size).toBe(r.bytes);
  app.stopViewers();
  await app.built.app.close();
  // after a clean stop (last segments flushed and indexed) the disk is within the cap too
  const onDisk = tsFiles(app.built.services.config.bufferDir).reduce((n, f) => n + statSync(f).size, 0);
  expect(onDisk).toBeGreaterThan(0);
  expect(onDisk).toBeLessThanOrEqual(maxBytes);
}, 40_000);

test('restart: the buffer index is reloaded, and files or rows that do not match are cleaned', async () => {
  const config = testConfig(xtream(), { buffer: { ...BUFFER_TEST, graceMs: 0 } });
  const first = await start(config);
  const id = noArchive()[2]!;
  await first.watch(id);
  expect(await until(async () => (channelStatus(await first.status(), id)?.durationMs ?? 0) >= 6000)).toBe(true);
  first.stopViewers();
  expect(await until(async () => !channelStatus(await first.status(), id)?.recording, 8000)).toBe(true);
  const before = channelStatus(await first.status(), id)!;
  await first.built.app.close();

  // damage: one indexed segment disappears, a stray file and a stray run dir appear
  const files = tsFiles(config.bufferDir).sort();
  const lost = files[files.length - 1]!;
  const lostBytes = statSync(lost).size;
  unlinkSync(lost);
  writeFileSync(path.join(path.dirname(lost), 'stray.tmp'), 'x');
  mkdirSync(path.join(config.bufferDir, id, '999'), { recursive: true });
  writeFileSync(path.join(config.bufferDir, id, '999', '0.ts'), 'junk');

  const second = await start(config);
  const after = channelStatus(await second.status(), id)!;
  expect(after.ranges[0]!.start).toBe(before.ranges[0]!.start);
  expect(after.bytes).toBe(before.bytes - lostBytes);
  const left = tsFiles(config.bufferDir);
  expect(left.length).toBe(files.length - 1);
  expect(readdirSync(path.dirname(lost))).not.toContain('stray.tmp');
  const tl = await second.built.app.inject({ url: `/api/timeline/${id}`, headers: { cookie: await login(second.built.app) } });
  expect(tl.json().ranges[0].source).toBe('buffer');
  await second.built.app.close();
}, 40_000);
