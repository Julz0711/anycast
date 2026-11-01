/**
 * A provider in another timezone than the server: its XMLTV writes local times without an offset
 * and its timeshift URLs take local start times. Both must be read and written in the provider's
 * timezone (server_info.timezone), never the server's.
 */
import type { EpgProgram, PlaybackInfo, TimelineInfo } from '@anycast/shared';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createMockXtream, login, makeApp } from './helpers';
import { programmesBetween } from '@anycast/mock-xtream';

const MSE = JSON.stringify({ hls: false, mse: true, codecs: ['avc1', 'mp4a'] });

/** A zone whose offset differs from the server's right now (so a mix-up cannot pass by accident). */
function otherZone(): string {
  const offset = (tz: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return +p.hour! * 60 + +p.minute!;
  };
  const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return ['Pacific/Auckland', 'America/New_York', 'Asia/Kolkata'].find((tz) => offset(tz) !== offset(server))!;
}

const zone = otherZone();
let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;

const get = (url: string) => built.app.inject({ method: 'GET', url, headers: { cookie, 'x-anycast-caps': MSE } });

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', timezone: zone, xmltvOffsets: false, username: 'tz-user', password: 'tz-pass-3310' });
  built = await makeApp({ url: mock.url, username: mock.username, password: mock.password });
  await built.services.sync.syncCatalog();
  await built.services.sync.syncEpg();
  cookie = await login(built.app);
});

afterAll(async () => {
  await built.app.close();
  await mock.close();
});

test('the provider reports a timezone different from the server', () => {
  expect(built.services.source.timezone()).toBe(zone);
});

test('XMLTV times without an offset are read in the provider timezone', async () => {
  const ch = mock.catalog.live.find((c) => c.epgChannelId && c.epgListed && c.profile === 'live_h264_aac')!;
  const from = Date.now() - 6 * 3600_000;
  const to = Date.now() + 6 * 3600_000;
  const epg = (await get(`/api/epg?channelIds=${ch.id}&from=${from}&to=${to}`)).json() as Record<string, EpgProgram[]>;
  const ours = epg[String(ch.id)]!.map((p) => [p.title, p.start, p.end]);
  const truth = programmesBetween(ch.epgChannelId!, Math.floor(from / 1000), Math.ceil(to / 1000))
    .filter((p) => p.stop * 1000 > from && p.start * 1000 < to)
    .map((p) => [p.title, p.start * 1000, p.stop * 1000]);
  expect(ours.length).toBeGreaterThan(3);
  expect(ours).toEqual(truth);
});

test('timeshift asks the provider for the right moment', async () => {
  const ch = mock.catalog.live.find((c) => c.archive && c.profile === 'live_h264_aac')!;
  const at = Math.floor((Date.now() - 95 * 60_000) / 60_000) * 60_000;
  const pi = (await get(`/api/play/live/${ch.id}/at?at=${at}`)).json() as PlaybackInfo;
  expect(pi.startsAt).toBe(at);

  // the URL the server builds is read by the provider (in its own zone) as that same instant
  const url = built.services.source.client()!.timeshiftUrl(String(ch.id), at, 10, built.services.source.timezone());
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  expect(res.status).toBe(200);
  expect(Number(res.headers.get('x-mock-content-start')) * 1000).toBe(at);
  ac.abort();

  // and the archive window (in the timeline) starts where the provider's does
  const tl = (await get(`/api/timeline/${ch.id}`)).json() as TimelineInfo;
  expect(tl.ranges[0]!.start).toBe(tl.now - ch.archiveDays * 86400_000);
});
