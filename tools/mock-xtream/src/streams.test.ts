import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FORMAT_MATRIX } from './matrix.js';
import { createMockXtream, type MockXtream } from './server.js';
import { formatLocal, secondsOfDay } from './tz.js';
import { dayDiff, firstVideoPts, readFor, streamCodecs, waitFor, writeTemp } from './test-helpers.js';

let mock: MockXtream;
const TZ = 'Europe/Berlin';

beforeAll(async () => {
  mock = await createMockXtream({ size: 'small' });
});
afterAll(async () => {
  await mock.close();
});
afterEach(async () => {
  await mock.reset();
});

const liveEntry = (profile: string) => FORMAT_MATRIX.find((e) => e.kind === 'live' && e.id === profile)!;
const archiveChannel = () => mock.catalog.live.find((c) => c.archive && c.profile === 'live_h264_aac')!;

/** "YYYY-MM-DD:HH-MM" in panel time, `minutesAgo` minutes before now, rounded down to the minute. */
function shiftStart(minutesAgo: number): { path: string; epoch: number } {
  const epoch = Math.floor((Date.now() / 1000 - minutesAgo * 60) / 60) * 60;
  const local = formatLocal(epoch, TZ); // YYYY-MM-DD HH:MM:SS
  return { path: `${local.slice(0, 10)}:${local.slice(11, 13)}-${local.slice(14, 16)}`, epoch };
}

