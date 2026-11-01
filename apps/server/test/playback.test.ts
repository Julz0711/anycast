import type { PlaybackInfo, TimelineInfo } from '@anycast/shared';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createMockXtream, FORMAT_MATRIX, login, makeApp } from './helpers';

const MSE = JSON.stringify({ hls: false, mse: true, codecs: ['avc1', 'mp4a'] });
const NO_MSE = JSON.stringify({ hls: true, mse: false, codecs: ['avc1', 'mp4a'] });
const HEVC_NO_AC3 = JSON.stringify({ hls: true, mse: true, codecs: ['avc1', 'hvc1', 'mp4a'] });

let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let base: string;
const open: AbortController[] = [];
const seen: string[] = [];

const ids = (profile: string, kind: string) => FORMAT_MATRIX.find((f) => f.id === profile && f.kind === kind)!.ids;

async function get(url: string, caps?: string, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  open.push(ac);
  const res = await fetch(base + url, { headers: { cookie, ...(caps ? { 'x-anycast-caps': caps } : {}), ...headers }, signal: ac.signal });
  return { res, close: () => ac.abort() };
}
async function info(url: string, caps: string): Promise<PlaybackInfo> {
  const { res } = await get(url, caps);
  const text = await res.text();
  seen.push(text);
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as PlaybackInfo;
}
async function readBytes(res: Response, n: number): Promise<Buffer> {
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < n) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(Buffer.from(r.value));
    total += r.value.length;
  }
  return Buffer.concat(chunks);
}
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', maxConnections: 2, username: 'pb-user-3301', password: 'pb-pass-7719' });
  built = await makeApp({ url: mock.url, username: mock.username, password: mock.password });
  await built.services.sync.syncCatalog();
  cookie = await login(built.app);
  base = await built.app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  for (const ac of open.splice(0)) ac.abort();
  built.services.playback.sessions.closeAll();
  await until(() => built.services.playback.pool.active === 0 && mock.state().activeConnections === 0, 8000);
});

afterAll(async () => {
  await built.app.close();
  await mock.close();
});

