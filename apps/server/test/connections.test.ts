/**
 * One provider connection (max_connections = 1): zapping releases the old stream before the new
 * one opens, a busy connection names its holder, and another device can take it over.
 */
import type { ConnectionBusyError, PlaybackInfo, Profile, SyncEvent } from '@anycast/shared';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { BUFFER_TEST, until } from './buffer-helpers';
import { createMockXtream, login, makeApp } from './helpers';

const MSE = JSON.stringify({ hls: false, mse: true, codecs: ['avc1', 'mp4a'] });

let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let base: string;
let me: Profile;
let kid: Profile;
const open: AbortController[] = [];

interface Client { id: string; profile: Profile; device: string }
const A = (): Client => ({ id: 'client-aaaa-0001', profile: me, device: 'Device A' });
const B = (): Client => ({ id: 'client-bbbb-0002', profile: kid, device: 'Device B' });

async function req(c: Client | null, url: string, init: RequestInit = {}) {
  const ac = new AbortController();
  open.push(ac);
  const headers: Record<string, string> = { cookie, 'x-anycast-caps': MSE, ...(init.headers as Record<string, string>) };
  if (c) Object.assign(headers, { 'x-anycast-client': c.id, 'x-anycast-device': c.device, 'x-anycast-profile': c.profile.id });
  return fetch(base + url, { ...init, headers, signal: ac.signal });
}
async function play(c: Client, url: string): Promise<{ status: number; body: PlaybackInfo & Partial<ConnectionBusyError> }> {
  const res = await req(c, url);
  return { status: res.status, body: (await res.json()) as PlaybackInfo & Partial<ConnectionBusyError> };
}
/** Opens a stream and keeps reading it; `ended` resolves when the server ends it. */
async function watch(c: Client, url: string) {
  const res = await req(c, url);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  let bytes = 0;
  const ended = (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        bytes += r.value.length;
      }
    } catch {
      /* aborted */
    }
  })();
  return { ended, bytes: () => bytes };
}
function events(profile: Profile) {
  const list: SyncEvent[] = [];
  const ac = new AbortController();
  open.push(ac);
  void (async () => {
    const res = await fetch(`${base}/api/events?profile=${profile.id}`, { headers: { cookie }, signal: ac.signal });
    const reader = res.body!.getReader();
    let buf = '';
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (r.done) return;
      buf += new TextDecoder().decode(r.value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (data) list.push(JSON.parse(data.slice(6)) as SyncEvent);
      }
    }
  })();
  return list;
}

let named = new Map<string, string>();
/** H.264/AAC channels, with the names the server shows */
const channels = () => mock.catalog.live.filter((c) => c.profile === 'live_h264_aac').map((c) => ({ id: String(c.id), name: named.get(String(c.id))! }));

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', maxConnections: 1, username: 'one-user', password: 'one-pass-8812' });
  // a long grace period: only connection pressure may end a recording early
  built = await makeApp({ url: mock.url, username: mock.username, password: mock.password }, { config: { buffer: { ...BUFFER_TEST, graceMs: 600_000 } } });
  await built.services.sync.syncCatalog();
  cookie = await login(built.app);
  base = await built.app.listen({ port: 0, host: '127.0.0.1' });
  me = ((await (await req(null, '/api/profiles')).json()) as Profile[])[0]!;
  named = new Map(((await (await req(null, '/api/live?limit=500')).json()) as { items: { id: string; name: string }[] }).items.map((c) => [c.id, c.name]));
  kid = (await (await req(null, '/api/profiles', { method: 'POST', body: JSON.stringify({ name: 'Kid' }), headers: { 'content-type': 'application/json' } })).json()) as Profile;
});

afterEach(async () => {
  for (const ac of open.splice(0)) ac.abort();
  for (const c of [A(), B()]) built.services.playback.stopClient(c.id);
  built.services.playback.sessions.closeAll();
  await until(() => built.services.playback.pool.active === 0 && mock.state().activeConnections === 0, 10_000);
  await mock.reset();
});

