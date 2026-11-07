import type { MediaList, Movie, Page, SwipeDeck } from '@anycast/shared';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createMockXtream, login, makeApp } from './helpers';

const CREDS = { username: 'mock-user-5521', password: 'mock-pass-8873' };
let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;

const call = (opts: InjectOptions) => built.app.inject({ ...opts, headers: { cookie, ...(opts.headers ?? {}) } });
const json = async <T>(opts: InjectOptions) => (await call(opts)).json() as T;
const keys = (d: SwipeDeck) => d.cards.map((c) => `${c.kind}:${c.item.id}`);

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

describe('swipe deck', () => {
  test('deals random movies and series with posters, no title twice, none of the skipped ones', async () => {
    const deck = await json<SwipeDeck>({ url: '/api/swipe?limit=30' });
    expect(deck.cards.length).toBe(30);
    expect(new Set(keys(deck)).size).toBe(30);
    expect(deck.cards.some((c) => c.kind === 'movie')).toBe(true);
    expect(deck.cards.some((c) => c.kind === 'series')).toBe(true);
    expect(deck.cards.every((c) => !!c.item.poster)).toBe(true);
    expect(deck.left).toBeGreaterThanOrEqual(30);

    const skip = keys(deck).join(',');
    const next = await json<SwipeDeck>({ url: `/api/swipe?limit=30&skip=${encodeURIComponent(skip)}` });
    const held = new Set(keys(deck));
    expect(keys(next).filter((k) => held.has(k))).toEqual([]);

    const movies = await json<SwipeDeck>({ url: '/api/swipe?kind=movie&minRating=7' });
    expect(movies.cards.length).toBeGreaterThan(0);
    expect(movies.cards.every((c) => c.kind === 'movie' && (c.item.rating ?? 0) >= 7)).toBe(true);
  });

  test('a category narrows a single kind', async () => {
    const page = await json<Page<Movie>>({ url: '/api/movies?limit=1' });
    const categoryId = page.items[0]!.categoryId;
    const deck = await json<SwipeDeck>({ url: `/api/swipe?kind=movie&categoryId=${categoryId}&limit=50` });
    expect(deck.cards.length).toBeGreaterThan(0);
    expect(deck.cards.every((c) => c.item.categoryId === categoryId)).toBe(true);
    expect(deck.left).toBeLessThan((await json<SwipeDeck>({ url: '/api/swipe?kind=movie&limit=1' })).left);
  });

  test('passed titles and titles in Watch Later leave the deck; undo and reset bring them back', async () => {
    const all = await json<SwipeDeck>({ url: '/api/swipe?kind=series&limit=50' });
    const [a, b] = all.cards as [SwipeDeck['cards'][number], SwipeDeck['cards'][number]];
    expect(await json({ method: 'POST', url: '/api/swipe/passed', payload: { kind: a.kind, id: a.item.id } })).toEqual({ passed: 1 });
    const lists = await json<MediaList[]>({ url: '/api/media-lists' });
    await call({ method: 'PUT', url: `/api/media-lists/${lists[0]!.id}/items`, payload: { items: [{ kind: b.kind, id: b.item.id }] } });

    const after = await json<SwipeDeck>({ url: '/api/swipe?kind=series&limit=50' });
    expect(after.left).toBe(all.left - 2);
    // the small catalog fits in a few decks: deal them all and look for the two titles
    const seen = new Set<string>();
    for (let i = 0; i < 20 && seen.size < after.left; i++) {
      const d = await json<SwipeDeck>({ url: '/api/swipe?kind=series&limit=50' });
      keys(d).forEach((k) => seen.add(k));
    }
    expect(seen.has(`series:${a.item.id}`)).toBe(false);
    expect(seen.has(`series:${b.item.id}`)).toBe(false);

    expect(await json({ method: 'DELETE', url: `/api/swipe/passed/series/${a.item.id}` })).toEqual({ passed: 0 });
    expect((await json<SwipeDeck>({ url: '/api/swipe?kind=series&limit=1' })).left).toBe(all.left - 1);

    await call({ method: 'POST', url: '/api/swipe/passed', payload: { kind: 'series', id: a.item.id } });
    expect(await json({ url: '/api/swipe/passed' })).toEqual({ passed: 1 });
    expect(await json({ method: 'DELETE', url: '/api/swipe/passed' })).toEqual({ passed: 0 });
  });

  test('bad input', async () => {
    expect((await call({ method: 'POST', url: '/api/swipe/passed', payload: { kind: 'live', id: 'x' } })).statusCode).toBe(400);
    expect((await call({ method: 'DELETE', url: '/api/swipe/passed/live/x' })).statusCode).toBe(400);
  });
});
