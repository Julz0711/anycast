import type { Favorite, HideRules, ItemsById, Me, Page, Profile, SyncEvent } from '@anycast/shared';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createMockXtream, login, makeApp, ADMIN } from './helpers';

const CREDS = { username: 'mock-user-5521', password: 'mock-pass-8873' };
let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
const seen: string[] = [];

async function call(opts: InjectOptions & { profile?: string }) {
  const { profile, ...rest } = opts;
  const res = await built.app.inject({
    ...rest,
    headers: { cookie, ...(profile ? { 'x-anycast-profile': profile } : {}), ...(rest.headers ?? {}) },
  });
  seen.push(res.body, JSON.stringify(res.headers));
  return res;
}
const json = async <T>(opts: InjectOptions & { profile?: string }) => (await call(opts)).json() as T;

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

describe('auth', () => {
  test('health is public, everything else needs a session', async () => {
    expect((await built.app.inject({ url: '/api/health' })).json()).toEqual({ ok: true, version: expect.any(String) });
    const res = await built.app.inject({ url: '/api/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  test('login sets an httpOnly session cookie and returns me', async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    const c = res.cookies.find((x) => x.name === 'anycast_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.maxAge).toBe(90 * 86400);
    const me = res.json() as Me;
    expect(me.user).toMatchObject({ username: 'admin', isAdmin: true });
    expect(me.profiles).toHaveLength(1);
    const stored = built.services.db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(stored.some((s) => s.token_hash === c.value)).toBe(false);
  });

  test('wrong password is rejected', async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'nope' } });
    expect(res.statusCode).toBe(401);
  });

  test('logout ends the session', async () => {
    const own = await login(built.app);
    expect((await built.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: own } })).statusCode).toBe(200);
    expect((await built.app.inject({ url: '/api/me', headers: { cookie: own } })).statusCode).toBe(401);
  });
});

describe('profiles', () => {
  test('create, rename, select by header, isolate data, refuse foreign and last', async () => {
    const first = (await json<Profile[]>({ url: '/api/profiles' }))[0]!;
    const kid = await json<Profile>({ method: 'POST', url: '/api/profiles', payload: { name: 'Kids' } });
    expect((await json<Profile>({ method: 'PATCH', url: `/api/profiles/${kid.id}`, payload: { name: 'Kinder' } })).name).toBe('Kinder');
    expect((await json<Me>({ url: '/api/me' })).profiles.map((p) => p.name)).toEqual(['admin', 'Kinder']);

    await call({ method: 'PUT', url: '/api/favorites', profile: kid.id, payload: { kind: 'live', id: '1', favorite: true } });
    expect(await json<Favorite[]>({ url: '/api/favorites', profile: kid.id })).toHaveLength(1);
    expect(await json<Favorite[]>({ url: '/api/favorites', profile: first.id })).toHaveLength(0);

    expect((await call({ url: '/api/favorites', profile: 'not-mine' })).statusCode).toBe(403);
    expect((await call({ method: 'DELETE', url: `/api/profiles/${kid.id}` })).statusCode).toBe(200);
    const last = await call({ method: 'DELETE', url: `/api/profiles/${first.id}` });
    expect(last.statusCode).toBe(409);
    expect(last.json().error).toBe('last_profile');
  });
});

