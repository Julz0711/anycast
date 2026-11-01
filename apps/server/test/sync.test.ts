import { afterAll, beforeAll, expect, test } from 'vitest';
import { FAKE, startFakeXtream } from './fixtures/fake-xtream';
import { hideClause } from '../src/catalog/store';
import { SEARCH_LIMIT } from '../src/search';
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

test('one and two letter prefixes stay fast, and each group is capped', async () => {
  const times: number[] = [];
  for (const q of ['a', 'e', 's', 't', 'n', 'ca', 'ri', 'th', 'ub', 'se', 'garden', 'river 1']) {
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const res = await built.app.inject({ url: `/api/search?q=${encodeURIComponent(q)}`, headers: { cookie } });
      times.push(performance.now() - t);
      const body = res.json() as { live: unknown[]; movies: unknown[]; series: unknown[] };
      for (const group of [body.live, body.movies, body.series]) expect(group.length).toBeLessThanOrEqual(SEARCH_LIMIT);
    }
  }
  times.sort((a, b) => a - b);
  expect(times[Math.ceil(times.length * 0.95) - 1]).toBeLessThan(150);
  // names that start with the query come first
  const r = (await built.app.inject({ url: '/api/search?q=ri', headers: { cookie } })).json() as { movies: { name: string }[] };
  expect(r.movies[0]?.name.toLowerCase().startsWith('ri')).toBe(true);
});

test('list pages walk their index, also with hide rules and the guide filter', async () => {
  const db = built.services.db;
  const plan = (sql: string, ...params: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(' | ');
  const rules = { countries: ['de'], languages: ['de', 'fr'], categoryIds: [] };
  for (const [table, kind] of [['movies', 'movie'], ['series', 'series'], ['channels', 'live']] as const) {
    const hide = hideClause(rules, 't');
    const order = kind === 'live' ? 't.number, t.country, t.language, t.category_id, t.has_epg, t.rowid' : 't.added DESC, t.country, t.language, t.category_id, t.rowid';
    const p = plan(`SELECT t.* FROM ${table} t WHERE ${hide.sql} ORDER BY ${order} LIMIT 100 OFFSET 1000`, ...hide.params);
    expect(p, table).toMatch(/USING INDEX/);
    expect(p, table).not.toMatch(/TEMP B-TREE/);
    expect(plan(`SELECT count(*) FROM ${table} t WHERE ${hide.sql}`, ...hide.params), table).toMatch(/COVERING INDEX/);
  }
  await built.app.inject({ method: 'PUT', url: '/api/hide-rules', headers: { cookie }, payload: rules });
  try {
    const t = performance.now();
    const deep = (await built.app.inject({ url: '/api/movies?offset=15000&limit=100', headers: { cookie } })).json() as { items: { language: string | null }[] };
    expect(performance.now() - t).toBeLessThan(150);
    expect(deep.items.every((m) => m.language !== 'de' && m.language !== 'fr')).toBe(true);
  } finally {
    await built.app.inject({ method: 'PUT', url: '/api/hide-rules', headers: { cookie }, payload: { countries: [], languages: [], categoryIds: [] } });
  }
  // only channels with guide data: the fake guide covers ch1, ch6, ch11, ... below 200
  const withEpg = (await built.app.inject({ url: '/api/live?hasEpg=1&limit=500', headers: { cookie } })).json() as { total: number; items: { hasEpg: boolean; epgChannelId: string | null }[] };
  expect(withEpg.total).toBe(40);
  expect(withEpg.items.every((c) => c.hasEpg && c.epgChannelId)).toBe(true);
  const all = (await built.app.inject({ url: '/api/live?limit=20', headers: { cookie } })).json() as { items: { hasEpg: boolean }[] };
  expect(all.items.some((c) => !c.hasEpg)).toBe(true);
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
