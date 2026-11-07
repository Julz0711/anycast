import { recapPersona, type Me, type Recap } from '@anycast/shared';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { exportBackup, restoreBackup } from '../src/backup/backup';
import { genreOf, recordWatch } from '../src/recap';
import { createMockXtream, login, makeApp } from './helpers';

const CREDS = { username: 'mock-user-5521', password: 'mock-pass-8873' };
let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let profileId: string;

const call = (opts: InjectOptions) => built.app.inject({ ...opts, headers: { cookie, ...(opts.headers ?? {}) } });
const json = async <T>(opts: InjectOptions) => (await call(opts)).json() as T;

const H = 3_600_000;
// Monday 2026-10-05 00:00 UTC
const MON = Date.UTC(2026, 9, 5);

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', ...CREDS });
  built = await makeApp({ url: mock.url, username: CREDS.username, password: CREDS.password });
  await built.services.sync.syncAll();
  cookie = await login(built.app);
  profileId = (await json<Me>({ url: '/api/me' })).profiles[0]!.id;
});

afterAll(async () => {
  await built.app.close();
  await mock.close();
});

const db = () => built.services.db;
const normal = (table: 'channels' | 'movies' | 'series', n = 0) =>
  (db().prepare(`SELECT t.id FROM ${table} t JOIN categories k ON k.id = t.category_id WHERE k.adult = 0 ORDER BY t.id LIMIT 1 OFFSET ?`).get(n) as { id: string }).id;

describe('watch history', () => {
  test('the player reports played time; bad reports are refused', async () => {
    const ch = normal('channels');
    expect((await json<{ ok: boolean }>({ method: 'POST', url: '/api/watch-time', payload: { kind: 'live', id: ch, seconds: 60 } })).ok).toBe(true);
    expect((await call({ method: 'POST', url: '/api/watch-time', payload: { kind: 'live', id: ch, seconds: 100_000 } })).statusCode).toBe(400);
    expect((await call({ method: 'POST', url: '/api/watch-time', payload: { kind: 'tv', id: ch, seconds: 5 } })).statusCode).toBe(400);
    const row = db().prepare('SELECT SUM(seconds) AS s FROM watch_history WHERE profile_id = ?').get(profileId) as { s: number };
    expect(row.s).toBe(60);
  });

  test('nothing is recorded with history turned off', async () => {
    await call({ method: 'PUT', url: '/api/preferences', payload: { history: { record: false } } });
    const res = await json<{ ok: boolean }>({ method: 'POST', url: '/api/watch-time', payload: { kind: 'live', id: normal('channels'), seconds: 30 } });
    expect(res.ok).toBe(false);
    await call({ method: 'PUT', url: '/api/preferences', payload: { history: { record: true } } });
    await call({ method: 'DELETE', url: '/api/watch-history' });
    expect((db().prepare('SELECT COUNT(*) AS n FROM watch_history').get() as { n: number }).n).toBe(0);
  });
});

