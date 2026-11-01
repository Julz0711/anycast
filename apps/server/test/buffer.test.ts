import type { PlaybackInfo, TimelineInfo } from '@anycast/shared';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { BufferStatus } from '../src/playback/buffer';
import { berlinSecondsOfDay, BUFFER_TEST, channelStatus, dayDiff, firstVideoPts, until } from './buffer-helpers';
import { createMockXtream, login, makeApp } from './helpers';

const MSE = JSON.stringify({ hls: false, mse: true, codecs: ['avc1', 'mp4a'] });

let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let base: string;
const open: AbortController[] = [];
const tmp = mkdtempSync(path.join(os.tmpdir(), 'anycast-buf-'));

async function get(url: string, init: RequestInit = {}) {
  const ac = new AbortController();
  open.push(ac);
  const res = await fetch(base + url, { ...init, headers: { cookie, 'x-anycast-caps': MSE, 'content-type': 'application/json', ...init.headers }, signal: ac.signal });
  return { res, close: () => ac.abort() };
}
const json = async <T>(url: string, init: RequestInit = {}) => {
  const { res } = await get(url, init);
  return { status: res.status, body: (await res.json()) as T };
};
const status = async () => (await json<BufferStatus>('/api/buffer/status')).body;
/** Opens a raw TS viewer and keeps reading it in the background. */
async function watch(id: string) {
  const v = await get(`/api/stream/live/${id}.ts`);
  expect(v.res.status).toBe(200);
  const reader = v.res.body!.getReader();
  void (async () => {
    try {
      while (!(await reader.read()).done);
    } catch {
      /* aborted */
    }
  })();
  return v;
}

const noArchive = () => mock.catalog.live.filter((c) => !c.archive && c.profile === 'live_h264_aac').map((c) => String(c.id));

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', maxConnections: 2, username: 'buf-user', password: 'buf-pass-2210' });
  built = await makeApp({ url: mock.url, username: mock.username, password: mock.password }, { config: { buffer: BUFFER_TEST } });
  await built.services.sync.syncCatalog();
  cookie = await login(built.app);
  base = await built.app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  for (const ac of open.splice(0)) ac.abort();
  mock.setFaults({ dropAfterSeconds: 0 });
  await until(() => built.services.playback.pool.active === 0 && mock.state().activeConnections === 0, 10_000);
});

afterAll(async () => {
  await built.app.close();
  await mock.close();
});