describe('live', () => {
  it('serves MPEG-TS whose clock (PTS-of-day) matches wall time', async () => {
    const id = liveEntry('live_h264_aac').ids[0]!;
    const requested = Date.now() / 1000;
    const r = await readFor(`${mock.url}/live/test/test/${id}.ts`, 2500);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp2t');
    expect(r.body.length).toBeGreaterThan(10_000);
    expect(r.body[0]).toBe(0x47); // TS sync byte
    const file = writeTemp('live.ts', r.body);
    expect(dayDiff(firstVideoPts(file), secondsOfDay(requested, TZ))).toBeLessThan(3);
    expect(Math.abs(Number(r.headers.get('x-mock-content-start')) - requested)).toBeLessThan(3);
    expect(streamCodecs(file).map((s) => s.codec_name)).toEqual(['h264', 'aac']);
  });

  it('exposes HEVC and AC3 live channels', async () => {
    const [hevc, ac3] = await Promise.all([
      readFor(`${mock.url}/live/test/test/${liveEntry('live_hevc_aac').ids[0]}.ts`, 3000),
      readFor(`${mock.url}/live/test/test/${liveEntry('live_h264_ac3').ids[0]}.ts`, 3000),
    ]);
    expect(streamCodecs(writeTemp('hevc.ts', hevc.body)).map((s) => s.codec_name)).toContain('hevc');
    expect(streamCodecs(writeTemp('ac3.ts', ac3.body)).map((s) => s.codec_name)).toContain('ac3');
  });

  it('accepts /{u}/{p}/{id} without extension and rejects bad credentials', async () => {
    const r = await readFor(`${mock.url}/test/test/1`, 1500);
    expect(r.status).toBe(200);
    expect(r.body[0]).toBe(0x47);
    expect((await fetch(`${mock.url}/live/test/nope/1.ts`)).status).toBe(403);
    expect((await fetch(`${mock.url}/live/test/test/999999.ts`)).status).toBe(404);
  });

  it('serves an HLS playlist with fetchable segments', async () => {
    const res = await fetch(`${mock.url}/live/test/test/1.m3u8`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('#EXTM3U');
    const seg = text.split('\n').find((l) => l.startsWith('/hls/'))!;
    const segRes = await fetch(`${mock.url}${seg}`);
    expect(segRes.status).toBe(200);
    expect(Buffer.from(await segRes.arrayBuffer())[0]).toBe(0x47);
    expect(mock.state().connections.some((c) => c.kind === 'hls')).toBe(true);
  });
});

describe('timeshift', () => {
  it('starts at the requested time (header + PTS-of-day)', async () => {
    const c = archiveChannel();
    const { path, epoch } = shiftStart(90);
    const r = await readFor(`${mock.url}/timeshift/test/test/2/${path}/${c.id}.ts`, 2000, 400_000);
    expect(r.status).toBe(200);
    expect(Number(r.headers.get('x-mock-content-start'))).toBe(epoch);
    expect(r.headers.get('x-mock-content-start-local')).toBe(formatLocal(epoch, TZ));
    const pts = firstVideoPts(writeTemp('shift.ts', r.body));
    expect(dayDiff(pts, secondsOfDay(epoch, TZ))).toBeLessThan(0.5);
  });

  it('supports /streaming/timeshift.php and limits the duration', async () => {
    const c = archiveChannel();
    const { path, epoch } = shiftStart(30);
    const r = await fetch(`${mock.url}/streaming/timeshift.php?username=test&password=test&stream=${c.id}&start=${path}&duration=1`);
    expect(r.status).toBe(200);
    expect(Number(r.headers.get('x-mock-content-start'))).toBe(epoch);
    expect(r.headers.get('x-mock-duration')).toBe('60');
    const body = Buffer.from(await r.arrayBuffer());
    const file = writeTemp('short.ts', body);
    expect(firstVideoPts(file)).toBeCloseTo(secondsOfDay(epoch, TZ), 0);
  });

  it('404s for channels without archive or times outside the window', async () => {
    const noArchive = mock.catalog.live.find((c) => !c.archive)!;
    const c = archiveChannel();
    const { path } = shiftStart(30);
    const a = await fetch(`${mock.url}/timeshift/test/test/30/${path}/${noArchive.id}.ts`);
    expect(a.status).toBe(404);
    expect(a.headers.get('x-mock-error')).toMatch(/archive/);
    const tooOld = shiftStart((c.archiveDays + 1) * 1440);
    expect((await fetch(`${mock.url}/timeshift/test/test/30/${tooOld.path}/${c.id}.ts`)).status).toBe(404);
    const future = shiftStart(-120);
    expect((await fetch(`${mock.url}/timeshift/test/test/30/${future.path}/${c.id}.ts`)).status).toBe(404);
  });
});

describe('VOD', () => {
  it('serves fixtures with HTTP Range and the advertised duration', async () => {
    const entry = FORMAT_MATRIX.find((e) => e.kind === 'movie' && e.id === 'mp4_h264_aac')!;
    const id = [...entry.ids].sort((a, b) => entry.durations![a]! - entry.durations![b]!)[0]!;
    const url = `${mock.url}/movie/test/test/${id}.mp4`;
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    const size = Number(full.headers.get('content-length'));
    const body = Buffer.from(await full.arrayBuffer());
    expect(body.length).toBe(size);

    const part = await fetch(url, { headers: { Range: 'bytes=1000-1999' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 1000-1999/${size}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(body.subarray(1000, 2000))).toBe(true);

    const tail = await fetch(url, { headers: { Range: 'bytes=-500' } });
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer()).equals(body.subarray(size - 500))).toBe(true);

    expect((await fetch(url, { headers: { Range: `bytes=${size + 10}-` } })).status).toBe(416);

    const file = writeTemp('movie.mp4', body);
    const probe = (await import('./test-helpers.js')).ffprobe(file, ['-show_entries', 'format=duration']) as { format: { duration: string } };
    expect(Math.abs(Number(probe.format.duration) - entry.durations![id]!)).toBeLessThan(1);
    const info = await (await fetch(`${mock.url}/player_api.php?username=test&password=test&action=get_vod_info&vod_id=${id}`)).json() as any;
    expect(info.info.duration_secs).toBe(entry.durations![id]);
  });
});

describe('VOD format matrix', () => {
  const shortest = (e: (typeof FORMAT_MATRIX)[number]) => [...e.ids].sort((a, b) => e.durations![a]! - e.durations![b]!)[0]!;

  it('every movie profile has the advertised codecs and tracks', async () => {
    const entries = FORMAT_MATRIX.filter((e) => e.kind === 'movie' && e.id !== 'mp4_h264_aac');
    const wide = await createMockXtream({ size: 'small', maxConnections: 10 });
    try {
    await Promise.all(
      entries.map(async (e) => {
        const id = shortest(e);
        const res = await fetch(`${wide.url}/movie/test/test/${id}.${e.container}`);
        expect(res.status, e.id).toBe(200);
        const streams = streamCodecs(writeTemp(`m.${e.container}`, Buffer.from(await res.arrayBuffer())));
        expect(streams.filter((s) => s.codec_type === 'video').map((s) => s.codec_name), e.id).toEqual([e.video]);
        expect(streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name), e.id).toEqual(e.audio.map((a) => a.codec));
        expect(streams.filter((s) => s.codec_type === 'subtitle').map((s) => s.language), e.id).toEqual(e.subtitles.map((a) => a.language));
        if (e.audio.length > 1) {
          expect(streams.filter((s) => s.codec_type === 'audio').map((s) => s.language)).toEqual(e.audio.map((a) => a.language));
        }
      }),
    );
    } finally {
      await wide.close();
    }
  }, 60_000);

  it('serves series episodes', async () => {
    const e = FORMAT_MATRIX.find((x) => x.kind === 'episode' && x.id === 'ts_h264_aac')!;
    const id = shortest(e);
    const res = await fetch(`${mock.url}/series/test/test/${id}.ts`, { headers: { Range: 'bytes=0-187' } });
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer())[0]).toBe(0x47);
  });
});