describe('live', () => {
  test('passthrough TS flows, aligned to packets, and two viewers share one upstream', async () => {
    const id = ids('live_h264_aac', 'live')[0]!;
    const pi = await info(`/api/play/live/${id}`, MSE);
    expect(pi).toMatchObject({ type: 'mpegts', pipeline: 'passthrough', url: `/api/stream/live/${id}.ts` });
    const a = await get(pi.url);
    expect(a.res.headers.get('content-type')).toBe('video/mp2t');
    const bytesA = await readBytes(a.res, 100_000);
    expect(bytesA[0]).toBe(0x47);
    const b = await get(pi.url);
    const bytesB = await readBytes(b.res, 50_000);
    expect(bytesB[0]).toBe(0x47);
    expect(bytesB[188]).toBe(0x47);
    expect(built.services.playback.pool.active).toBe(1);
    expect(mock.state().activeConnections).toBe(1);
  });

  test('live HLS remux for clients without MSE', async () => {
    const id = ids('live_h264_aac', 'live')[1]!;
    const pi = await info(`/api/play/live/${id}`, NO_MSE);
    expect(pi).toMatchObject({ type: 'hls', pipeline: 'remux' });
    const pl = await (await get(pi.url)).res.text();
    expect(pl).toContain('#EXTINF');
    const seg = pl.split('\n').find((l) => l.endsWith('.m4s'))!;
    const res = (await get(pi.url.replace('index.m3u8', seg))).res;
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  test('connection limit gives a clear 429', async () => {
    const [x, y, z] = ids('live_h264_aac', 'live');
    for (const id of [x, y]) {
      const pi = await info(`/api/play/live/${id}`, MSE);
      await readBytes((await get(pi.url)).res, 1000);
    }
    const { res } = await get(`/api/play/live/${z}`, MSE);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: 'connection_limit', message: expect.stringContaining('2 provider connections') });
  });

  test('timeline and timeshift playback for an archive channel', async () => {
    const ch = mock.catalog.live.find((c) => c.archive && c.profile === 'live_h264_aac')!;
    const tl = (await (await get(`/api/timeline/${ch.id}`)).res.json()) as TimelineInfo;
    expect(tl.ranges.map((r) => r.source)).toEqual(['archive', 'live']);
    expect(tl.ranges[0]!.start).toBe(tl.now - ch.archiveDays * 86400_000);
    expect(tl.gaps).toEqual([]);
    const at = Date.now() - 30 * 60_000;
    const pi = await info(`/api/play/live/${ch.id}/at?at=${at}`, MSE);
    expect(pi.type).toBe('mpegts');
    expect(pi.startsAt).toBe(Math.floor(at / 60_000) * 60_000);
    expect(pi.url).toMatch(/^\/api\/stream\/timeshift\//);
    const { res } = await get(pi.url);
    expect(res.status).toBe(200);
    expect((await readBytes(res, 20_000))[0]).toBe(0x47);

    const noArchive = mock.catalog.live.find((c) => !c.archive)!;
    const tl2 = (await (await get(`/api/timeline/${noArchive.id}`)).res.json()) as TimelineInfo;
    expect(tl2.gaps[0]!.reason).toBe('This channel has no archive');
    const refused = await get(`/api/play/live/${noArchive.id}/at?at=${at}`, MSE);
    expect(refused.res.status).toBe(422);
  });
});

describe('vod', () => {
  test('MP4 H.264/AAC is passed through with range support', async () => {
    const id = ids('mp4_h264_aac', 'movie')[0]!;
    const pi = await info(`/api/play/movie/${id}`, MSE);
    expect(pi).toMatchObject({ type: 'file', pipeline: 'passthrough', url: `/api/stream/movie/${id}/video.mp4` });
    const { res } = await get(pi.url, undefined, { range: 'bytes=0-1023' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
    expect((await res.arrayBuffer()).byteLength).toBe(1024);
  });

  test('MKV HEVC/AC3 becomes seekable HLS with AAC audio', async () => {
    const id = ids('mkv_hevc_ac3', 'movie')[0]!;
    const duration = FORMAT_MATRIX.find((f) => f.id === 'mkv_hevc_ac3' && f.kind === 'movie')!.durations![id]!;
    const pi = await info(`/api/play/movie/${id}`, HEVC_NO_AC3);
    expect(pi).toMatchObject({ type: 'hls', pipeline: 'transcode-audio' });
    const pl = await (await get(pi.url)).res.text();
    const durations = [...pl.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
    expect(pl).toContain('#EXT-X-ENDLIST');
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(duration, 0);

    const dir = mkdtempSync(path.join(os.tmpdir(), 'anycast-seg-'));
    const fetchFile = async (name: string) => {
      const { res } = await get(pi.url.replace('index.m3u8', name));
      expect(res.status, name).toBe(200);
      return Buffer.from(await res.arrayBuffer());
    };
    const init = await fetchFile('init.mp4');
    const firstPts = async (n: number) => {
      const file = path.join(dir, `s${n}.mp4`);
      writeFileSync(file, Buffer.concat([init, await fetchFile(`seg/${n}.m4s`)]));
      const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,codec_name', '-show_entries', 'stream=codec_name', '-read_intervals', '%+#1', '-of', 'json', file]).toString();
      return JSON.parse(out) as { packets: { pts_time: string }[]; streams: { codec_name: string }[] };
    };
    const s0 = await firstPts(0);
    expect(s0.streams[0]!.codec_name).toBe('hevc');
    expect(Number(s0.packets[0]!.pts_time)).toBeLessThan(1);
    // jump far ahead: ffmpeg restarts there and the segment carries its true media time
    const far = Math.floor(durations.length * 0.75);
    const sFar = await firstPts(far);
    expect(Number(sFar.packets[0]!.pts_time)).toBeGreaterThan(far * 6 - 6);
    expect(Number(sFar.packets[0]!.pts_time)).toBeLessThan(far * 6 + 1);
    const audio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(dir, `s${far}.mp4`)]).toString().trim();
    expect(audio).toBe('aac');
    // last slot also delivers the tail
    const last = await fetchFile(`seg/${durations.length - 1}.m4s`);
    expect(last.byteLength).toBeGreaterThan(1000);
    expect(built.services.playback.pool.active).toBeLessThanOrEqual(1);
  });

  test('stream ids are AnyCast ids and responses never carry provider details', async () => {
    const all = seen.join('\n');
    for (const secret of [mock.username, mock.password, new URL(mock.url).host]) expect(all).not.toContain(secret);
  });
});
