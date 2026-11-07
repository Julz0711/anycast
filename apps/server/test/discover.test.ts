import type { Movie, MovieDetail, NewEpisodes, Page, Series, SeriesDetail } from '@anycast/shared';
import type { InjectOptions } from 'fastify';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ArtCache, sniffImage } from '../src/routes/art';
import { createMockXtream, login, makeApp } from './helpers';

const CREDS = { username: 'mock-user-5521', password: 'mock-pass-8873' };
let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;

const call = (opts: InjectOptions) => built.app.inject({ ...opts, headers: { cookie, ...(opts.headers ?? {}) } });
const json = async <T>(opts: InjectOptions) => (await call(opts)).json() as T;

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', ...CREDS });
  built = await makeApp({ url: mock.url, username: CREDS.username, password: CREDS.password });
  await built.services.sync.syncAll();
  cookie = await login(built.app);
});

afterAll(async () => {
  await built.app.close();
  await mock.close();
});

describe('sorting and filtering movies and series', () => {
  test('by name, year and rating, with year and rating filters', async () => {
    const byName = await json<Page<Movie>>({ url: '/api/movies?sort=name&limit=500' });
    const names = byName.items.map((m) => m.name.toLowerCase());
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    const byYear = await json<Page<Movie>>({ url: '/api/movies?sort=year&limit=500' });
    const years = byYear.items.map((m) => m.year ?? -1);
    expect(years).toEqual([...years].sort((a, b) => b - a));

    const byRating = await json<Page<Series>>({ url: '/api/series?sort=rating&limit=500' });
    const ratings = byRating.items.map((s) => s.rating ?? -1);
    expect(ratings).toEqual([...ratings].sort((a, b) => b - a));

    const mid = years.filter((y) => y > 0)[Math.floor(years.length / 2)]!;
    const recent = await json<Page<Movie>>({ url: `/api/movies?yearFrom=${mid}&limit=500` });
    expect(recent.total).toBeGreaterThan(0);
    expect(recent.items.every((m) => (m.year ?? 0) >= mid)).toBe(true);
    const older = await json<Page<Movie>>({ url: `/api/movies?yearTo=${mid - 1}&limit=500` });
    expect(older.items.every((m) => m.year !== null && m.year < mid)).toBe(true);
    expect(recent.total + older.total).toBeLessThanOrEqual(byYear.total);

    const good = await json<Page<Movie>>({ url: '/api/movies?minRating=7&limit=500' });
    expect(good.items.every((m) => (m.rating ?? 0) >= 7)).toBe(true);
  });

  test('movies and series say when they were added', async () => {
    const page = await json<Page<Movie>>({ url: '/api/movies?limit=5' });
    expect(page.items.some((m) => typeof m.added === 'number')).toBe(true);
  });
});

describe('movie details', () => {
  test('come from the provider once and are cached', async () => {
    const m = (await json<Page<Movie>>({ url: '/api/movies?limit=1' })).items[0]!;
    const d = await json<MovieDetail>({ url: `/api/movies/${m.id}` });
    expect(d).toMatchObject({ id: m.id, name: m.name });
    expect(d.plot).toBeTruthy();
    expect('genre' in d && 'cast' in d && 'trailer' in d).toBe(true);
    const row = built.services.db.prepare('SELECT fetched_at FROM movie_info WHERE movie_id = ?').get(m.id) as { fetched_at: number };
    expect(row.fetched_at).toBeGreaterThan(0);
    await json<MovieDetail>({ url: `/api/movies/${m.id}` });
    const again = built.services.db.prepare('SELECT fetched_at FROM movie_info WHERE movie_id = ?').get(m.id) as { fetched_at: number };
    expect(again.fetched_at).toBe(row.fetched_at);
    if (d.backdrop) {
      expect(d.backdrop).toMatch(new RegExp(`^/api/art/backdrop/${m.id}\\?v=`));
      const art = await call({ url: d.backdrop });
      expect(art.statusCode).toBe(200);
      expect(art.headers['cache-control']).toContain('immutable');
    }
    expect((await call({ url: '/api/movies/nope' })).statusCode).toBe(404);
  });
});

