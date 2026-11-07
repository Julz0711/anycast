import type { CastPlayResponse } from '@anycast/shared';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { allows, normalizeBaseUrl, rewriteCastUrl, scopeOfPath } from '../src/cast';
import { createMockXtream, FORMAT_MATRIX, login, makeApp } from './helpers';

const MSE = JSON.stringify({ hls: false, mse: true, codecs: ['avc1', 'mp4a'] });
const CLIENT = { 'x-anycast-client': 'phone-client-0001', 'x-anycast-device': 'Chrome on Android' };

let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let base: string;
const open: AbortController[] = [];

const ids = (profile: string, kind: string) => FORMAT_MATRIX.find((f) => f.id === profile && f.kind === kind)!.ids.map(String);
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};

async function get(url: string, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  open.push(ac);
  return fetch(base + url, { headers, signal: ac.signal });
}

async function castPlay(body: object, headers: Record<string, string> = {}): Promise<CastPlayResponse> {
  const res = await fetch(`${base}/api/cast/play`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', ...CLIENT, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as CastPlayResponse;
}

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', maxConnections: 1, username: 'cast-user-4410', password: 'cast-pass-0921' });
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

describe('cast link helpers', () => {
  test('rewrite strips the token and keeps the query', () => {
    const tok = 'a'.repeat(43);
    const req = { url: `/cast/${tok}/api/stream/live/12/remux/index.m3u8?x=1` } as never;
    expect(rewriteCastUrl(req)).toBe('/api/stream/live/12/remux/index.m3u8?x=1');
    expect((req as { anycastCast?: string }).anycastCast).toBe(tok);
    expect(rewriteCastUrl({ url: '/cast/short/api/stream/live/1.ts' } as never)).toBe('/cast/short/api/stream/live/1.ts');
    expect(rewriteCastUrl({ url: `/cast/${tok}/api/me` } as never)).toBe(`/cast/${tok}/api/me`);
  });

  test('a token opens only its own item', () => {
    const live = scopeOfPath('/api/stream/live/12/remux/index.m3u8')!;
    expect(live).toEqual({ kind: 'live', id: '12' });
    expect(scopeOfPath('/api/stream/buffer/12/3/40/index.m3u8')).toEqual({ kind: 'live', id: '12' });
    expect(scopeOfPath('/api/stream/live/12.ts')).toEqual({ kind: 'live', id: '12' });
    expect(allows(live, '/api/stream/timeshift/12/100/60/remux/index.m3u8')).toBe(true);
    expect(allows(live, '/api/stream/buffer/12/1/2/seg/3.ts')).toBe(true);
    expect(allows(live, '/api/stream/live/123/remux/index.m3u8')).toBe(false);
    expect(allows(live, '/api/stream/movie/12/video.mp4')).toBe(false);
    expect(allows(live, '/api/stream/live/12/../13/remux/index.m3u8')).toBe(false);
    const movie = scopeOfPath('/api/stream/movie/77/video.mp4')!;
    expect(allows(movie, '/api/stream/movie/77/remux/seg/1.m4s')).toBe(true);
    expect(allows(movie, '/api/stream/episode/77/video.mp4')).toBe(false);
    expect(scopeOfPath('/api/me')).toBeNull();
  });

  test('the address for TVs is a bare origin', () => {
    expect(normalizeBaseUrl('http://192.168.1.20:8787/')).toBe('http://192.168.1.20:8787');
    expect(normalizeBaseUrl(' https://tv.example.com ')).toBe('https://tv.example.com');
    expect(normalizeBaseUrl('ftp://x')).toBeNull();
    expect(normalizeBaseUrl('http://u:p@x')).toBeNull();
    expect(normalizeBaseUrl('http://x/path')).toBeNull();
    expect(normalizeBaseUrl('nonsense')).toBeNull();
  });
});

describe('casting', () => {
  test('a Chromecast gets HLS (never raw TS) through a cookieless link, on the phone\'s one connection', async () => {
    const id = ids('live_h264_aac', 'live')[0]!;
    // the phone plays the channel first (raw TS through MSE)
    const phone = await fetch(`${base}/api/play/live/${id}`, { headers: { cookie, 'x-anycast-caps': MSE, ...CLIENT } });
    expect((await phone.json()).type).toBe('mpegts');

    const r = await castPlay({ kind: 'live', id, target: 'chromecast' });
    expect(r.info).toMatchObject({ type: 'hls', pipeline: 'remux' });
    expect(r.castPath).toMatch(new RegExp(`^/cast/[A-Za-z0-9_-]{43}/api/stream/live/${id}/remux/index\\.m3u8$`));
    expect(r.baseUrl).toBeNull();

    // the TV sends no cookie
    const pl = await get(r.castPath, { origin: 'https://www.gstatic.com' });
    const text = await pl.text();
    expect(pl.status, text).toBe(200);
    expect(pl.headers.get('access-control-allow-origin')).toBe('*');
    expect(text).toContain('#EXTM3U');
    // segments are relative, so they keep the token
    const seg = text.split('\n').find((l) => l && !l.startsWith('#'))!;
    expect(seg).not.toMatch(/^\//);
    const media = await get(r.castPath.replace(/index\.m3u8$/, seg));
    expect(media.status).toBe(200);
    expect(mock.state().activeConnections).toBe(1);
    // still one claim: the phone's, now on the TV's stream
    expect(built.services.playback.claims.get(CLIENT['x-anycast-client'])?.key).toBe(`live:${id}`);
  }, 30_000);

  test('preflight is answered, other items and other routes are refused', async () => {
    const [a, b] = ids('live_h264_aac', 'live');
    const r = await castPlay({ kind: 'live', id: a!, target: 'chromecast' });
    const token = r.castPath.split('/')[2]!;
    const pre = await fetch(base + r.castPath, { method: 'OPTIONS', headers: { origin: 'https://www.gstatic.com', 'access-control-request-headers': 'range' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('range');
    const other = await get(`/cast/${token}/api/stream/live/${b}/remux/index.m3u8`);
    expect(other.status).toBe(401);
    expect(other.headers.get('access-control-allow-origin')).toBe('*');
    // not a stream route: the prefix is not rewritten, so it is just not found
    expect((await get(`/cast/${token}/api/me`)).status).toBe(404);
    expect((await get(`/cast/${'x'.repeat(43)}${r.info.url}`)).status).toBe(401);
  });

  test('signing out ends the links', async () => {
    const own = await login(built.app);
    const id = ids('live_h264_aac', 'live')[0]!;
    const r = await castPlay({ kind: 'live', id, target: 'chromecast' }, { cookie: own });
    const ok = await get(r.castPath);
    expect(ok.status).toBe(200);
    await built.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: own } });
    expect((await get(r.castPath)).status).toBe(401);
  }, 30_000);

  test('movies: mp4 plays as a file with ranges; AirPlay keeps the device caps', async () => {
    const movie = ids('mp4_h264_aac', 'movie')[0]!;
    const r = await castPlay({ kind: 'movie', id: movie, target: 'chromecast' });
    expect(r.info).toMatchObject({ type: 'file', url: `/api/stream/movie/${movie}/video.mp4` });
    const res = await get(r.castPath, { range: 'bytes=0-99' });
    expect(res.status).toBe(206);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    await res.arrayBuffer();

    const id = ids('live_h264_aac', 'live')[0]!;
    const air = await castPlay({ kind: 'live', id, target: 'airplay' }, { 'x-anycast-caps': MSE });
    expect(air.info.type).toBe('mpegts');
  }, 30_000);

  test('settings: anyone reads, only an admin sets a valid address', async () => {
    const put = (baseUrl: string | null) =>
      built.app.inject({ method: 'PUT', url: '/api/cast/settings', headers: { cookie }, payload: { baseUrl } });
    expect((await put('not a url')).statusCode).toBe(400);
    expect((await put('http://192.168.1.20:8787/')).json()).toEqual({ baseUrl: 'http://192.168.1.20:8787' });
    expect((await built.app.inject({ url: '/api/cast/settings', headers: { cookie } })).json()).toEqual({ baseUrl: 'http://192.168.1.20:8787' });
    const id = ids('live_h264_aac', 'live')[0]!;
    expect((await castPlay({ kind: 'live', id, target: 'chromecast' })).baseUrl).toBe('http://192.168.1.20:8787');
    expect((await put(null)).json()).toEqual({ baseUrl: null });
  }, 30_000);
});
