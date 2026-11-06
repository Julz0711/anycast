import type { AdultStatus, Category, ItemsById, LiveChannelWithNow, Movie, Page, PinError, Profile, SearchResults } from '@anycast/shared';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EventBus } from '../src/events';
import { Parental } from '../src/parental';
import { ADMIN, createMockXtream, login, makeApp } from './helpers';

const CREDS = { username: 'mock-user-parental', password: 'mock-pass-parental' };
const PIN = '4826';
let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let session: string;
/** extra cookies (the unlock cookie) sent with every request of this session */
let jar: Record<string, string> = {};
const seen: string[] = [];

async function call(opts: InjectOptions & { profile?: string; cookie?: string }) {
  const { profile, cookie, ...rest } = opts;
  const c = cookie ?? [session, ...Object.entries(jar).map(([k, v]) => `${k}=${v}`)].join('; ');
  const res = await built.app.inject({ ...rest, headers: { cookie: c, ...(profile ? { 'x-anycast-profile': profile } : {}), ...(rest.headers ?? {}) } });
  seen.push(res.body, JSON.stringify(res.headers));
  for (const k of res.cookies) {
    if (!k.name.startsWith('anycast_unlock_')) continue;
    if (k.value && !(k.expires && k.expires.getTime() < Date.now())) jar[k.name] = k.value;
    else delete jar[k.name];
  }
  return res;
}
const json = async <T>(opts: InjectOptions & { profile?: string; cookie?: string }) => (await call(opts)).json() as T;

let adultLiveCat: string;
let adultMovieCat: string;
let adultChannel: string;
let adultMovie: string;
let normalChannel: string;
let me: Profile;

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', ...CREDS });
  built = await makeApp({ url: mock.url, username: CREDS.username, password: CREDS.password });
  await built.services.sync.syncAll();
  session = await login(built.app);
  const db = built.services.db;
  adultLiveCat = (db.prepare("SELECT id FROM categories WHERE adult = 1 AND kind = 'live'").get() as { id: string }).id;
  adultMovieCat = (db.prepare("SELECT id FROM categories WHERE adult = 1 AND kind = 'movie'").get() as { id: string }).id;
  adultChannel = (db.prepare('SELECT id FROM channels WHERE category_id = ?').get(adultLiveCat) as { id: string }).id;
  adultMovie = (db.prepare('SELECT id FROM movies WHERE category_id = ?').get(adultMovieCat) as { id: string }).id;
  normalChannel = (db.prepare('SELECT c.id FROM channels c JOIN categories k ON k.id = c.category_id WHERE k.adult = 0').get() as { id: string }).id;
  me = (await json<Profile[]>({ url: '/api/profiles' }))[0]!;
  // a little progress on the adult movie for continue watching
  await call({ method: 'PUT', url: '/api/progress', payload: { kind: 'movie', id: adultMovie, position: 30, duration: 1000 } });
});

afterAll(async () => {
  await built.app.close();
  await mock.close();
});

const status = () => json<AdultStatus>({ url: '/api/adult' });

