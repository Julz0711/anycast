import type { ChannelList, LiveChannelWithNow, Page, Profile, SyncEvent } from '@anycast/shared';
import { CHANNEL_LIST_LIMITS } from '@anycast/shared';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createMockXtream, login, makeApp } from './helpers';

const CREDS = { username: 'mock-user-lists', password: 'mock-pass-lists' };
let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let me: Profile;
let channels: LiveChannelWithNow[];

async function call(opts: InjectOptions & { profile?: string }) {
  const { profile, ...rest } = opts;
  return built.app.inject({ ...rest, headers: { cookie, 'x-anycast-profile': profile ?? me.id, ...(rest.headers ?? {}) } });
}
const json = async <T>(opts: InjectOptions & { profile?: string }) => {
  const res = await call(opts);
  if (res.statusCode >= 400) throw new Error(`${opts.method ?? 'GET'} ${opts.url}: ${res.statusCode} ${res.body}`);
  return res.json() as T;
};
const newProfile = (name: string) => built.app.inject({ method: 'POST', url: '/api/profiles', headers: { cookie }, payload: { name } }).then((r) => r.json() as Profile);

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', ...CREDS });
  built = await makeApp({ url: mock.url, username: CREDS.username, password: CREDS.password });
  await built.services.sync.syncAll();
  cookie = await login(built.app);
  me = await newProfile('Lists');
  channels = (await json<Page<LiveChannelWithNow>>({ url: '/api/live?limit=20' })).items;
});

afterAll(async () => {
  await built.app.close();
  await mock.close();
});

