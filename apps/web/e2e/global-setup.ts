/**
 * Starts the mock provider (small catalog) and the AnyCast server (temp DATA_DIR/BUFFER_DIR,
 * serving the built web app via WEB_DIST) on free ports, waits for the first catalog + EPG sync,
 * signs in once (storage state shared by every test) and works out the fixture ids the specs need.
 * Everything is handed to the workers through environment variables.
 */
import type { FullConfig } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN, type E2EFixtures } from './env';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const MOCK = { username: 'e2e-user', password: 'e2e-pass-4471' };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function start(name: string, cwd: string, env: Record<string, string>): ChildProcess {
  const tsx = path.join(cwd, 'node_modules/.bin/tsx');
  const child = spawn(tsx, ['src/main.ts'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log: string[] = [];
  const keep = (b: Buffer) => {
    log.push(String(b));
    if (log.length > 200) log.shift();
    if (process.env.E2E_DEBUG) process.stderr.write(`[${name}] ${b}`);
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  child.on('exit', (code, signal) => {
    if (code && !signal) process.stderr.write(`[${name}] exited with ${code}\n${log.join('')}\n`);
  });
  return child;
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export default async function globalSetup(_config: FullConfig) {
  const webDist = path.join(repo, 'apps/web/dist');
  if (!existsSync(path.join(webDist, 'index.html'))) throw new Error('apps/web/dist is missing: run `pnpm --filter @anycast/web build` first (pnpm e2e does)');

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'anycast-e2e-'));
  const [mockPort, serverPort] = await Promise.all([freePort(), freePort()]);
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  const base = `http://127.0.0.1:${serverPort}`;

  const mock = start('mock', path.join(repo, 'tools/mock-xtream'), {
    PORT: String(mockPort), HOST: '127.0.0.1', SIZE: 'small', MAX_CONNECTIONS: '50',
    MOCK_USERNAME: MOCK.username, MOCK_PASSWORD: MOCK.password,
  });
  const server = start('server', path.join(repo, 'apps/server'), {
    PORT: String(serverPort), HOST: '127.0.0.1',
    DATA_DIR: path.join(tmp, 'data'), BUFFER_DIR: path.join(tmp, 'buffer'), WEB_DIST: webDist,
    XTREAM_URL: mockUrl, XTREAM_USERNAME: MOCK.username, XTREAM_PASSWORD: MOCK.password,
    ANYCAST_SECRET: 'e2e-secret-0123456789abcdef', ANYCAST_ADMIN_USER: ADMIN.username, ANYCAST_ADMIN_PASSWORD: ADMIN.password,
    LOG_LEVEL: 'warn', BUFFER_GRACE_MINUTES: '0.2',
  });
  const stop = async () => {
    for (const c of [server, mock]) if (c.exitCode === null) c.kill('SIGTERM');
    await Promise.all(
      [server, mock].map((c) => (c.exitCode !== null ? null : new Promise((r) => { c.once('exit', r); setTimeout(() => (c.kill('SIGKILL'), r(null)), 5000); }))),
    );
    rmSync(tmp, { recursive: true, force: true });
  };

  try {
    await until('the mock', async () => (await fetch(`${mockUrl}/__mock/state`)).ok);
    await until('the server', async () => (await fetch(`${base}/api/health`)).ok);

    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) });
    if (!login.ok) throw new Error(`login failed: ${login.status}`);
    const setCookie = login.headers.getSetCookie().find((c) => c.startsWith('anycast_session='))!;
    const token = setCookie.split(';')[0]!.split('=')[1]!;
    const me = (await login.json()) as { user: { id: string } };
    const get = async <T>(url: string): Promise<T> => {
      const res = await fetch(base + url, { headers: { cookie: `anycast_session=${token}` } });
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return (await res.json()) as T;
    };

    // first catalog + EPG sync (the server starts it on boot)
    await until('the first sync', async () => {
      const s = await get<{ syncing: boolean; lastSync: { catalog: number | null; epg: number | null } }>('/api/source');
      return !s.syncing && s.lastSync.catalog && s.lastSync.epg;
    });

    writeFileSync(
      path.join(tmp, 'state.json'),
      JSON.stringify({
        cookies: [{ name: 'anycast_session', value: token, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
        origins: [],
      }),
    );

    process.env.E2E_BASE_URL = base;
    process.env.E2E_STATE = path.join(tmp, 'state.json');
    process.env.E2E_FIXTURES = JSON.stringify(await fixtures(get, mockUrl, me.user.id));
    return stop;
  } catch (e) {
    await stop();
    throw e;
  }
}

/* ---------------- fixture ids, from the mock's ground truth ---------------- */

interface Ch { id: string; name: string; number: number; archiveDays: number; epgChannelId: string | null; language: string | null }
interface Item { id: string; name: string; language: string | null; duration?: number | null }
interface Cat { id: string; name: string; language: string | null }
interface Program { start: number; end: number }

async function fixtures(get: <T>(url: string) => Promise<T>, mockUrl: string, userId: string): Promise<E2EFixtures> {
  const api = (action: string) =>
    fetch(`${mockUrl}/player_api.php?username=${MOCK.username}&password=${MOCK.password}&action=${action}`).then((r) => r.json()) as Promise<
      { stream_id?: number; series_id?: number }[]
    >;
  const live = (await get<{ items: Ch[] }>('/api/live?limit=500')).items;
  // mock live profile by catalog position: index % 10 == 3 is HEVC, == 7 is AC-3; the rest is H.264/AAC
  const h264 = (c: Ch) => ![3, 7].includes((c.number - 1) % 10);
  const now = Date.now();
  const epg = await get<Record<string, Program[]>>(`/api/epg?channelIds=${live.map((c) => c.id).join(',')}&from=${now - 4 * 3600_000}&to=${now}`);
  const archive = live.find(
    (c) => h264(c) && c.archiveDays > 0 && c.epgChannelId && (epg[c.id] ?? []).some((p) => p.end <= now - 5 * 60_000 && p.start >= now - 3 * 3600_000),
  );
  if (!archive) throw new Error('no H.264 archive channel with a recent past programme in the mock catalog');

  // movies: mock profile by position in get_vod_streams; index % 5 == 0 is MP4 H.264/AAC (direct play)
  const vod = await api('get_vod_streams');
  const movies = (await get<{ items: Item[] }>('/api/movies?limit=500')).items;
  const mp4Ids = new Set(vod.filter((_, i) => i % 5 === 0).map((v) => String(v.stream_id)));
  // mock VOD length is 120 + (id % 3) * 60 s
  const movie = movies.find((m) => mp4Ids.has(m.id) && Number(m.id) % 3 >= 1);
  if (!movie) throw new Error('no MP4 movie of 3+ minutes in the mock catalog');

  // series: episode k of series i uses VOD profile (i + k) % 5; i % 5 == 4 gives TS then MP4, both H.264/AAC
  const seriesList = await api('get_series');
  const binge = seriesList.find((_, i) => i % 5 === 4)!;
  const detail = await get<{ name: string; seasons: { episodes: { id: string; title: string }[] }[] }>(`/api/series/${binge.series_id}`);
  const [ep1, ep2] = detail.seasons[0]!.episodes;

  // The mock generates each VOD file with FFmpeg on first request (several seconds each, longer on
  // small CI runners). A real provider serves files instantly, so generate them here, before the
  // tests start their playback timers.
  const warm = (kind: 'movie' | 'series', id: string) =>
    fetch(`${mockUrl}/${kind}/${MOCK.username}/${MOCK.password}/${id}.bin`, { headers: { range: 'bytes=0-0' } }).then(async (r) => {
      await r.arrayBuffer();
      if (!r.ok) throw new Error(`warming mock ${kind} ${id} failed: ${r.status}`);
    });

  await Promise.all([warm('movie', movie.id), warm('series', ep1!.id), warm('series', ep2!.id)]);

  const liveCats = await get<Cat[]>('/api/categories?kind=live&all=1');
  const movieCats = await get<Cat[]>('/api/categories?kind=movie&all=1');
  const pick = <T extends { language: string | null }>(xs: T[], lang: string, what: string) => {
    const x = xs.find((c) => c.language === lang);
    if (!x) throw new Error(`no ${lang} ${what} in the mock catalog`);
    return x;
  };
  const uniqueName = <T extends { name: string }>(xs: T[], x: T) => xs.filter((y) => y.name === x.name).length === 1;
  const deChannel = live.find((c) => c.language === 'de' && uniqueName(live, c))!;
  const enChannel = live.find((c) => c.language === 'en' && uniqueName(live, c))!;
  const deMovie = movies.find((m) => m.language === 'de' && uniqueName(movies, m))!;
  const enMovie = movies.find((m) => m.language === 'en' && uniqueName(movies, m))!;

  return {
    userId,
    archiveChannel: { id: archive.id, name: archive.name },
    zapChannels: live.slice(0, 3).map((c) => c.id),
    movie: { id: movie.id, name: movie.name },
    series: { id: String(binge.series_id), name: detail.name, ep1: ep1!.id, ep2: ep2!.id, ep2Title: ep2!.title },
    declutter: {
      liveCat: { de: pick(liveCats, 'de', 'live category').name, en: pick(liveCats, 'en', 'live category').name },
      movieCat: { de: pick(movieCats, 'de', 'movie category').name, en: pick(movieCats, 'en', 'movie category').name },
      channel: { de: deChannel.name, en: enChannel.name },
      movie: { de: deMovie.name, en: enMovie.name },
    },
  };
}