describe('hidden (the default)', () => {
  test('adult categories and items vanish from every list, search, guide and items-by-id', async () => {
    expect(await status()).toMatchObject({ mode: 'hidden', hasPin: false, unlocked: false, attemptsLeft: 5 });
    for (const kind of ['live', 'movie']) {
      for (const all of ['', '&all=1']) {
        const cats = await json<Category[]>({ url: `/api/categories?kind=${kind}${all}` });
        expect(cats.length).toBeGreaterThan(0);
        expect(cats.some((c) => c.adult)).toBe(false);
      }
    }
    const live = await json<Page<LiveChannelWithNow>>({ url: '/api/live?limit=500' });
    expect(live.items.some((c) => c.categoryId === adultLiveCat)).toBe(false);
    expect((await json<Page<LiveChannelWithNow>>({ url: `/api/live?categoryId=${adultLiveCat}` })).total).toBe(0);
    expect((await json<Page<Movie>>({ url: `/api/movies?categoryId=${adultMovieCat}` })).total).toBe(0);
    const movies = await json<Page<Movie>>({ url: '/api/movies?limit=500' });
    expect(movies.items.some((m) => m.categoryId === adultMovieCat)).toBe(false);

    for (const q of ['adult', 'red room', 'xxx']) {
      const r = await json<SearchResults>({ url: `/api/search?q=${encodeURIComponent(q)}` });
      expect([...r.live, ...r.movies, ...r.series].some((x) => x.categoryId === adultLiveCat || x.categoryId === adultMovieCat)).toBe(false);
    }
    const items = await json<ItemsById>({ url: `/api/items?live=${adultChannel},${normalChannel}&movie=${adultMovie}` });
    expect(items.live.map((c) => c.id)).toEqual([normalChannel]);
    expect(items.movies).toEqual([]);
    const now = Date.now();
    const epg = await json<Record<string, unknown>>({ url: `/api/epg?channelIds=${adultChannel},${normalChannel}&from=${now - 3600_000}&to=${now + 3600_000}` });
    expect(Object.keys(epg)).toEqual([normalChannel]);
    const cont = await json<{ movies: Movie[] }>({ url: '/api/continue' });
    expect(cont.movies.some((m) => m.id === adultMovie)).toBe(false);
    // the user's own hide rules are untouched
    expect((await json<{ categoryIds: string[] }>({ url: '/api/hide-rules' })).categoryIds).toEqual([]);
  });

  test('play, timeline and artwork answer 403 adult_locked', async () => {
    for (const url of [`/api/play/live/${adultChannel}`, `/api/play/live/${adultChannel}/at?at=${Date.now() - 60_000}`, `/api/timeline/${adultChannel}`, `/api/play/movie/${adultMovie}`, `/api/art/movie/${adultMovie}`]) {
      const res = await call({ url });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ error: 'adult_locked', mode: 'hidden' });
    }
  });

  test('stream URLs built from ids are gated too', async () => {
    for (const url of [`/api/stream/live/${adultChannel}.ts`, `/api/stream/live/${adultChannel}/remux/index.m3u8`, `/api/stream/movie/${adultMovie}/video.mp4`, `/api/thumbs/movie/${adultMovie}`]) {
      const res = await call({ url });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ error: 'adult_locked' });
    }
  });

  test('an adult channel put in a list stays out of it while hidden', async () => {
    const list = (await call({ method: 'POST', url: '/api/lists', payload: { name: 'Mixed' } })).json() as { id: string };
    await call({ method: 'PUT', url: `/api/lists/${list.id}/channels`, payload: { channelIds: [adultChannel, normalChannel] } });
    const rows = (await call({ url: `/api/lists/${list.id}/channels` })).json() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([normalChannel]);
    await call({ method: 'DELETE', url: `/api/lists/${list.id}` });
  });
});

