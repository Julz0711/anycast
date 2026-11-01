import { afterAll, beforeAll, expect, test } from 'vitest';
import { FAKE, startFakeXtream } from './fixtures/fake-xtream';
import { login, makeApp } from './helpers';

const SIZE = { live: 20_000, movies: 25_000, series: 5_000 };
let fake: Awaited<ReturnType<typeof startFakeXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;

beforeAll(async () => {
  fake = await startFakeXtream(SIZE);
  built = await makeApp({ url: fake.url, ...FAKE });
  cookie = await login(built.app);
});

afterAll(async () => {
  await built.app.close();
  await fake.close();
});

test('50k items sync well under 2 minutes, without blocking the event loop for long', async () => {
  let maxLag = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 10);
    last = now;
  }, 10);
  const started = Date.now();
  await built.services.sync.syncAll();
  clearInterval(timer);
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(120_000);
  expect(maxLag).toBeLessThan(1500);
  const src = (await built.app.inject({ url: '/api/source', headers: { cookie } })).json();
  expect(src.counts).toEqual({ live: SIZE.live, movie: SIZE.movies, series: SIZE.series });
});

test('quirky panel data is parsed defensively', async () => {
  const movies = (await built.app.inject({ url: '/api/movies?limit=3', headers: { cookie } })).json();
  expect(movies.items[0]).toMatchObject({ year: expect.any(Number), name: expect.not.stringMatching(/\(\d{4}\)$/) });
  const live = (await built.app.inject({ url: '/api/live?limit=4', headers: { cookie } })).json();
  expect(live.items.map((c: { archiveDays: number }) => c.archiveDays)).toEqual([0, 1, 0, 3]);
  expect(live.items[0].now).toBeNull();
  expect(live.items[1].now).toMatchObject({ title: 'Show 1/0 & more', description: 'About <it>' });
  const detail = (await built.app.inject({ url: '/api/series/1', headers: { cookie } })).json();
  expect(detail.seasons.map((s: { season: number; episodes: { duration: number | null }[] }) => [s.season, s.episodes.map((e) => e.duration)])).toEqual([
    [1, [1500, null]],
    [2, [2700]],
  ]);
});

test('search answers in under 150 ms on 50k items', async () => {
  const queries = ['cafe', 'señ', 'ub', 'river 12', 'garden echo', 'n', 'zzzz'];
  for (const q of queries) {
    const t = performance.now();
    const res = await built.app.inject({ url: `/api/search?q=${encodeURIComponent(q)}`, headers: { cookie } });
    const ms = performance.now() - t;
    expect(res.statusCode).toBe(200);
    expect(ms, q).toBeLessThan(150);
  }
  const hit = (await built.app.inject({ url: '/api/search?q=uber', headers: { cookie } })).json();
  expect(hit.movies.length).toBeGreaterThan(0);
  expect(hit.movies[0].name).toContain('Über');
});

test('a second sync updates in place and keeps favorites', async () => {
  await built.app.inject({ method: 'PUT', url: '/api/favorites', headers: { cookie }, payload: { kind: 'live', id: '5', favorite: true } });
  await built.services.sync.syncCatalog();
  const favs = (await built.app.inject({ url: '/api/favorites', headers: { cookie } })).json();
  expect(favs).toHaveLength(1);
  const n = built.services.db.prepare('SELECT count(*) AS n FROM search_fts').get() as { n: number };
  expect(n.n).toBe(SIZE.live + SIZE.movies + SIZE.series);
});

test('login is rate limited', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) {
    codes.push((await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'x', password: 'y' } })).statusCode);
  }
  expect(codes).toContain(429);
});