describe('rolling buffer', () => {
  test('rewind to tune-in on a channel without archive, from the shared upstream, with matching content time', async () => {
    const id = noArchive()[0]!;
    const tuneIn = Date.now();
    const viewer = await watch(id);
    expect(await until(async () => (channelStatus(await status(), id)?.durationMs ?? 0) >= 6000)).toBe(true);
    // the recorder taps the viewer's connection: still exactly one provider connection
    expect(mock.state().activeConnections).toBe(1);
    expect(built.services.playback.pool.active).toBe(1);

    const tl = (await json<TimelineInfo>(`/api/timeline/${id}`)).body;
    expect(tl.ranges.map((r) => r.source)).toEqual(['buffer', 'live']);
    const range = tl.ranges[0]!;
    expect(range.start).toBeGreaterThanOrEqual(tuneIn - 1000);
    expect(range.start).toBeLessThan(tuneIn + 5000);
    expect(tl.ranges[1]!.start).toBe(range.end);
    expect(tl.ranges[1]!.end).toBe(tl.now);
    expect(tl.gaps).toHaveLength(1);
    expect(tl.gaps[0]!.reason).toMatch(/^This channel has no archive before \d\d:\d\d$/);

    const at = range.start + 500;
    const pi = (await json<PlaybackInfo>(`/api/play/live/${id}/at?at=${at}`)).body;
    expect(pi).toMatchObject({ type: 'hls', pipeline: 'passthrough' });
    expect(pi.url).toMatch(new RegExp(`^/api/stream/buffer/${id}/\\d+/\\d+/index\\.m3u8$`));
    expect(pi.startsAt).toBeLessThanOrEqual(at);

    const playlist = await (await get(pi.url)).res.text();
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
    expect(playlist).not.toContain('#EXT-X-ENDLIST');
    const segs = playlist.split('\n').filter((l) => l.endsWith('.ts'));
    const seg = await get(pi.url.replace('index.m3u8', segs[0]!));
    expect(seg.res.status).toBe(200);
    expect(seg.res.headers.get('content-type')).toBe('video/mp2t');
    const file = path.join(tmp, 'first.ts');
    writeFileSync(file, Buffer.from(await seg.res.arrayBuffer()));
    // mock convention: first video PTS = content time as seconds since local midnight (Europe/Berlin)
    expect(dayDiff(firstVideoPts(file), berlinSecondsOfDay(pi.startsAt!))).toBeLessThan(2);

    // the EVENT playlist grows while recording continues
    expect(await until(async () => (await (await get(pi.url)).res.text()).split('\n').filter((l) => l.endsWith('.ts')).length > segs.length)).toBe(true);

    // a viewer leaving: recording continues for the grace period, then stops
    viewer.close();
    await new Promise((r) => setTimeout(r, 500));
    expect(channelStatus(await status(), id)?.recording).toBe(true);
    expect(mock.state().activeConnections).toBe(1);
    expect(await until(async () => !channelStatus(await status(), id)?.recording, 8000)).toBe(true);
    expect(await until(() => mock.state().activeConnections === 0, 5000)).toBe(true);
    // buffered data is kept and still playable
    const after = (await json<TimelineInfo>(`/api/timeline/${id}`)).body;
    expect(after.ranges[0]!.source).toBe('buffer');
    expect(after.gaps[after.gaps.length - 1]!.reason).toBe('Not recorded: nobody was watching');
    const pl2 = await (await get(pi.url)).res.text();
    expect(pl2).toContain('#EXT-X-ENDLIST');
  });

  test('an upstream drop mid-buffer shows as a "Stream dropped" gap', async () => {
    const id = noArchive()[1]!;
    mock.setFaults({ dropAfterSeconds: 7 });
    await watch(id);
    expect(await until(async () => (channelStatus(await status(), id)?.durationMs ?? 0) >= 2000)).toBe(true);
    expect(await until(async () => !channelStatus(await status(), id)?.recording, 10_000)).toBe(true);
    mock.setFaults({ dropAfterSeconds: 0 });
    await new Promise((r) => setTimeout(r, 1500));
    await watch(id);
    expect(await until(async () => (channelStatus(await status(), id)?.ranges.length ?? 0) >= 2)).toBe(true);
    const tl = (await json<TimelineInfo>(`/api/timeline/${id}`)).body;
    const buffers = tl.ranges.filter((r) => r.source === 'buffer');
    expect(buffers.length).toBe(2);
    const gap = tl.gaps.find((g) => g.start === buffers[0]!.end);
    expect(gap).toMatchObject({ end: buffers[1]!.start, reason: 'Stream dropped' });
    // asking for a time inside the gap explains why
    const refused = await get(`/api/play/live/${id}/at?at=${Math.round((gap!.start + gap!.end) / 2)}`);
    expect(refused.res.status).toBe(422);
    expect((await refused.res.json()).message).toBe('Stream dropped');
  });

  test('pins: continuous recording without viewers, persisted, guarded by the connection limit', async () => {
    const [a, b] = noArchive().slice(2);
    const initial = await json<{ channelIds: string[]; maxPins: number | null }>('/api/buffer/pins');
    expect(initial.body).toEqual({ channelIds: [], maxPins: 1 });
    const pinned = await json<{ channelIds: string[] }>('/api/buffer/pins', { method: 'PUT', body: JSON.stringify({ channelId: a, pinned: true }) });
    expect(pinned).toEqual({ status: 200, body: { channelIds: [a], maxPins: 1 } });
    expect(await until(async () => (channelStatus(await status(), a!)?.durationMs ?? 0) >= 2000)).toBe(true);
    const st = channelStatus(await status(), a!)!;
    expect(st).toMatchObject({ pinned: true, recording: true });
    expect(mock.state().activeConnections).toBe(1);

    // a second pin would leave no connection for watching
    const refused = await json<{ error: string; message: string }>('/api/buffer/pins', { method: 'PUT', body: JSON.stringify({ channelId: b, pinned: true }) });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('pin_limit');
    expect(refused.body.message).toContain('one stays free for watching');
    expect((await json<unknown>('/api/buffer/pins', { method: 'PUT', body: JSON.stringify({ channelId: 'nope', pinned: true }) })).status).toBe(404);
    expect((await json<unknown>('/api/buffer/pins', { method: 'PUT', body: JSON.stringify({ channelId: a }) })).status).toBe(400);

    // watching the pinned channel shares its connection
    await watch(a!);
    expect(mock.state().activeConnections).toBe(1);
    for (const ac of open.splice(0)) ac.abort();
    await new Promise((r) => setTimeout(r, BUFFER_TEST.graceMs + 500));
    expect(channelStatus(await status(), a!)?.recording).toBe(true);

    const unpinned = await json<{ channelIds: string[] }>('/api/buffer/pins', { method: 'PUT', body: JSON.stringify({ channelId: a, pinned: false }) });
    expect(unpinned.body.channelIds).toEqual([]);
    expect(await until(() => mock.state().activeConnections === 0, 8000)).toBe(true);
    expect(channelStatus(await status(), a!)).toMatchObject({ pinned: false, recording: false });
    const s = await status();
    expect(s.caps).toEqual({ maxHoursPerChannel: 1, maxBytes: 1024 ** 3, maxPins: 1 });
    expect(s.totalBytes).toBe(s.channels.reduce((n, c) => n + c.bytes, 0));
  });
});
