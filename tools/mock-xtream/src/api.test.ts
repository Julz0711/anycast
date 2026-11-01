import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMockXtream, type MockXtream } from './server.js';

let mock: MockXtream;
const api = async (params: Record<string, string | number> = {}, creds = { username: 'test', password: 'test' }) => {
  const qs = new URLSearchParams({ ...creds, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const res = await fetch(`${mock.url}/player_api.php?${qs}`);
  return res.json() as Promise<any>;
};

beforeAll(async () => {
  mock = await createMockXtream({ size: 'small' });
});
afterAll(async () => {
  await mock.close();
});
afterEach(async () => {
  await mock.reset();
});

describe('auth', () => {
  it('rejects wrong credentials like real panels', async () => {
    expect(await api({}, { username: 'test', password: 'wrong' })).toEqual({ user_info: { auth: 0 } });
    expect(await api({ action: 'get_live_streams' }, { username: 'x', password: 'test' })).toEqual({ user_info: { auth: 0 } });
  });

  it('returns user_info and server_info with string-typed numbers', async () => {
    const r = await api();
    expect(r.user_info).toMatchObject({
      username: 'test',
      password: 'test',
      auth: 1,
      status: 'Active',
      is_trial: '0',
      active_cons: '0',
      max_connections: '2',
      allowed_output_formats: ['m3u8', 'ts'],
    });
    expect(typeof r.user_info.exp_date).toBe('string');
    expect(Number(r.user_info.exp_date)).toBeGreaterThan(Date.now() / 1000);
    expect(typeof r.user_info.created_at).toBe('string');
    expect(r.server_info).toMatchObject({ url: '127.0.0.1', port: String(mock.port), server_protocol: 'http', timezone: 'Europe/Berlin' });
    expect(typeof r.server_info.timestamp_now).toBe('number');
    expect(r.server_info.time_now).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('actions', () => {
  it('lists categories', async () => {
    for (const action of ['get_live_categories', 'get_vod_categories', 'get_series_categories']) {
      const cats = await api({ action });
      expect(cats.length).toBeGreaterThan(3);
      for (const c of cats) {
        expect(Object.keys(c).sort()).toEqual(['category_id', 'category_name', 'parent_id']);
        expect(typeof c.category_id).toBe('string');
        expect(c.parent_id).toBe(0);
      }
    }
  });

  it('get_live_streams has the Xtream shape and filters by category', async () => {
    const all = await api({ action: 'get_live_streams' });
    expect(all).toHaveLength(60);
    const s = all[0];
    for (const k of ['num', 'name', 'stream_type', 'stream_id', 'stream_icon', 'epg_channel_id', 'added', 'category_id', 'custom_sid', 'tv_archive', 'direct_source', 'tv_archive_duration']) {
      expect(s, k).toHaveProperty(k);
    }
    expect(s.stream_type).toBe('live');
    expect(typeof s.stream_id).toBe('number');
    expect(typeof s.added).toBe('string');
    expect(all.some((c: any) => c.tv_archive === 1)).toBe(true);
    expect(all.some((c: any) => c.tv_archive === 0)).toBe(true);
    const filtered = await api({ action: 'get_live_streams', category_id: s.category_id });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((c: any) => c.category_id === s.category_id)).toBe(true);
    const icon = await fetch(s.stream_icon);
    expect(icon.headers.get('content-type')).toBe('image/png');
  });

  it('get_vod_streams and get_vod_info', async () => {
    const list = await api({ action: 'get_vod_streams' });
    expect(list).toHaveLength(100);
    const m = list[0];
    for (const k of ['num', 'name', 'stream_type', 'stream_id', 'stream_icon', 'rating', 'rating_5based', 'added', 'category_id', 'container_extension', 'custom_sid', 'direct_source']) {
      expect(m, k).toHaveProperty(k);
    }
    expect(m.stream_type).toBe('movie');
    const info = await api({ action: 'get_vod_info', vod_id: m.stream_id });
    expect(info.info).toMatchObject({ duration_secs: expect.any(Number), plot: expect.any(String) });
    expect(info.info).toHaveProperty('tmdb_id');
    expect(info.info).toHaveProperty('releasedate');
    expect(info.info).toHaveProperty('rating');
    expect(info.movie_data).toMatchObject({ stream_id: m.stream_id, container_extension: m.container_extension });
  });

  it('get_series and get_series_info', async () => {
    const list = await api({ action: 'get_series' });
    expect(list).toHaveLength(20);
    const s = list[0];
    for (const k of ['num', 'name', 'series_id', 'cover', 'plot', 'cast', 'director', 'genre', 'releaseDate', 'last_modified', 'rating', 'rating_5based', 'backdrop_path', 'youtube_trailer', 'episode_run_time', 'category_id']) {
      expect(s, k).toHaveProperty(k);
    }
    const info = await api({ action: 'get_series_info', series_id: s.series_id });
    expect(Array.isArray(info.seasons)).toBe(true);
    expect(info.info.name).toBe(s.name);
    const ep = info.episodes['1'][0];
    expect(ep).toMatchObject({ episode_num: 1, season: 1, id: expect.any(String), container_extension: expect.any(String) });
    expect(ep.info).toMatchObject({ duration_secs: expect.any(Number), duration: expect.stringMatching(/^\d\d:\d\d:\d\d$/) });
  });

  it('unknown action returns []', async () => {
    expect(await api({ action: 'get_something' })).toEqual([]);
  });
});

describe('EPG', () => {
  const archived = () => mock.catalog.live.find((c) => c.archive && c.epgChannelId)!;

  it('get_short_epg returns base64 listings from now', async () => {
    const c = archived();
    const r = await api({ action: 'get_short_epg', stream_id: c.id, limit: 3 });
    expect(r.epg_listings).toHaveLength(3);
    const l = r.epg_listings[0];
    for (const k of ['id', 'epg_id', 'title', 'lang', 'start', 'end', 'description', 'channel_id', 'start_timestamp', 'stop_timestamp']) {
      expect(l, k).toHaveProperty(k);
    }
    expect(Buffer.from(l.title, 'base64').toString()).toMatch(/#\d+$/);
    expect(l.start).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const now = Date.now() / 1000;
    expect(Number(l.start_timestamp)).toBeLessThanOrEqual(now);
    expect(Number(l.stop_timestamp)).toBeGreaterThan(now);
    const len = Number(l.stop_timestamp) - Number(l.start_timestamp);
    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThanOrEqual(90 * 60);
  });

  it('get_simple_data_table marks archive and now playing', async () => {
    const c = archived();
    const r = await api({ action: 'get_simple_data_table', stream_id: c.id });
    expect(r.epg_listings.filter((l: any) => l.now_playing === 1)).toHaveLength(1);
    expect(r.epg_listings.some((l: any) => l.has_archive === 1)).toBe(true);
  });

  it('channels without epg_channel_id get no listings', async () => {
    const c = mock.catalog.live.find((x) => !x.epgChannelId);
    if (!c) return;
    expect((await api({ action: 'get_short_epg', stream_id: c.id })).epg_listings).toEqual([]);
  });

  it('xmltv.php streams a 7-days-back to 2-days-ahead guide', async () => {
    const res = await fetch(`${mock.url}/xmltv.php?username=test&password=test`);
    expect(res.headers.get('content-type')).toContain('xml');
    const xml = await res.text();
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml.trimEnd().endsWith('</tv>')).toBe(true);
    expect(xml).toContain('<channel id="ard.de">');
    const starts = [...xml.matchAll(/start="(\d{14}) [+-]\d{4}"/g)].map((m) => m[1]!);
    const days = new Set(starts.map((s) => s.slice(0, 8)));
    expect(days.size).toBeGreaterThanOrEqual(9);
    expect((await fetch(`${mock.url}/xmltv.php?username=test&password=bad`)).status).toBe(403);
  });

  it('get.php returns an M3U playlist', async () => {
    const text = await (await fetch(`${mock.url}/get.php?username=test&password=test&type=m3u_plus&output=ts`)).text();
    expect(text.startsWith('#EXTM3U')).toBe(true);
    expect(text).toContain(`${mock.url}/live/test/test/1.ts`);
  });
});

describe('faults (API side)', () => {
  it('brokenEpg returns malformed JSON and truncated XMLTV', async () => {
    const r = await fetch(`${mock.url}/__mock/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brokenEpg: true }),
    });
    expect((await r.json()).brokenEpg).toBe(true);
    const c = mock.catalog.live.find((x) => x.epgChannelId)!;
    const text = await (await fetch(`${mock.url}/player_api.php?username=test&password=test&action=get_short_epg&stream_id=${c.id}`)).text();
    expect(() => JSON.parse(text)).toThrow();
    expect(await api({ action: 'get_simple_data_table', stream_id: c.id })).toEqual([]);
    const xml = await (await fetch(`${mock.url}/xmltv.php?username=test&password=test`)).text();
    expect(xml).not.toContain('</tv>');
  });

  it('expired flips status and exp_date', async () => {
    mock.setFaults({ expired: true });
    const r = await api();
    expect(r.user_info.status).toBe('Expired');
    expect(Number(r.user_info.exp_date)).toBeLessThan(Date.now() / 1000);
  });

  it('slowApiMs delays responses', async () => {
    mock.setFaults({ slowApiMs: 300 });
    const t = Date.now();
    await api();
    expect(Date.now() - t).toBeGreaterThanOrEqual(280);
  });

  it('rejects unknown faults', async () => {
    const r = await fetch(`${mock.url}/__mock/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: 1 }),
    });
    expect(r.status).toBe(400);
  });

  it('reset restores defaults', async () => {
    mock.setFaults({ expired: true });
    await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
    expect((await api()).user_info.status).toBe('Active');
  });
});

describe('injected clock', () => {
  it('drives timestamps and EPG', async () => {
    const fixed = Date.UTC(2026, 10, 1, 19, 15, 0);
    const m = await createMockXtream({ size: 'small', now: () => fixed });
    try {
      const r = await (await fetch(`${m.url}/player_api.php?username=test&password=test`)).json() as any;
      expect(r.server_info.timestamp_now).toBe(fixed / 1000);
      expect(r.server_info.time_now).toBe('2026-11-01 20:15:00');
    } finally {
      await m.close();
    }
  });
});