describe('artwork', () => {
  test('is kept on disk and served from there', async () => {
    const m = (await json<Page<Movie>>({ url: '/api/movies?limit=20' })).items.find((x) => x.poster)!;
    const first = await call({ url: m.poster! });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toContain('immutable');
    const dir = path.join(built.services.config.dataDir, 'art');
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    const second = await call({ url: m.poster!.replace(/\?v=.*/, '') });
    expect(second.statusCode).toBe(200);
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
    // an unversioned URL is kept for a day only
    expect(second.headers['cache-control']).not.toContain('immutable');
  });

  test('sniffs image types and prunes the least recently used', async () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('\x89PNG\r\n', 'latin1'))).toBe('image/png');
    expect(sniffImage(Buffer.from('<svg xmlns="x"></svg>'))).toBe('image/svg+xml');
    expect(sniffImage(Buffer.from('<html>'))).toBeNull();
    const dir = mkdtempSync(path.join(tmpdir(), 'art-'));
    const cache = new ArtCache(dir, 1000);
    for (let i = 0; i < 5; i++) {
      await cache.put(`http://x/${i}`, Buffer.alloc(300, i));
      await new Promise((r) => setTimeout(r, 15));
    }
    await cache.prune();
    expect(readdirSync(dir).length).toBeLessThanOrEqual(2);
    expect(await cache.get('http://x/4')).not.toBeNull();
    expect(await cache.get('http://x/0')).toBeNull();
  });
});

describe('new episodes', () => {
  test('of a favorite series show until the series is opened', async () => {
    const db = built.services.db;
    const s = (await json<Page<Series>>({ url: '/api/series?limit=1' })).items[0]!;
    // not followed: nothing new
    expect(await json<NewEpisodes[]>({ url: '/api/new-episodes' })).toEqual([]);
    await call({ method: 'PUT', url: '/api/favorites', payload: { kind: 'series', id: s.id, favorite: true } });
    // the first fetch's episodes are not new
    const detail = await json<SeriesDetail>({ url: `/api/series/${s.id}` });
    expect(detail.seasons.flatMap((x) => x.episodes).some((e) => e.isNew)).toBe(false);
    expect(await json<NewEpisodes[]>({ url: '/api/new-episodes' })).toEqual([]);

    // the provider adds an episode later
    const later = Date.now() + 1000;
    db.prepare(
      `INSERT INTO episodes (id, series_id, season, episode, title, plot, duration, container, first_seen) VALUES ('new-ep-1', ?, 99, 1, 'Brand new', NULL, NULL, 'mp4', ?)`,
    ).run(s.id, later);
    const fresh = await json<NewEpisodes[]>({ url: '/api/new-episodes' });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.series.id).toBe(s.id);
    expect(fresh[0]!.episodes.map((e) => e.id)).toEqual(['new-ep-1']);

    // opening the series marks it on that page, and clears it afterwards
    db.prepare('UPDATE series SET episodes_synced_at = ? WHERE id = ?').run(Date.now(), s.id);
    db.prepare('UPDATE series_seen SET seen_at = ? WHERE series_id = ?').run(Date.now() - 2000, s.id);
    db.prepare("UPDATE favorites SET added_at = ? WHERE kind = 'series' AND item_id = ?").run(Date.now() - 5000, s.id);
    db.prepare("UPDATE episodes SET first_seen = ? WHERE id = 'new-ep-1'").run(Date.now() - 1000);
    const opened = await json<SeriesDetail>({ url: `/api/series/${s.id}` });
    expect(opened.seasons.flatMap((x) => x.episodes).filter((e) => e.isNew).map((e) => e.id)).toEqual(['new-ep-1']);
    expect(await json<NewEpisodes[]>({ url: '/api/new-episodes' })).toEqual([]);
    const reopened = await json<SeriesDetail>({ url: `/api/series/${s.id}` });
    expect(reopened.seasons.flatMap((x) => x.episodes).some((e) => e.isNew)).toBe(false);
  });

  test('keep first_seen when the provider sends the episodes again', async () => {
    const db = built.services.db;
    const s = (await json<Page<Series>>({ url: '/api/series?limit=2' })).items[1]!;
    await json<SeriesDetail>({ url: `/api/series/${s.id}` });
    const before = db.prepare('SELECT id, first_seen FROM episodes WHERE series_id = ?').all(s.id) as { id: string; first_seen: number }[];
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((e) => e.first_seen === 0)).toBe(true);
    // a refetch (the provider changed the series): known episodes stay as they were
    db.prepare('UPDATE series SET episodes_synced_at = NULL WHERE id = ?').run(s.id);
    db.prepare('DELETE FROM episodes WHERE id = ?').run(before[0]!.id);
    await built.services.sync.ensureEpisodes(s.id);
    const after = db.prepare('SELECT id, first_seen FROM episodes WHERE series_id = ?').all(s.id) as { id: string; first_seen: number }[];
    expect(after).toHaveLength(before.length);
    expect(after.find((e) => e.id === before[0]!.id)!.first_seen).toBeGreaterThan(0);
    expect(after.filter((e) => e.id !== before[0]!.id).every((e) => e.first_seen === 0)).toBe(true);
  });
});
