/**
 * Scrub thumbnails (PB-1): built from the segments a real VOD HLS session writes, with one
 * provider connection and no second one; cached on disk under a size cap, least recently used out.
 */
import type { PlaybackInfo, ThumbIndex } from '@anycast/shared';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DEFAULT_THUMBS, Thumbnails } from '../src/playback/thumbs';
import { createMockXtream, FORMAT_MATRIX, login, makeApp } from './helpers';

const MSE = JSON.stringify({ hls: false, mse: true, codecs: ['avc1', 'mp4a'] });
const CLIENT = { 'x-anycast-client': 'thumbs-client-0001', 'x-anycast-device': 'Test' };

let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let base: string;
const scratch = mkdtempSync(path.join(os.tmpdir(), 'anycast-thumbs-'));

async function get(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + url, { headers: { cookie, 'x-anycast-caps': MSE, ...headers } });
  return res;
}

/** the time among `times` whose frame of `ref` is PSNR-closest to `tile` among reference frames at `times` */
function closest(tile: string, ref: string, times: number[]): number {
  let best = { t: -1, psnr: -Infinity };
  for (const t of times) {
    const frame = path.join(scratch, `ref-${t}.png`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', ref, '-frames:v', '1', '-vf', 'scale=160:90', frame]);
    const log = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', tile, '-i', frame, '-lavfi', 'psnr', '-f', 'null', '-']).stderr.toString();
    const m = /average:([\d.]+|inf)/.exec(log);
    const psnr = m ? (m[1] === 'inf' ? 99 : Number(m[1])) : 0;
    if (psnr > best.psnr) best = { t, psnr };
  }
  return best.t;
}

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', maxConnections: 1, username: 'th-user-4410', password: 'th-pass-8820' });
  built = await makeApp({ url: mock.url, username: mock.username, password: mock.password });
  await built.services.sync.syncCatalog();
  cookie = await login(built.app);
  base = await built.app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await built.app.close();
  await mock.close();
});

describe('from a real playback session', () => {
  test('tiles appear for the played parts at their true times, over one provider connection', async () => {
    const entry = FORMAT_MATRIX.find((f) => f.id === 'mkv_h264_eac3_multi' && f.kind === 'movie')!;
    const id = entry.ids.find((x) => entry.durations![x]! >= 180)!;
    const duration = entry.durations![id]!;
    const thumbs = built.services.playback.thumbs!;
    expect((await (await get(`/api/thumbs/movie/${id}`)).json()) as ThumbIndex).toMatchObject({ interval: 10, tiles: [] });

    const pi = (await (await get(`/api/play/movie/${id}`, CLIENT)).json()) as PlaybackInfo;
    expect(pi).toMatchObject({ type: 'hls', pipeline: 'transcode-audio' });
    const seg = (name: string) => get(pi.url.replace('index.m3u8', name)).then(async (r) => (expect(r.status, name).toBe(200), Buffer.from(await r.arrayBuffer())));
    await (await get(pi.url)).text();
    await seg('init.mp4');
    // watch the first 30 s, then jump to 2:00 and watch a bit there
    for (let n = 0; n < 5; n++) await seg(`seg/${n}.m4s`);
    for (let n = 20; n < 23; n++) await seg(`seg/${n}.m4s`);
    await new Promise((r) => setTimeout(r, 1500));
    await thumbs.idle();

    const index = (await (await get(`/api/thumbs/movie/${id}`)).json()) as ThumbIndex;
    const starts = index.tiles.map((t) => t.start);
    // (the jump lands on the keyframe after 2:00 with this file, so 2:00 itself may be missing)
    for (const t of [0, 10, 20, 130, 140]) expect(starts).toContain(t);
    expect(Math.max(...starts)).toBeLessThan(duration);
    expect(index).toMatchObject({ width: 160, height: 90 });
    for (const t of index.tiles) {
      // the frame shown is the one at (or just after) its time: the mock's PTS is the position
      const at = thumbs.frameTimes.get(`movie:${id}:${t.start / 10}`)!;
      expect(at).toBeGreaterThanOrEqual(t.start);
      expect(at).toBeLessThan(t.start + 0.25);
      expect(t).toMatchObject({ w: 160, h: 90, x: ((t.start / 10) % 10) * 160, y: Math.floor((t.start / 10) / 10) * 90 });
      expect(t.url).toMatch(new RegExp(`^/api/thumbs/movie/${id}/sheet/0\\.jpg\\?v=\\d+$`));
    }
    // playback held one provider connection, thumbnails none of their own
    expect(mock.state().peakConnections).toBe(1);

    // the sprite: a 10 x 10 grid of 160 x 90 tiles
    const sheetRes = await get(index.tiles[0]!.url);
    expect(sheetRes.status).toBe(200);
    expect(sheetRes.headers.get('content-type')).toBe('image/jpeg');
    const sheet = path.join(scratch, 'sheet.jpg');
    writeFileSync(sheet, Buffer.from(await sheetRes.arrayBuffer()));
    const dims = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', sheet]).toString().trim();
    expect(dims).toBe('1600,900');

    // and the 2:10 tile looks like the movie at 2:10, not 2:05 or 2:15 (burned-in clock, moving box)
    await built.app.inject({ method: 'POST', url: '/api/play/stop', headers: { cookie, ...CLIENT } });
    built.services.playback.sessions.closeAll();
    const tile = index.tiles.find((t) => t.start === 130)!;
    const crop = path.join(scratch, 'tile.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', sheet, '-vf', `crop=${tile.w}:${tile.h}:${tile.x}:${tile.y}`, crop]);
    // the original file, fetched once (seeking over HTTP would need a second connection)
    await new Promise((r) => setTimeout(r, 1500));
    const original = await fetch(`${mock.url}/movie/${mock.username}/${mock.password}/${id}.mkv`);
    expect(original.status).toBe(200);
    const source = path.join(scratch, 'source.mkv');
    writeFileSync(source, Buffer.from(await original.arrayBuffer()));
    expect(closest(crop, source, [125, 130, 135])).toBe(130);
  }, 90_000);
});

