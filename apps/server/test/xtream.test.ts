import { expect, test } from 'vitest';
import { formatProviderTime, XtreamClient } from '../src/xtream/client';
import {
  AuthResponse, parseList, parseLiveStream, parseSeries, parseSeriesInfo, parseVodStream, XLiveStream, XSeries, XVodStream,
} from '../src/xtream/schemas';

test('numbers as strings, empty strings and junk entries', () => {
  const list = parseList(XLiveStream, [
    { num: '3', name: 'DE | ARD', stream_id: '17', tv_archive: '1', tv_archive_duration: '7', epg_channel_id: '', category_id: 5 },
    { name: 'no id' },
    null,
  ]);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ num: 3, stream_id: '17', tv_archive: 1, tv_archive_duration: 7, epg_channel_id: null, category_id: '5' });
  const vod = parseList(XVodStream, { a: { stream_id: 9, name: 'X', rating: '', container_extension: 'mkv' } });
  expect(vod[0]).toMatchObject({ stream_id: '9', rating: null, container_extension: 'mkv' });
});

test('the fast list parsers agree with the schemas on odd values', () => {
  const odd: unknown[] = [
    undefined, null, '', 'null', 0, -1, 1.5, '7', ' 8 ', 'x', true, false, [], [3], {}, { a: 1 }, NaN, 'Infinity', '1e3', '0x10',
  ];
  const keys = ['num', 'name', 'stream_id', 'series_id', 'stream_icon', 'epg_channel_id', 'added', 'category_id', 'tv_archive',
    'tv_archive_duration', 'rating', 'container_extension', 'year', 'plot', 'duration_secs', 'cover', 'releaseDate', 'release_date',
    'last_modified'];
  const items: unknown[] = [null, 'x', 3, [], [{ stream_id: 1 }], {}, { stream_id: '' }, { series_id: null }];
  // every odd value in every field, next to a valid id, plus every odd value as the id
  for (const [i, v] of odd.entries()) {
    const item: Record<string, unknown> = { stream_id: 10 + i, series_id: 10 + i, extra: v };
    for (const [j, k] of keys.entries()) if (!k.endsWith('_id') || k.startsWith('category') || k.startsWith('epg')) item[k] = odd[(i + j) % odd.length];
    items.push(item, { name: 'x', stream_id: v, series_id: v });
  }
  const viaZod = (schema: typeof XLiveStream | typeof XVodStream | typeof XSeries, x: unknown) => {
    const r = schema.safeParse(x);
    return r.success ? r.data : null;
  };
  for (const x of items) {
    expect(parseLiveStream(x)).toStrictEqual(viaZod(XLiveStream, x));
    expect(parseVodStream(x)).toStrictEqual(viaZod(XVodStream, x));
    expect(parseSeries(x)).toStrictEqual(viaZod(XSeries, x));
  }
  expect(items.filter((x) => parseVodStream(x) !== null).length).toBeGreaterThan(20);
  expect(items.filter((x) => parseSeries(x) === null).length).toBeGreaterThan(8);
});

test('auth response with odd shapes', () => {
  const r = AuthResponse.parse({ user_info: { auth: '1', status: 'Active', exp_date: null, max_connections: '2', allowed_output_formats: ['ts'] }, server_info: [] });
  expect(r.user_info).toMatchObject({ auth: 1, exp_date: null, max_connections: 2 });
  expect(r.server_info.timezone).toBeNull();
});

test('series info: episodes keyed by season, as nested arrays, or with [] info', () => {
  const keyed = parseSeriesInfo({ episodes: { '1': [{ id: '5', episode_num: '1', title: 'A', info: [] }], '2': { x: { id: 6, episode_num: 2, info: { duration_secs: '60' } } } } });
  expect(keyed.episodes.map((e) => [e.id, e.season, e.episode_num, e.info.duration_secs])).toEqual([['5', 1, 1, null], ['6', 2, 2, 60]]);
  const arrays = parseSeriesInfo({ episodes: [[{ id: '7', season: '3', episode_num: '4' }]] });
  expect(arrays.episodes[0]).toMatchObject({ id: '7', season: 3 });
  expect(parseSeriesInfo([]).episodes).toEqual([]);
});

test('timeshift URL uses the provider timezone and minute resolution', () => {
  const c = new XtreamClient({ url: 'http://p.example', username: 'u', password: 'p w' });
  const at = Date.UTC(2026, 6, 1, 18, 5, 40);
  expect(formatProviderTime(at, 'Europe/Berlin')).toBe('2026-07-01:20-05');
  expect(formatProviderTime(at, 'Not/AZone')).toBe('2026-07-01:18-05');
  expect(c.timeshiftUrl('42', at, 90, 'UTC')).toBe('http://p.example/timeshift/u/p%20w/90/2026-07-01:18-05/42.ts');
  expect(c.liveUrl('42', 'm3u8')).toBe('http://p.example/live/u/p%20w/42.m3u8');
});