describe('channel lists', () => {
  test('create, rename, set channels in order, delete', async () => {
    const [a, b, c] = channels.map((x) => x.id);
    const news = await json<ChannelList>({ method: 'POST', url: '/api/lists', payload: { name: '  News  ' } });
    expect(news).toEqual({ id: expect.any(String), name: 'News', channelIds: [] });

    const set = await json<ChannelList>({ method: 'PUT', url: `/api/lists/${news.id}/channels`, payload: { channelIds: [c, a, b, a, ' '] } });
    expect(set.channelIds).toEqual([c, a, b]);
    const got = await json<LiveChannelWithNow[]>({ url: `/api/lists/${news.id}/channels` });
    expect(got.map((x) => x.id)).toEqual([c, a, b]);
    expect(got[0]).toHaveProperty('now');

    // reorder = the full array again
    expect((await json<ChannelList>({ method: 'PUT', url: `/api/lists/${news.id}/channels`, payload: { channelIds: [b, c] } })).channelIds).toEqual([b, c]);

    expect((await json<ChannelList>({ method: 'PATCH', url: `/api/lists/${news.id}`, payload: { name: 'Nachrichten' } })).name).toBe('Nachrichten');
    expect((await call({ method: 'PATCH', url: `/api/lists/${news.id}`, payload: { name: '   ' } })).statusCode).toBe(400);
    expect((await call({ method: 'POST', url: '/api/lists', payload: {} })).statusCode).toBe(400);

    expect(await json({ method: 'DELETE', url: `/api/lists/${news.id}` })).toEqual({ ok: true });
    expect(await json<ChannelList[]>({ url: '/api/lists' })).toEqual([]);
    expect((await call({ method: 'DELETE', url: `/api/lists/${news.id}` })).statusCode).toBe(404);
    expect((await call({ url: `/api/lists/${news.id}/channels` })).statusCode).toBe(404);
    // the items went with the list
    expect(built.services.db.prepare('SELECT count(*) AS n FROM channel_list_items WHERE list_id = ?').get(news.id)).toEqual({ n: 0 });
  });

  test('lists keep their order; PUT /api/lists/order reorders, unnamed lists keep their place after', async () => {
    const p = await newProfile('Order');
    const make = (name: string) => json<ChannelList>({ method: 'POST', url: '/api/lists', profile: p.id, payload: { name } });
    const x = await make('X');
    const y = await make('Y');
    const z = await make('Z');
    const names = async () => (await json<ChannelList[]>({ url: '/api/lists', profile: p.id })).map((l) => l.name);
    expect(await names()).toEqual(['X', 'Y', 'Z']);
    const res = await json<ChannelList[]>({ method: 'PUT', url: '/api/lists/order', profile: p.id, payload: { ids: [z.id, 'nope', x.id] } });
    expect(res.map((l) => l.name)).toEqual(['Z', 'X', 'Y']);
    expect(await names()).toEqual(['Z', 'X', 'Y']);
    // a new list goes last
    await make('W');
    expect(await names()).toEqual(['Z', 'X', 'Y', 'W']);
    void y;
  });

  test('lists are per profile', async () => {
    const other = await newProfile('Other');
    const mine = await json<ChannelList>({ method: 'POST', url: '/api/lists', payload: { name: 'Mine', channelIds: [channels[0]!.id] } });
    expect(await json<ChannelList[]>({ url: '/api/lists', profile: other.id })).toEqual([]);
    for (const req of [
      { method: 'PATCH' as const, url: `/api/lists/${mine.id}`, payload: { name: 'Stolen' } },
      { method: 'PUT' as const, url: `/api/lists/${mine.id}/channels`, payload: { channelIds: [] } },
      { method: 'DELETE' as const, url: `/api/lists/${mine.id}` },
      { method: 'GET' as const, url: `/api/lists/${mine.id}/channels` },
    ]) {
      expect((await call({ ...req, profile: other.id })).statusCode).toBe(404);
    }
    // reordering with someone else's id does nothing to it
    await call({ method: 'PUT', url: '/api/lists/order', profile: other.id, payload: { ids: [mine.id] } });
    expect((await json<ChannelList[]>({ url: '/api/lists' })).find((l) => l.id === mine.id)).toMatchObject({ name: 'Mine', channelIds: [channels[0]!.id] });
    // deleting the profile deletes its lists
    const gone = await newProfile('Gone');
    await json({ method: 'POST', url: '/api/lists', profile: gone.id, payload: { name: 'Temp', channelIds: [channels[0]!.id] } });
    await built.app.inject({ method: 'DELETE', url: `/api/profiles/${gone.id}`, headers: { cookie } });
    expect(built.services.db.prepare('SELECT count(*) AS n FROM channel_lists WHERE profile_id = ?').get(gone.id)).toEqual({ n: 0 });
  });

  test('a listed channel stays visible in its list (and its guide) when hide rules hide it', async () => {
    const p = await newProfile('Hidden');
    const ch = channels.find((c) => c.country && c.hasEpg)!;
    expect(ch).toBeDefined();
    const list = await json<ChannelList>({ method: 'POST', url: '/api/lists', profile: p.id, payload: { name: 'Mixed', channelIds: [ch.id, 'gone-from-catalog'] } });
    await json({ method: 'PUT', url: '/api/hide-rules', profile: p.id, payload: { countries: [ch.country], languages: [], categoryIds: [] } });
    const live = await json<Page<LiveChannelWithNow>>({ url: '/api/live?limit=500', profile: p.id });
    expect(live.items.some((c) => c.id === ch.id)).toBe(false);
    // unknown ids stay stored but are left out of the channels
    expect((await json<LiveChannelWithNow[]>({ url: `/api/lists/${list.id}/channels`, profile: p.id })).map((c) => c.id)).toEqual([ch.id]);
    expect((await json<ChannelList[]>({ url: '/api/lists', profile: p.id }))[0]!.channelIds).toEqual([ch.id, 'gone-from-catalog']);
    const now = Date.now();
    const epg = await json<Record<string, unknown[]>>({ url: `/api/epg?channelIds=${ch.id}&from=${now - 3600_000}&to=${now + 3600_000}`, profile: p.id });
    expect(epg[ch.id]?.length).toBeGreaterThan(0);
    // ...but only for this profile: someone else hiding the same country doesn't see its guide
    const q = await newProfile('NoList');
    await json({ method: 'PUT', url: '/api/hide-rules', profile: q.id, payload: { countries: [ch.country], languages: [], categoryIds: [] } });
    const epg2 = await json<Record<string, unknown[]>>({ url: `/api/epg?channelIds=${ch.id}&from=${now - 3600_000}&to=${now + 3600_000}`, profile: q.id });
    expect(epg2[ch.id]).toBeUndefined();
  });

  test('limits', async () => {
    const p = await newProfile('Limits');
    const many = Array.from({ length: CHANNEL_LIST_LIMITS.channels + 1 }, (_, i) => `c${i}`);
    expect((await call({ method: 'POST', url: '/api/lists', profile: p.id, payload: { name: 'Big', channelIds: many } })).statusCode).toBe(409);
    const long = await json<ChannelList>({ method: 'POST', url: '/api/lists', profile: p.id, payload: { name: 'x'.repeat(150) } });
    expect(long.name).toHaveLength(CHANNEL_LIST_LIMITS.name);
  });

  test('every change sends a lists event to the profile only', async () => {
    const p = await newProfile('Events');
    const q = await newProfile('Bystander');
    const base = await built.app.listen({ port: 0, host: '127.0.0.1' });
    const open = async (profile: string) => {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/events?profile=${profile}`, { headers: { cookie }, signal: ac.signal });
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
            const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
            buf = buf.slice(i + 2);
            if (data) events.push(JSON.parse(data.slice(6)) as SyncEvent);
          }
        }
      })();
      return { events, close: () => ac.abort() };
    };
    const a = await open(p.id);
    const b = await open(q.id);
    await new Promise((r) => setTimeout(r, 100));
    const l = await json<ChannelList>({ method: 'POST', url: '/api/lists', profile: p.id, payload: { name: 'Sport' } });
    await json({ method: 'PUT', url: `/api/lists/${l.id}/channels`, profile: p.id, payload: { channelIds: [channels[1]!.id, channels[0]!.id] } });
    await json({ method: 'PATCH', url: `/api/lists/${l.id}`, profile: p.id, payload: { name: 'Sports' } });
    await json({ method: 'DELETE', url: `/api/lists/${l.id}`, profile: p.id });
    await new Promise((r) => setTimeout(r, 200));
    expect(a.events.map((e) => e.type)).toEqual(['lists', 'lists', 'lists', 'lists']);
    expect(a.events[1]).toEqual({ type: 'lists', profileId: p.id, lists: [{ id: l.id, name: 'Sport', channelIds: [channels[1]!.id, channels[0]!.id] }] });
    expect(a.events[2]).toMatchObject({ lists: [{ name: 'Sports' }] });
    expect(a.events[3]).toMatchObject({ lists: [] });
    expect(b.events).toEqual([]);
    a.close();
    b.close();
  });
});