afterAll(async () => {
  await built.app.close();
  await mock.close();
});

describe('one provider connection', () => {
  test('zapping releases the old channel (and its recording) before opening the next', async () => {
    const [one, two, three] = channels();
    const a = A();
    const p1 = await play(a, `/api/play/live/${one!.id}`);
    expect(p1.status).toBe(200);
    const s1 = await watch(a, p1.body.url);
    expect(await until(() => s1.bytes() > 50_000)).toBe(true);
    expect(await until(() => built.services.playback.buffer!.isRecording(one!.id))).toBe(true);

    for (const next of [two!, three!]) {
      const p = await play(a, `/api/play/live/${next.id}`);
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const s = await watch(a, p.body.url);
      expect(await until(() => s.bytes() > 50_000)).toBe(true);
    }
    await s1.ended; // the server ended the first stream
    expect(built.services.playback.buffer!.isRecording(one!.id)).toBe(false);
    expect(built.services.playback.pool.keys()).toEqual([`live:${three!.id}`]);
    // never two provider connections at once
    expect(mock.state().peakConnections).toBe(1);
    // the old player's late requests do not reopen the channel
    const late = await req(a, `/api/stream/live/${one!.id}.ts`);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: 'taken_over' });
  });

  test('HLS clients zap without overlap too', async () => {
    const [one, two] = channels();
    const a = A();
    const hls = { 'x-anycast-caps': JSON.stringify({ hls: true, mse: false, codecs: ['avc1', 'mp4a'] }) };
    const p1 = (await (await req(a, `/api/play/live/${one!.id}`, { headers: hls })).json()) as PlaybackInfo;
    expect(p1.type).toBe('hls');
    expect((await req(a, p1.url)).status).toBe(200);
    const r2 = await req(a, `/api/play/live/${two!.id}`, { headers: hls });
    expect(r2.status).toBe(200);
    const p2 = (await r2.json()) as PlaybackInfo;
    expect((await req(a, p2.url)).status).toBe(200);
    expect(built.services.playback.pool.keys()).toEqual([`live:${two!.id}`]);
    expect(mock.state().peakConnections).toBe(1);
    // the first channel's playlist is gone and does not come back
    expect((await req(a, p1.url)).status).toBe(409);
  });

  test('another device watching something else: busy with the holder; same channel is shared', async () => {
    const [one, two] = channels();
    const a = A();
    const b = B();
    const p = await play(a, `/api/play/live/${one!.id}`);
    await watch(a, p.body.url);

    const busy = await play(b, `/api/play/live/${two!.id}`);
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({
      error: 'connection_busy', canTakeOver: true,
      holder: { profileName: me.name, channelName: one!.name, device: 'Device A' },
    });

    const shared = await play(b, `/api/play/live/${one!.id}`);
    expect(shared.status).toBe(200);
    const sb = await watch(b, shared.body.url);
    expect(await until(() => sb.bytes() > 50_000)).toBe(true);
    expect(mock.state().peakConnections).toBe(1);
  });

  test('take over: the other device is stopped and told so; its stream does not come back', async () => {
    const [one, two] = channels();
    const a = A();
    const b = B();
    const seenByA = events(me);
    await new Promise((r) => setTimeout(r, 200));
    const pa = await play(a, `/api/play/live/${one!.id}`);
    const sa = await watch(a, pa.body.url);
    expect(await until(() => sa.bytes() > 10_000)).toBe(true);

    expect((await play(b, `/api/play/live/${two!.id}`)).status).toBe(409);
    const take = await req(b, '/api/play/takeover', { method: 'POST' });
    expect(await take.json()).toEqual({ ok: true, stopped: true });
    await sa.ended;
    expect(await until(() => seenByA.some((e) => e.type === 'playback-stopped'))).toBe(true);
    expect(seenByA.find((e) => e.type === 'playback-stopped')).toEqual({
      type: 'playback-stopped', profileId: me.id, clientId: a.id, reason: 'taken-over', by: { profileName: 'Kid', device: 'Device B' },
    });

    const pb = await play(b, `/api/play/live/${two!.id}`);
    expect(pb.status, JSON.stringify(pb.body)).toBe(200);
    const sb = await watch(b, pb.body.url);
    expect(await until(() => sb.bytes() > 50_000)).toBe(true);
    // A's player retrying its old stream gets 409, so it cannot steal the connection back
    expect((await req(a, `/api/stream/live/${one!.id}.ts`)).status).toBe(409);
    // A asking to play again is a fresh request: now B is the holder
    const again = await play(a, `/api/play/live/${one!.id}`);
    expect(again.status).toBe(409);
    expect(again.body.holder).toMatchObject({ profileName: 'Kid', channelName: two!.name });
    expect(mock.state().peakConnections).toBe(1);
  });

  test('movies count too', async () => {
    const movie = mock.catalog.movies.find((m) => m.profile === 'mp4_h264_aac')!;
    const a = A();
    const b = B();
    const pm = await play(a, `/api/play/movie/${movie.id}`);
    expect(pm.status).toBe(200);
    const sm = await watch(a, pm.body.url);
    expect(await until(() => sm.bytes() > 0 || built.services.playback.pool.active > 0)).toBe(true);
    const busy = await play(b, `/api/play/live/${channels()[0]!.id}`);
    expect(busy.status).toBe(409);
    const name = ((await (await req(null, `/api/items?movie=${movie.id}`)).json()) as { movies: { name: string }[] }).movies[0]!.name;
    expect(busy.body.holder).toEqual({ profileName: me.name, channelName: name, device: 'Device A' });
  });

  test('closing the player releases the connection at once', async () => {
    const a = A();
    const p = await play(a, `/api/play/live/${channels()[0]!.id}`);
    const s = await watch(a, p.body.url);
    expect(await until(() => s.bytes() > 10_000)).toBe(true);
    await req(a, '/api/play/stop', { method: 'POST' });
    await s.ended;
    expect(await until(() => built.services.playback.pool.active === 0, 2000)).toBe(true);
  });

  test('switching the audio track of an archive stream reuses the one connection', async () => {
    const ch = mock.catalog.live.find((c) => c.profile === 'live_h264_aac_multi' && c.archive)!;
    const a = A();
    const at = Date.now() - 5 * 60_000;
    // the first track plays directly (raw TS straight from the provider)
    const p0 = await play(a, `/api/play/live/${ch.id}/at?at=${at}`);
    expect(p0.status, JSON.stringify(p0.body)).toBe(200);
    expect(p0.body.type).toBe('mpegts');
    const s0 = await watch(a, p0.body.url);
    expect(await until(() => s0.bytes() > 50_000)).toBe(true);
    // the second goes through FFmpeg: the direct stream is stopped before it opens its own
    const p1 = await play(a, `/api/play/live/${ch.id}/at?at=${at}&audio=1`);
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    expect(p1.body.url).toMatch(/\/remux\/a1\/index\.m3u8$/);
    // at once (the archive stream itself would run for a while)
    expect(await Promise.race([s0.ended.then(() => 'ended'), new Promise((r) => setTimeout(() => r('still open'), 3000))])).toBe('ended');
    const res = await req(a, p1.body.url);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.text()).toContain('#EXTINF');
    expect(mock.state().peakConnections).toBe(1);
  });

  test('no channel can be pinned: the one connection stays free for watching', async () => {
    const pins = (await (await req(null, '/api/buffer/pins')).json()) as { maxPins: number };
    expect(pins.maxPins).toBe(0);
    const res = await req(null, '/api/buffer/pins', { method: 'PUT', body: JSON.stringify({ channelId: channels()[0]!.id, pinned: true }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'pin_limit', message: expect.stringContaining('1 provider connection') });
  });
});