describe('disk cache', () => {
  /** an item as an earlier run left it: meta.json, `tiles` tiles of `kb` KiB each, last used at `mtime` */
  function seed(dir: string, id: string, tiles: number, kb: number, mtime: number) {
    const d = path.join(dir, 'movie', id);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ w: 160, h: 90, interval: 10 }));
    for (let k = 0; k < tiles; k++) writeFileSync(path.join(d, `t${k}.jpg`), Buffer.alloc(kb * 1024));
    utimesSync(d, mtime / 1000, mtime / 1000);
  }

  test('is reused after a restart, and the least recently used items go first past the cap', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'anycast-thumbcache-'));
    const now = Date.now();
    seed(dir, '1', 10, 10, now - 3 * 3600_000);
    seed(dir, '2', 10, 10, now - 2 * 3600_000);
    seed(dir, '3', 10, 10, now - 1 * 3600_000);

    // everything fits: all three come back as they were
    const a = new Thumbnails(dir, DEFAULT_THUMBS);
    expect((await a.index('movie', '3')).tiles.map((t) => t.start)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(a.totalBytes).toBeGreaterThanOrEqual(300 * 1024);
    a.close();

    // reading item 1 makes it the most recently used
    const b = new Thumbnails(dir, DEFAULT_THUMBS);
    expect((await b.index('movie', '1')).tiles).toHaveLength(10);
    await new Promise((r) => setTimeout(r, 100));
    b.close();

    // room for two items: 2 (now the oldest) is evicted, 1 and 3 stay
    const c = new Thumbnails(dir, { ...DEFAULT_THUMBS, maxBytes: 250 * 1024 });
    await c.index('movie', '1');
    expect(c.has('movie', '1')).toBe(true);
    expect(c.has('movie', '2')).toBe(false);
    expect(c.has('movie', '3')).toBe(true);
    expect(existsSync(path.join(dir, 'movie', '2'))).toBe(false);
    expect(c.totalBytes).toBeLessThanOrEqual(250 * 1024);
    c.close();
  });

  test('unknown ids and empty items answer an empty index; bad ids 404', async () => {
    expect((await (await get('/api/thumbs/episode/999999')).json()) as ThumbIndex).toMatchObject({ tiles: [] });
    expect((await get('/api/thumbs/movie/..%2Fx')).status).toBe(404);
    expect((await get('/api/thumbs/movie/1/sheet/0.jpg')).status).toBe(404);
  });
});