describe('PIN and mode', () => {
  test('the first PIN needs the account password; leaving hidden needs the PIN', async () => {
    const noPw = await call({ method: 'PUT', url: '/api/adult/pin', payload: { pin: PIN } });
    expect(noPw.statusCode).toBe(409);
    expect(noPw.json<PinError>().error).toBe('pin_required');
    expect((await call({ method: 'PUT', url: '/api/adult/pin', payload: { pin: '12a4', password: ADMIN.password } })).statusCode).toBe(400);
    expect((await call({ method: 'PUT', url: '/api/adult/pin', payload: { pin: '1234567', password: ADMIN.password } })).statusCode).toBe(400);
    const wrongPw = await call({ method: 'PUT', url: '/api/adult/pin', payload: { pin: PIN, password: 'nope' } });
    expect(wrongPw.statusCode).toBe(403);
    expect(wrongPw.json<PinError>()).toMatchObject({ error: 'wrong_password', attemptsLeft: 4 });

    const noPinYet = await call({ method: 'PUT', url: '/api/adult/settings', payload: { mode: 'locked' } });
    expect(noPinYet.json<PinError>().error).toBe('no_pin');

    const set = await json<AdultStatus>({ method: 'PUT', url: '/api/adult/pin', payload: { pin: PIN, password: ADMIN.password } });
    expect(set).toMatchObject({ hasPin: true, mode: 'hidden', attemptsLeft: 5 });

    expect((await call({ method: 'PUT', url: '/api/adult/settings', payload: { mode: 'locked' } })).json<PinError>().error).toBe('pin_required');
    const wrong = await call({ method: 'PUT', url: '/api/adult/settings', payload: { mode: 'locked', pin: '0000' } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json<PinError>()).toMatchObject({ error: 'wrong_pin', attemptsLeft: 4 });
    const locked = await json<AdultStatus>({ method: 'PUT', url: '/api/adult/settings', payload: { mode: 'locked', pin: PIN } });
    expect(locked).toMatchObject({ mode: 'locked', unlocked: false, attemptsLeft: 5 });
    // a longer unlock needs the PIN too
    expect((await call({ method: 'PUT', url: '/api/adult/settings', payload: { unlockMinutes: 120 } })).statusCode).toBe(409);
    expect((await call({ method: 'PUT', url: '/api/adult/settings', payload: { unlockMinutes: 7, pin: PIN } })).statusCode).toBe(400);
    expect((await json<AdultStatus>({ method: 'PUT', url: '/api/adult/settings', payload: { unlockMinutes: 15, pin: PIN } })).unlockMinutes).toBe(15);
  });

  test('changing the PIN needs the current PIN (or the password)', async () => {
    // a PIN sent with no change just verifies it
    expect((await call({ method: 'PUT', url: '/api/adult/settings', payload: { pin: '9999' } })).statusCode).toBe(403);
    expect((await call({ method: 'PUT', url: '/api/adult/settings', payload: { pin: PIN } })).statusCode).toBe(200);
    expect((await call({ method: 'PUT', url: '/api/adult/pin', payload: { pin: '111111' } })).statusCode).toBe(409);
    expect((await call({ method: 'PUT', url: '/api/adult/pin', payload: { pin: '111111', currentPin: '9999' } })).statusCode).toBe(403);
    await json({ method: 'PUT', url: '/api/adult/pin', payload: { pin: '111111', currentPin: PIN } });
    await json({ method: 'PUT', url: '/api/adult/pin', payload: { pin: PIN, password: ADMIN.password } });
    expect((await status()).attemptsLeft).toBe(5);
  });
});

describe('locked', () => {
  test('adult categories are listed as locked and their items are placeholders', async () => {
    const cats = await json<Category[]>({ url: '/api/categories?kind=live' });
    expect(cats.find((c) => c.id === adultLiveCat)).toMatchObject({ adult: true, locked: true });
    expect(cats.filter((c) => !c.adult).every((c) => !c.locked)).toBe(true);

    const page = await json<Page<LiveChannelWithNow>>({ url: `/api/live?categoryId=${adultLiveCat}` });
    expect(page.total).toBeGreaterThan(0);
    for (const c of page.items) {
      expect(c).toMatchObject({ name: 'Locked', rawName: 'Locked', logo: null, epgChannelId: null, locked: true });
      if (c.now) expect(c.now).toMatchObject({ title: 'Locked', description: null });
    }
    const movies = await json<Page<Movie>>({ url: `/api/movies?categoryId=${adultMovieCat}` });
    expect(movies.items.every((m) => m.name === 'Locked' && m.poster === null && m.plot === null && m.locked)).toBe(true);

    const items = await json<ItemsById>({ url: `/api/items?live=${adultChannel}&movie=${adultMovie}` });
    expect(items.live[0]).toMatchObject({ id: adultChannel, name: 'Locked', locked: true });
    expect(items.movies[0]).toMatchObject({ id: adultMovie, name: 'Locked', locked: true });
    const cont = await json<{ movies: Movie[] }>({ url: '/api/continue' });
    expect(cont.movies.find((m) => m.id === adultMovie)).toMatchObject({ name: 'Locked', poster: null, locked: true });

    const now = Date.now();
    const epg = await json<Record<string, { title: string }[]>>({ url: `/api/epg?channelIds=${adultChannel}&from=${now - 6 * 3600_000}&to=${now + 6 * 3600_000}` });
    expect((epg[adultChannel] ?? []).every((p) => p.title === 'Locked')).toBe(true);

    // search never matches locked names
    const r = await json<SearchResults>({ url: '/api/search?q=red%20room' });
    expect(r.live.some((x) => x.categoryId === adultLiveCat)).toBe(false);

    for (const url of [`/api/play/live/${adultChannel}`, `/api/timeline/${adultChannel}`, `/api/play/movie/${adultMovie}`, `/api/art/live/${adultChannel}`]) {
      const res = await call({ url });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ error: 'adult_locked', mode: 'locked' });
    }
  });

  test('unlock with the PIN opens them on this device, lock closes them again', async () => {
    const wrong = await call({ method: 'POST', url: '/api/adult/unlock', payload: { pin: '0000' } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json<PinError>()).toMatchObject({ error: 'wrong_pin', attemptsLeft: 4 });
    expect(Object.keys(jar)).toEqual([]);

    const res = await call({ method: 'POST', url: '/api/adult/unlock', payload: { pin: PIN } });
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === `anycast_unlock_${me.id}`)!;
    expect(c).toMatchObject({ httpOnly: true, path: '/api' });
    expect(c.maxAge).toBeUndefined();
    const st = res.json<AdultStatus>();
    expect(st).toMatchObject({ unlocked: true, attemptsLeft: 5 });
    expect(st.unlockedUntil! - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(st.unlockedUntil! - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect((await status()).unlocked).toBe(true);

    const cats = await json<Category[]>({ url: '/api/categories?kind=live' });
    expect(cats.find((x) => x.id === adultLiveCat)!.locked).toBeUndefined();
    const page = await json<Page<LiveChannelWithNow>>({ url: `/api/live?categoryId=${adultLiveCat}` });
    expect(page.items.every((x) => x.name !== 'Locked' && !x.locked)).toBe(true);
    // visible adult artwork names the profile, because <img> requests send no profile header
    const withLogo = page.items.find((x) => x.logo);
    if (withLogo) {
      expect(withLogo.logo).toContain(`?profile=${me.id}`);
      expect((await call({ url: withLogo.logo! })).statusCode).not.toBe(403);
    }
    expect((await call({ url: `/api/timeline/${adultChannel}` })).statusCode).toBe(200);
    const play = await call({ url: `/api/play/movie/${adultMovie}` });
    expect(play.statusCode).toBe(200);

    // another sign-in session (another device) with the same cookie stays locked
    const other = await login(built.app);
    const foreign = await call({ url: `/api/timeline/${adultChannel}`, cookie: `${other}; anycast_unlock_${me.id}=${jar[`anycast_unlock_${me.id}`]}` });
    expect(foreign.statusCode).toBe(403);

    const locked = await call({ method: 'POST', url: '/api/adult/lock' });
    expect(locked.json<AdultStatus>().unlocked).toBe(false);
    expect(Object.keys(jar)).toEqual([]);
    expect((await call({ url: `/api/timeline/${adultChannel}` })).statusCode).toBe(403);
  });

  test('an unlock cookie of one profile does not unlock another', async () => {
    const kid = await json<Profile>({ method: 'POST', url: '/api/profiles', payload: { name: 'Kid' } });
    expect((await json<AdultStatus>({ url: '/api/adult', profile: kid.id })).mode).toBe('hidden');
    await json({ method: 'POST', url: '/api/adult/unlock', payload: { pin: PIN } });
    const token = jar[`anycast_unlock_${me.id}`]!;
    // the kid profile: still hidden, even with the cookie copied under its own name
    const cookie = `${session}; anycast_unlock_${kid.id}=${token}; anycast_unlock_${me.id}=${token}`;
    expect((await call({ url: `/api/live?categoryId=${adultLiveCat}`, profile: kid.id, cookie })).json<Page<unknown>>().total).toBe(0);
    expect((await call({ url: `/api/timeline/${adultChannel}`, profile: kid.id, cookie })).json()).toMatchObject({ mode: 'hidden' });
    // its own PIN is separate
    expect((await call({ method: 'PUT', url: '/api/adult/settings', profile: kid.id, payload: { mode: 'shown', pin: PIN } })).json<PinError>().error).toBe('no_pin');
    await call({ method: 'POST', url: '/api/adult/lock' });
  });

  test('wrong PINs are rate limited per profile with a clear message', async () => {
    const teen = await json<Profile>({ method: 'POST', url: '/api/profiles', payload: { name: 'Teen' } });
    await json({ method: 'PUT', url: '/api/adult/pin', profile: teen.id, payload: { pin: '2468', password: ADMIN.password } });
    await json({ method: 'PUT', url: '/api/adult/settings', profile: teen.id, payload: { mode: 'locked', pin: '2468' } });
    const left: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await call({ method: 'POST', url: '/api/adult/unlock', profile: teen.id, payload: { pin: '1111' } });
      expect(r.statusCode).toBe(403);
      left.push(r.json<PinError>().attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1]);
    const fifth = await call({ method: 'POST', url: '/api/adult/unlock', profile: teen.id, payload: { pin: '1111' } });
    expect(fifth.statusCode).toBe(429);
    const body = fifth.json<PinError>();
    expect(body).toMatchObject({ error: 'pin_locked_out', attemptsLeft: 0 });
    expect(body.message).toMatch(/Too many wrong attempts\. Try again in 10 minutes\./);
    expect(body.lockedOutUntil! - Date.now()).toBeGreaterThan(9 * 60_000);
    // even the right PIN waits
    expect((await call({ method: 'POST', url: '/api/adult/unlock', profile: teen.id, payload: { pin: '2468' } })).statusCode).toBe(429);
    expect((await json<AdultStatus>({ url: '/api/adult', profile: teen.id })).lockedOutUntil).not.toBeNull();
    // other profiles are not affected
    expect((await status()).attemptsLeft).toBe(5);
  });

  test('admins can reset a profile’s PIN; other users cannot', async () => {
    const teen = (await json<Profile[]>({ url: '/api/profiles' })).find((p) => p.name === 'Teen')!;
    expect(await json({ method: 'POST', url: '/api/adult/reset', payload: { profileId: teen.id } })).toEqual({ ok: true });
    expect(await json<AdultStatus>({ url: '/api/adult', profile: teen.id })).toMatchObject({ mode: 'hidden', hasPin: false, attemptsLeft: 5 });

    await built.services.users.create('guest', 'guest-password-1', false);
    const guest = await login(built.app, { username: 'guest', password: 'guest-password-1' });
    const res = await call({ method: 'POST', url: '/api/adult/reset', payload: { profileId: me.id }, cookie: guest });
    expect(res.statusCode).toBe(403);
    expect((await status()).hasPin).toBe(true);
  });

  test('settings changes reach the profile as a parental event', async () => {
    const events: string[] = [];
    const off = built.services.bus.subscribe(me.id, (e) => events.push(e.type));
    await json({ method: 'PUT', url: '/api/adult/settings', payload: { mode: 'hidden' } });
    off();
    expect(events).toEqual(['parental']);
    expect((await status()).mode).toBe('hidden');
  });
});