describe('catalog', () => {
  test('sync imported the mock catalog with tags and stripped names', async () => {
    const src = await json<{ counts: Record<string, number>; account: { maxConnections: number }; configured: boolean }>({ url: '/api/source' });
    expect(src.counts).toEqual({ live: mock.catalog.live.length, movie: mock.catalog.movies.length, series: mock.catalog.series.length });
    expect(src.account.maxConnections).toBe(2);
    const live = await json<Page<{ name: string; rawName: string; country: string | null; now: unknown; logo: string | null }>>({ url: '/api/live?limit=500' });
    // adult channels are hidden by default (parental lock)
    expect(live.total).toBe(mock.catalog.live.filter((c) => !c.tags.adult).length);
    const ard = live.items.find((c) => c.rawName.startsWith('DE | ARD'))!;
    expect(ard).toMatchObject({ name: expect.stringMatching(/^ARD/), country: 'de' });
    expect(live.items.filter((c) => c.now).length).toBeGreaterThan(live.items.length / 2);
    expect(ard.logo).toMatch(/^\/api\/art\/live\//);
  });

  test('artwork is proxied', async () => {
    const live = await json<Page<{ logo: string | null }>>({ url: '/api/live?limit=50' });
    const res = await call({ url: live.items.find((c) => c.logo)!.logo! });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\//);
  });

  test('hide rules filter lists, categories, search and EPG for the current profile only', async () => {
    const all = await json<Page<{ id: string; country: string | null; epgChannelId: string | null }>>({ url: '/api/live?limit=500' });
    const de = all.items.filter((c) => c.country === 'de');
    expect(de.length).toBeGreaterThan(0);
    const rules: HideRules = { countries: ['de'], languages: ['ar'], categoryIds: ['l9'] };
    expect(await json<HideRules>({ method: 'PUT', url: '/api/hide-rules', payload: rules })).toEqual(rules);

    const live = await json<Page<{ country: string | null; language: string | null; categoryId: string }>>({ url: '/api/live?limit=500' });
    expect(live.total).toBeLessThan(all.total);
    expect(live.items.some((c) => c.country === 'de' || c.language === 'ar' || c.categoryId === 'l9')).toBe(false);
    const movies = await json<Page<{ country: string | null }>>({ url: '/api/movies?limit=500' });
    expect(movies.items.some((m) => m.country === 'de')).toBe(false);
    const series = await json<Page<{ country: string | null }>>({ url: '/api/series?limit=500' });
    expect(series.items.some((m) => m.country === 'de')).toBe(false);
    const cats = await json<{ id: string; country: string | null }[]>({ url: '/api/categories?kind=live' });
    expect(cats.some((c) => c.country === 'de' || c.id === 'l9')).toBe(false);
    expect((await json<unknown[]>({ url: '/api/categories?kind=live&all=1' })).length).toBeGreaterThan(cats.length);
    const found = await json<{ live: { country: string | null }[] }>({ url: '/api/search?q=ard' });
    expect(found.live).toEqual([]);
    const withEpg = de.find((c) => c.epgChannelId)!;
    const now = Date.now();
    const epg = await json<Record<string, unknown[]>>({ url: `/api/epg?channelIds=${withEpg.id}&from=${now - 3600_000}&to=${now + 3600_000}` });
    expect(epg).toEqual({});

    await call({ method: 'PUT', url: '/api/hide-rules', payload: { countries: [], languages: [], categoryIds: [] } });
    const restored = await json<Record<string, unknown[]>>({ url: `/api/epg?channelIds=${withEpg.id}&from=${now - 3600_000}&to=${now + 3600_000}` });
    expect(restored[withEpg.id]!.length).toBeGreaterThan(0);
  });

  test('search is prefix and diacritic insensitive', async () => {
    const target = mock.catalog.movies.map((m) => m.title).find((t) => /[À-ž]/.test(t))!;
    const word = target.split(' ').find((w) => /[À-ž]/.test(w))!;
    const plain = word.normalize('NFD').replace(/\p{M}/gu, '').slice(0, 4).toLowerCase();
    const r = await json<{ movies: { name: string }[] }>({ url: `/api/search?q=${encodeURIComponent(plain)}` });
    expect(r.movies.some((m) => m.name.includes(word))).toBe(true);
    expect((await json<{ live: unknown[] }>({ url: '/api/search?q=%20%20' })).live).toEqual([]);
  });

  test('series detail fetches episodes lazily', async () => {
    const list = await json<Page<{ id: string }>>({ url: '/api/series?limit=1' });
    const detail = await json<{ seasons: { season: number; episodes: { id: string; seriesId: string }[] }[] }>({ url: `/api/series/${list.items[0]!.id}` });
    const expected = mock.catalog.seriesById.get(Number(list.items[0]!.id))!;
    expect(detail.seasons.length).toBe(expected.seasons.length);
    expect(detail.seasons[0]!.episodes.length).toBe(expected.seasons[0]!.length);
  });

  test('items by id: hydrated, in request order, hidden and unknown ids left out', async () => {
    const live = (await json<Page<{ id: string; country: string | null }>>({ url: '/api/live?limit=500' })).items;
    const movies = (await json<Page<{ id: string }>>({ url: '/api/movies?limit=3' })).items;
    const series = (await json<Page<{ id: string }>>({ url: '/api/series?limit=2' })).items;
    const de = live.find((c) => c.country === 'de')!;
    const other = live.find((c) => c.country !== 'de')!;
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
    const q = `live=${other.id},nope,${de.id}&movie=${ids(movies).reverse().join(',')}&series=${series[1]!.id}`;
    const r = await json<ItemsById>({ url: `/api/items?${q}` });
    expect(ids(r.live)).toEqual([other.id, de.id]);
    expect(r.live[0]).toHaveProperty('now');
    expect(ids(r.movies)).toEqual(ids(movies).reverse());
    expect(ids(r.series)).toEqual([series[1]!.id]);
    expect(await json<ItemsById>({ url: '/api/items' })).toEqual({ live: [], movies: [], series: [] });

    await call({ method: 'PUT', url: '/api/hide-rules', payload: { countries: ['de'], languages: [], categoryIds: [] } });
    expect(ids((await json<ItemsById>({ url: `/api/items?${q}` })).live)).toEqual([other.id]);
    await call({ method: 'PUT', url: '/api/hide-rules', payload: { countries: [], languages: [], categoryIds: [] } });
  });

  test('tags summary', async () => {
    const t = await json<{ countries: { country: string; count: number }[]; languages: { language: string }[] }>({ url: '/api/tags' });
    expect(t.countries[0]!.country).toBe('de');
    expect(t.languages.map((l) => l.language)).toContain('ar');
  });
});

describe('user data', () => {
  test('progress and continue watching', async () => {
    const series = (await json<Page<{ id: string }>>({ url: '/api/series?limit=1' })).items[0]!;
    const detail = await json<{ seasons: { episodes: { id: string; duration: number | null }[] }[] }>({ url: `/api/series/${series.id}` });
    const [e1, e2] = detail.seasons[0]!.episodes;
    const saved = await json<{ finished: boolean; seriesId: string }>({ method: 'PUT', url: '/api/progress', payload: { kind: 'episode', id: e1!.id, position: 99, duration: 100 } });
    expect(saved).toMatchObject({ finished: true, seriesId: series.id });
    const movie = (await json<Page<{ id: string }>>({ url: '/api/movies?limit=1' })).items[0]!;
    await call({ method: 'PUT', url: '/api/progress', payload: { kind: 'movie', id: movie.id, position: 30, duration: 100 } });
    const cont = await json<{ movies: { id: string; progress: { position: number } }[]; episodes: { id: string; series: { id: string } }[] }>({ url: '/api/continue' });
    expect(cont.movies[0]).toMatchObject({ id: movie.id, progress: { position: 30 } });
    expect(cont.episodes[0]).toMatchObject({ id: e2!.id, series: { id: series.id } });
    const info = await json<{ resumeAt?: number; seriesId?: string }>({ url: `/api/play/movie/${movie.id}` });
    expect(info.resumeAt).toBe(30);
    expect(info.seriesId).toBeUndefined();
    const epInfo = await json<{ seriesId?: string }>({ url: `/api/play/episode/${e2!.id}` });
    expect(epInfo.seriesId).toBe(series.id);
  });

  test('preferences merge partial updates and drop unknown keys', async () => {
    const p1 = await json<Record<string, Record<string, unknown>>>({ method: 'PUT', url: '/api/preferences', payload: { appearance: { accent: 'rose' }, bogus: 1 } });
    expect(p1.appearance!.accent).toBe('rose');
    const p2 = await json<Record<string, Record<string, unknown>>>({ method: 'PUT', url: '/api/preferences', payload: { appearance: { theme: 'black' } } });
    expect(p2.appearance).toMatchObject({ accent: 'rose', theme: 'black' });
    expect(p2).not.toHaveProperty('bogus');
    expect(p2.setupDone).toBe(false);
    const p3 = await json<{ setupDone: boolean }>({ method: 'PUT', url: '/api/preferences', payload: { setupDone: true } });
    expect(p3.setupDone).toBe(true);
    expect((await json<{ setupDone: boolean }>({ url: '/api/preferences' })).setupDone).toBe(true);
  });

  test('a tab order saved before Favorites and Lists existed gets them after Live TV', async () => {
    const p = await json<{ start: { tabOrder: string[]; hiddenTabs: string[] } }>({
      method: 'PUT',
      url: '/api/preferences',
      payload: { start: { tabOrder: ['series', 'live', 'movies', 'search'], hiddenTabs: ['search', 'bogus'] } },
    });
    expect(p.start.tabOrder).toEqual(['home', 'series', 'live', 'favorites', 'lists', 'movies', 'search']);
    expect(p.start.hiddenTabs).toEqual(['search']);
  });

  test('SSE delivers profile events only to that profile, with catalog updates to all', async () => {
    const base = await built.app.listen({ port: 0, host: '127.0.0.1' });
    const other = await json<Profile>({ method: 'POST', url: '/api/profiles', payload: { name: 'Other' } });
    const me = (await json<Profile[]>({ url: '/api/profiles' }))[0]!;
    const open = async (profile: string) => {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/events?profile=${profile}`, { headers: { cookie }, signal: ac.signal });
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const reader = res.body!.getReader();
      const events: SyncEvent[] = [];
      let buf = '';
      void (async () => {
        for (;;) {
          const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
          if (r.done) return;
          buf += new TextDecoder().decode(r.value);
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split('\n').find((l) => l.startsWith('data: '));
            if (data) events.push(JSON.parse(data.slice(6)) as SyncEvent);
          }
        }
      })();
      return { events, close: () => ac.abort() };
    };
    const a = await open(me.id);
    const b = await open(other.id);
    await new Promise((r) => setTimeout(r, 100));
    await call({ method: 'PUT', url: '/api/favorites', profile: me.id, payload: { kind: 'movie', id: '100000', favorite: true } });
    built.services.bus.emit({ type: 'catalog-updated' });
    await new Promise((r) => setTimeout(r, 200));
    expect(a.events.map((e) => e.type)).toEqual(['favorites', 'catalog-updated']);
    expect(a.events[0]).toMatchObject({ profileId: me.id, favorites: [{ kind: 'movie', id: '100000' }] });
    expect(b.events.map((e) => e.type)).toEqual(['catalog-updated']);
    a.close();
    b.close();
  });
});

describe('security', () => {
  test('no API response contains provider credentials or host', async () => {
    const host = new URL(mock.url).host;
    const all = seen.join('\n');
    expect(all.length).toBeGreaterThan(10_000);
    for (const secret of [CREDS.username, CREDS.password, host, mock.url]) expect(all).not.toContain(secret);
  });
});