describe('recap', () => {
  test('adds up time, tops, hours, days and streaks in the viewer time zone', async () => {
    const [ch1, ch2] = [normal('channels', 0), normal('channels', 1)];
    const movie = normal('movies');
    const series = normal('series');
    await json({ url: `/api/series/${series}` }); // fetches the episodes
    const eps = db().prepare('SELECT id FROM episodes WHERE series_id = ? ORDER BY season, episode LIMIT 3').all(series) as { id: string }[];
    expect(eps.length).toBeGreaterThan(1);

    // Mon 21:00 UTC = 23:00 in Amsterdam (CEST): 50 min of channel 1
    for (let i = 0; i < 5; i++) recordWatch(db(), profileId, { kind: 'live', id: ch1, seconds: 600 }, MON + 21 * H);
    // Tue 19:00 UTC: a whole movie
    for (let i = 0; i < 10; i++) recordWatch(db(), profileId, { kind: 'movie', id: movie, seconds: 600 }, MON + 24 * H + 19 * H);
    // Wed: two episodes; Fri: a peek at channel 2 (too short to count)
    for (const e of eps.slice(0, 2)) for (let i = 0; i < 4; i++) recordWatch(db(), profileId, { kind: 'episode', id: e.id, seconds: 600 }, MON + 2 * 24 * H + 18 * H);
    recordWatch(db(), profileId, { kind: 'live', id: ch2, seconds: 20 }, MON + 4 * 24 * H + 10 * H);
    // outside the period
    recordWatch(db(), profileId, { kind: 'live', id: ch1, seconds: 600 }, MON - 3 * 24 * H);

    const from = Date.UTC(2026, 9, 4, 22); // Mon 00:00 Amsterdam
    const r = await json<Recap>({ url: `/api/recap?from=${from}&to=${from + 7 * 24 * H}&tz=Europe/Amsterdam` });
    expect(r.tz).toBe('Europe/Amsterdam');
    expect(r.byKind).toEqual({ live: 3020, movie: 6000, episode: 4800 });
    expect(r.totalSeconds).toBe(13_820);
    expect(r.previousSeconds).toBe(600);
    expect(r.counts).toMatchObject({ channels: 1, movies: 1, episodes: 2, series: 1, days: 4 });
    expect(r.topChannels.map((c) => c.id)).toEqual([ch1]);
    expect(r.topChannels[0]!.count).toBe(1);
    expect(r.topMovies[0]).toMatchObject({ id: movie, seconds: 6000 });
    expect(r.topSeries[0]).toMatchObject({ id: series, kind: 'series', count: 2 });
    expect(r.hours[23]).toBe(3000);
    expect(r.weekdays[0]).toBe(3000);
    expect(r.topDay).toEqual({ date: '2026-10-06', seconds: 6000 });
    expect(r.longestStreak).toBe(3);
    expect(r.first).toMatchObject({ kind: 'live', id: ch1 });
    expect(r.genres.length).toBeGreaterThan(0);
    expect(r.genres.every((g) => !g.name.includes(' · '))).toBe(true);
    expect(recapPersona(r).title).toBeTruthy();

    // an unknown time zone falls back to UTC
    const utc = await json<Recap>({ url: `/api/recap?from=${from}&to=${from + 7 * 24 * H}&tz=Mars/Base` });
    expect(utc.tz).toBe('UTC');
    expect(utc.hours[21]).toBe(3000);
    expect((await call({ url: '/api/recap?from=10&to=5' })).statusCode).toBe(400);
  });

  test('hidden adult titles stay out of the recap', async () => {
    const cat = (db().prepare("SELECT id FROM categories WHERE adult = 1 AND kind = 'live'").get() as { id: string }).id;
    const ch = (db().prepare('SELECT id FROM channels WHERE category_id = ?').get(cat) as { id: string }).id;
    const at = MON + 30 * 24 * H;
    recordWatch(db(), profileId, { kind: 'live', id: ch, seconds: 600 }, at);
    const r = await json<Recap>({ url: `/api/recap?from=${at}&to=${at + H}` });
    expect(r.totalSeconds).toBe(0);
    expect(r.topChannels).toEqual([]);
  });

  test('a backup keeps the history', () => {
    const before = db().prepare('SELECT COUNT(*) AS n FROM watch_history').get() as { n: number };
    const file = exportBackup(db());
    expect(file.users[0]!.profiles[0]!.watchHistory!.length).toBe(before.n);
    db().prepare('DELETE FROM watch_history').run();
    restoreBackup(db(), file, { mode: 'merge' });
    expect((db().prepare('SELECT COUNT(*) AS n FROM watch_history').get() as { n: number }).n).toBe(before.n);
  });

  test('genre names drop the region', () => {
    expect(genreOf('UK · Sports')).toBe('Sports');
    expect(genreOf('Documentaries')).toBe('Documentaries');
  });
});