describe('expiry and lockout windows', () => {
  test('an unlock ends after unlockMinutes, and a lockout after the window', async () => {
    let t = 1_000_000;
    const p = new Parental(built.services.db, new EventBus(), () => t);
    const kid = built.services.users.createProfile((await json<{ user: { id: string } }>({ url: '/api/me' })).user.id, 'Clock');
    const user = built.services.users.byId((await json<{ user: { id: string } }>({ url: '/api/me' })).user.id)!;
    const ctx = { profileId: kid.id, token: 'session-token', cookies: {} as Record<string, string> };
    await p.setPin(ctx, user, { pin: '1357', password: ADMIN.password });
    await p.updateSettings(ctx, { mode: 'locked', unlockMinutes: 5, pin: '1357' });
    const { token } = await p.unlock(ctx, '1357');
    const withCookie = { ...ctx, cookies: { [`anycast_unlock_${kid.id}`]: token } };
    expect(p.status(withCookie).unlocked).toBe(true);
    t += 5 * 60_000 - 1;
    expect(p.view(withCookie).unlocked).toBe(true);
    t += 1;
    expect(p.view(withCookie).unlocked).toBe(false);

    for (let i = 0; i < 5; i++) await p.unlock(ctx, '0000').catch(() => undefined);
    expect(p.status(ctx).attemptsLeft).toBe(0);
    await expect(p.unlock(ctx, '1357')).rejects.toMatchObject({ statusCode: 429 });
    t += 10 * 60_000;
    expect(p.status(ctx)).toMatchObject({ attemptsLeft: 5, lockedOutUntil: null });
    await expect(p.unlock(ctx, '1357')).resolves.toBeTruthy();
  });
});

describe('security', () => {
  test('neither the PIN nor its hash is in any response', async () => {
    const all = seen.join('\n');
    expect(all).not.toMatch(/\$argon2/);
    expect(all).not.toMatch(/pin_?hash/i);
    // the PIN routes and the status never echo the PIN
    const adultBodies = seen.filter((b) => b.includes('"hasPin"'));
    expect(adultBodies.length).toBeGreaterThan(5);
    for (const b of adultBodies) for (const pin of [PIN, '111111', '2468']) expect(b).not.toContain(pin);
    const row = built.services.db.prepare('SELECT pin_hash FROM parental WHERE profile_id = ?').get(me.id) as { pin_hash: string };
    expect(row.pin_hash).toMatch(/^\$argon2/);
  });
});