describe('connection limit', () => {
  it('rejects the third stream with 509 and reports active_cons', async () => {
    const acs = [new AbortController(), new AbortController()];
    const opened = await Promise.all(acs.map((ac) => fetch(`${mock.url}/live/test/test/1.ts`, { signal: ac.signal })));
    expect(opened.map((r) => r.status)).toEqual([200, 200]);
    const third = await fetch(`${mock.url}/live/test/test/5.ts`);
    expect(third.status).toBe(509);
    expect(await third.text()).toBe('');
    const info = await (await fetch(`${mock.url}/player_api.php?username=test&password=test`)).json() as any;
    expect(info.user_info.active_cons).toBe('2');
    expect(mock.state().activeConnections).toBe(2);
    acs.forEach((ac) => ac.abort());
    await waitFor(() => mock.state().activeConnections === 0);
  });
});

describe('faults (streams)', () => {
  it('connectionLimitReached and expired reject streams', async () => {
    mock.setFaults({ connectionLimitReached: true });
    expect((await fetch(`${mock.url}/live/test/test/1.ts`)).status).toBe(509);
    mock.setFaults({ connectionLimitReached: false, expired: true });
    expect((await fetch(`${mock.url}/live/test/test/1.ts`)).status).toBe(403);
  });

  it('slowStartMs delays the first byte and dropAfterSeconds cuts the stream', async () => {
    mock.setFaults({ slowStartMs: 800, dropAfterSeconds: 2 });
    const t = Date.now();
    const res = await fetch(`${mock.url}/live/test/test/1.ts`);
    expect(Date.now() - t).toBeGreaterThanOrEqual(750);
    let ended = false;
    try {
      for await (const _ of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (Date.now() - t > 8000) break;
      }
      ended = true;
    } catch {
      ended = true; // socket destroyed mid-stream
    }
    expect(ended).toBe(true);
    expect(Date.now() - t).toBeLessThan(6000);
    await waitFor(() => mock.state().activeConnections === 0);
  });

  it('redirectStreams answers with a tokenised 302', async () => {
    mock.setFaults({ redirectStreams: true });
    const r = await fetch(`${mock.url}/live/test/test/1.ts`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/\/live\/test\/test\/1\.ts\?token=[0-9a-f]+$/);
  });
});
