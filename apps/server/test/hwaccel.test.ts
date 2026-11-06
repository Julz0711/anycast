/**
 * Hardware encoding: FFmpeg arguments per method, picking an encoder with test encodes, falling
 * back to libx264 when a hardware run fails during playback, and what diagnostics show. No GPU
 * is needed: test encodes are faked, and "the hardware failed" is a real FFmpeg run pointed at a
 * render device that does not exist.
 */
import type { PlaybackInfo, ServerDiagnostics, VideoEncoderStatus } from '@anycast/shared';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { hwaccelFromEnv } from '../src/config';
import { openDb } from '../src/db';
import { buildHlsArgs, hwTestArgs, videoEncoderArgs, type HlsArgs, type VideoEncoder } from '../src/playback/ffmpeg';
import { HwAccel, parseHwSetting, runFfmpegTest, summarizeError, type EncodeRunner } from '../src/playback/hwaccel';
import { createMockXtream, FORMAT_MATRIX, login, makeApp } from './helpers';

const DEV = '/dev/dri/renderD128';
const VAAPI: VideoEncoder = { method: 'vaapi', device: DEV };
const QSV: VideoEncoder = { method: 'qsv', device: DEV };
const NVENC: VideoEncoder = { method: 'nvenc' };

describe('ffmpeg arguments', () => {
  const vod: HlsArgs = { input: 'http://x/movie.mkv', pipeline: 'transcode', dir: '/tmp/s', run: 3, segmentSeconds: 6, mode: 'vod', seek: 60, startNumber: 10 };
  const kf = 'expr:gte(t,60.000+n_forced*6)';
  /** the arguments after the video encoder's: audio, timestamps, HLS muxer */
  const tail = (args: string[]) => args.slice(args.indexOf('-c:a'));

  test('libx264 arguments are exactly as before', () => {
    const args = buildHlsArgs(vod);
    expect(args.join(' ')).toContain(
      `-c:v libx264 -preset veryfast -crf 21 -maxrate 8M -bufsize 16M -pix_fmt yuv420p -vf scale='min(1920,iw)':-2 -force_key_frames ${kf} -c:a aac`,
    );
    expect(buildHlsArgs({ ...vod, video: { method: 'software' } })).toEqual(args);
    // only the full transcode encodes video; the other pipelines ignore the encoder
    expect(buildHlsArgs({ ...vod, pipeline: 'remux', video: VAAPI })).toEqual(buildHlsArgs({ ...vod, pipeline: 'remux' }));
    expect(buildHlsArgs({ ...vod, pipeline: 'transcode-audio', video: NVENC }).join(' ')).not.toMatch(/nvenc|-vf/);
  });

  test('VAAPI: device before the input, software scale to NV12 (10-bit sources too), upload, h264_vaapi', () => {
    const args = buildHlsArgs({ ...vod, video: VAAPI });
    const s = args.join(' ');
    expect(args.indexOf('-vaapi_device')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-vaapi_device') + 1]).toBe(DEV);
    expect(args.indexOf('-vaapi_device')).toBeLessThan(args.indexOf('-ss'));
    expect(s).toContain(`-vf scale='min(1920,iw)':-2,format=nv12,hwupload -c:v h264_vaapi -b:v 6M -maxrate 8M -bufsize 16M -force_key_frames ${kf}`);
    expect(s).not.toContain('libx264');
    expect(s).not.toContain('-pix_fmt');
    expect(tail(args)).toEqual(tail(buildHlsArgs(vod)));
  });

  test('QSV: a QSV device derived from VAAPI, upload into QSV surfaces, forced frames are IDR', () => {
    const args = buildHlsArgs({ ...vod, video: QSV });
    const s = args.join(' ');
    expect(s).toContain(`-init_hw_device vaapi=va:${DEV} -init_hw_device qsv=qs@va -filter_hw_device qs`);
    expect(args.indexOf('-filter_hw_device')).toBeLessThan(args.indexOf('-i'));
    expect(s).toContain("-vf scale='min(1920,iw)':-2,format=nv12,hwupload=extra_hw_frames=64,format=qsv -c:v h264_qsv -preset veryfast -b:v 6M -maxrate 8M -bufsize 16M");
    expect(s).toContain(`-forced_idr 1 -force_key_frames ${kf}`);
    expect(tail(args)).toEqual(tail(buildHlsArgs(vod)));
  });

  test('NVENC: preset p4, VBR under the same cap, 8-bit 4:2:0, forced frames are IDR', () => {
    const args = buildHlsArgs({ ...vod, video: NVENC });
    const s = args.join(' ');
    expect(args.slice(0, args.indexOf('-i'))).not.toContain('-init_hw_device');
    expect(s).toContain(`-vf scale='min(1920,iw)':-2,format=yuv420p -c:v h264_nvenc -preset p4 -rc vbr -b:v 6M -maxrate 8M -bufsize 16M -forced-idr 1 -force_key_frames ${kf}`);
    expect(tail(args)).toEqual(tail(buildHlsArgs(vod)));
  });

  test('live: the same keyframe slots and live HLS window as libx264', () => {
    const live: HlsArgs = { input: 'pipe:0', pipeline: 'transcode', dir: '/d', run: 0, segmentSeconds: 4, mode: 'live' };
    for (const video of [VAAPI, QSV, NVENC]) {
      const args = buildHlsArgs({ ...live, video });
      expect(args).toContain('expr:gte(t,n_forced*4)');
      expect(args.join(' ')).toContain('-hls_time 4');
      expect(args.join(' ')).toContain('-hls_list_size 8 -hls_flags delete_segments+independent_segments');
      // device setup, then the MPEG-TS stdin input
      expect(args.indexOf('-f')).toBeGreaterThan(args.indexOf('-nostats'));
      expect(args[args.indexOf('-i') - 1]).toBe('mpegts');
    }
  });

  test('the test encode uses the same device setup and filter chain, into a null output', () => {
    for (const video of [VAAPI, QSV, NVENC]) {
      const t = hwTestArgs(video);
      const v = videoEncoderArgs(video, 'expr:gte(t,n_forced*1)');
      expect(t.join(' ')).toContain(`${v.input.join(' ')} -f lavfi -i testsrc2=size=320x240:rate=25 -t 1 ${v.output.join(' ')} -f null -`.trim());
    }
  });
});

describe('settings', () => {
  test('ANYCAST_HWACCEL and ANYCAST_VAAPI_DEVICE', () => {
    expect(hwaccelFromEnv({})).toEqual({ setting: 'auto', device: DEV });
    expect(hwaccelFromEnv({ ANYCAST_HWACCEL: 'VAAPI', ANYCAST_VAAPI_DEVICE: '/dev/dri/renderD129' })).toEqual({ setting: 'vaapi', device: '/dev/dri/renderD129' });
    expect(hwaccelFromEnv({ ANYCAST_HWACCEL: 'false' }).setting).toBe('off');
    expect(hwaccelFromEnv({ ANYCAST_HWACCEL: 'cuda' }).setting).toBe('auto');
    expect(parseHwSetting('nvenc')).toBe('nvenc');
    expect(parseHwSetting('')).toBeNull();
  });

  test('error summaries keep the telling line and drop paths', () => {
    const err = '[AVHWDeviceContext @ 0x55c1] No VA display found for device /dev/dri/renderD128.\nDevice creation failed: -22.\nError parsing global options: Invalid argument\n';
    expect(summarizeError(err)).toBe('No VA display found for device <path>');
    expect(summarizeError('')).toBe('failed');
  });
});

/** A fake test encoder: which methods "work", and the calls it got. */
function fakeRunner(works: string[], fail = 'Cannot load libcuda.so.1') {
  const calls: string[] = [];
  const run: EncodeRunner = async (args) => {
    const enc = args[args.indexOf('-c:v') + 1]!;
    calls.push(enc);
    await new Promise((r) => setTimeout(r, 5));
    return works.includes(enc) ? { ok: true, error: '' } : { ok: false, error: `[h264_nvenc @ 0x1] ${fail}\nError while opening encoder` };
  };
  return { run, calls };
}

describe('picking an encoder', () => {
  test('auto: the first method whose test encode works (NVENC, VAAPI, QSV), cached', async () => {
    const f = fakeRunner(['h264_vaapi']);
    const hw = new HwAccel({ setting: 'auto', run: f.run, deviceExists: () => true });
    expect(hw.current()).toEqual({ method: 'software' });
    expect(hw.status().reason).toMatch(/not been checked/);
    const [a, b] = await Promise.all([hw.encoder(), hw.encoder()]);
    expect(a).toEqual(VAAPI);
    expect(b).toBe(a);
    expect(f.calls).toEqual(['h264_nvenc', 'h264_vaapi']);
    await hw.encoder();
    expect(f.calls).toHaveLength(2);
    const s = hw.status();
    expect(s).toMatchObject({ active: 'h264_vaapi', method: 'vaapi', label: 'VAAPI', setting: 'auto', source: 'env', envSetting: 'auto', unhealthyUntil: null });
    expect(s.probes).toEqual([
      { method: 'nvenc', ok: false, error: 'Cannot load libcuda.so.1' },
      { method: 'vaapi', ok: true, error: null },
    ]);
    expect(s.reason).toMatch(/VAAPI passed a test encode/);
  });

  test('auto without a render device: VAAPI and QSV are not even tried', async () => {
    const f = fakeRunner([]);
    const hw = new HwAccel({ setting: 'auto', run: f.run, deviceExists: () => false });
    expect(await hw.encoder()).toEqual({ method: 'software' });
    expect(f.calls).toEqual(['h264_nvenc']);
    const s = hw.status();
    expect(s.active).toBe('libx264');
    expect(s.probes.map((p) => [p.method, p.ok, p.error])).toEqual([
      ['nvenc', false, 'Cannot load libcuda.so.1'],
      ['vaapi', false, 'no render device in the container (pass /dev/dri to it)'],
      ['qsv', false, 'no render device in the container (pass /dev/dri to it)'],
    ]);
    expect(s.reason).toMatch(/No hardware encoder passed/);
  });

  test('a chosen method is the only one tried; when it fails, software', async () => {
    const f = fakeRunner([], 'Error initializing an internal MFX session: unsupported (-3)');
    const hw = new HwAccel({ setting: 'qsv', run: f.run, deviceExists: () => true });
    expect(await hw.encoder()).toEqual({ method: 'software' });
    expect(f.calls).toEqual(['h264_qsv']);
    expect(hw.status().reason).toMatch(/Intel Quick Sync is selected but failed a test encode \(Error initializing an internal MFX session/);
    const ok = new HwAccel({ setting: 'nvenc', run: fakeRunner(['h264_nvenc']).run });
    expect(await ok.encoder()).toEqual(NVENC);
  });

  test('off: nothing is run', async () => {
    const f = fakeRunner(['h264_nvenc', 'h264_vaapi', 'h264_qsv']);
    const hw = new HwAccel({ setting: 'off', run: f.run, deviceExists: () => true });
    expect(await hw.encoder()).toEqual({ method: 'software' });
    expect(f.calls).toEqual([]);
    expect(hw.status()).toMatchObject({ active: 'libx264', reason: 'Hardware encoding is turned off.' });
    // the default (no setting) is off too: tests and embedders never probe unless asked
    expect(await new HwAccel({ run: f.run }).encoder()).toEqual({ method: 'software' });
  });

  test('a test encode that throws counts as a failure', async () => {
    const hw = new HwAccel({ setting: 'nvenc', run: async () => Promise.reject(new Error('spawn EACCES')) });
    expect(await hw.encoder()).toEqual({ method: 'software' });
    expect(hw.status().probes[0]).toEqual({ method: 'nvenc', ok: false, error: 'spawn EACCES' });
  });

  test('an admin override wins over the environment and checks again', async () => {
    const db = openDb(':memory:');
    const f = fakeRunner(['h264_nvenc', 'h264_vaapi']);
    const hw = new HwAccel({ setting: 'auto', run: f.run, deviceExists: () => true, db });
    expect(await hw.encoder()).toEqual(NVENC);
    let s = await hw.setOverride('vaapi');
    expect(s).toMatchObject({ active: 'h264_vaapi', setting: 'vaapi', source: 'admin', envSetting: 'auto' });
    s = await hw.setOverride('off');
    expect(s).toMatchObject({ active: 'libx264', setting: 'off', source: 'admin' });
    s = await hw.setOverride(null);
    expect(s).toMatchObject({ active: 'h264_nvenc', setting: 'auto', source: 'env' });
    db.close();
  });

  test('a failure during playback: software for the cool-down, then the hardware is checked again', async () => {
    let now = 1_000_000;
    const f = fakeRunner(['h264_vaapi']);
    const logs: [string, Record<string, unknown>, string][] = [];
    const hw = new HwAccel({ setting: 'vaapi', run: f.run, deviceExists: () => true, cooldownMs: 60_000, now: () => now, log: (l, o, m) => logs.push([l, o, m]) });
    expect(await hw.encoder()).toEqual(VAAPI);
    hw.markFailed(VAAPI, '[h264_vaapi @ 0x1] Failed to create encode pipeline config: 12 (requested feature not supported) in /dev/dri/renderD128');
    expect(hw.current()).toEqual({ method: 'software' });
    expect(await hw.encoder()).toEqual({ method: 'software' });
    const s = hw.status();
    expect(s).toMatchObject({ active: 'libx264', unhealthyUntil: now + 60_000 });
    expect(s.reason).toMatch(/VAAPI failed during playback \(Failed to create encode pipeline config: 12 \(requested feature not supported\) in <path>\)/);
    expect(logs.at(-1)).toEqual(['warn', { encoder: 'h264_vaapi', error: expect.stringContaining('<path>'), retryInMinutes: 1 }, 'hardware encoder failed, using the software encoder for a while']);
    hw.markFailed({ method: 'software' }, 'whatever');
    expect(hw.status().unhealthyUntil).toBe(now + 60_000);
    now += 60_001;
    expect(await hw.encoder()).toEqual(VAAPI);
    expect(f.calls).toEqual(['h264_vaapi', 'h264_vaapi']);
    expect(hw.status().unhealthyUntil).toBeNull();
  });

  // real FFmpeg, real (missing) hardware: what a CI box or a server without a GPU gets
  const hasGpu = existsSync('/dev/dri') || existsSync('/dev/nvidiactl');
  test.skipIf(hasGpu)('auto on a machine without a GPU settles on libx264 quickly', async () => {
    const hw = new HwAccel({ setting: 'auto', run: runFfmpegTest });
    const t0 = Date.now();
    expect(await hw.encoder()).toEqual({ method: 'software' });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(hw.status().probes.map((p) => p.ok)).toEqual([false, false, false]);
  });
  test('a real test encode of libx264 works through the runner (the runner reports success)', async () => {
    const args = hwTestArgs({ method: 'software' });
    expect(await runFfmpegTest(args)).toEqual({ ok: true, error: '' });
    const bad = await runFfmpegTest(hwTestArgs({ method: 'vaapi', device: '/nonexistent/renderD999' }));
    expect(bad.ok).toBe(false);
    expect(summarizeError(bad.error)).not.toContain('/nonexistent');
  });
});

describe('playback falls back to libx264', () => {
  const MSE = JSON.stringify({ hls: false, mse: true, codecs: ['avc1', 'mp4a'] });
  const NO_MSE = JSON.stringify({ hls: true, mse: false, codecs: ['avc1', 'mp4a'] });
  const ids = (profile: string, kind: string) => FORMAT_MATRIX.find((f) => f.id === profile && f.kind === kind)!.ids;
  let mock: Awaited<ReturnType<typeof createMockXtream>>;
  let built: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let base: string;
  const logs: string[] = [];

  beforeAll(async () => {
    mock = await createMockXtream({ port: 0, size: 'small', maxConnections: 2, username: 'hw-user-4410', password: 'hw-pass-9921' });
    const logStream = new Writable({ write: (c, _e, cb) => (logs.push(String(c)), cb()) });
    // the "hardware" passes its (fake) test encode, but its device does not exist, so the real FFmpeg run fails at once
    built = await makeApp(
      { url: mock.url, username: mock.username, password: mock.password },
      {
        logger: true, logStream, runEncodeTest: async () => ({ ok: true, error: '' }), deviceExists: () => true,
        config: { logLevel: 'warn', hwaccel: { setting: 'vaapi', device: '/nonexistent/renderD999' } },
      },
    );
    await built.services.sync.syncCatalog();
    cookie = await login(built.app);
    base = await built.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterEach(() => built.services.playback.sessions.closeAll());
  afterAll(async () => {
    await built.app.close();
    await mock.close();
  });

  const get = (url: string, caps?: string) => fetch(base + url, { headers: { cookie, ...(caps ? { 'x-anycast-caps': caps } : {}) } });
  const info = async (url: string, caps: string) => {
    const res = await get(url, caps);
    expect(res.status).toBe(200);
    return (await res.json()) as PlaybackInfo;
  };

  test('VOD: the hardware run fails before its first segment, the session plays on libx264, the encoder is marked failed', async () => {
    const hw = built.services.playback.hw;
    expect((await hw.check()).active).toBe('h264_vaapi');
    const id = ids('mkv_hevc_ac3', 'movie')[0]!;
    const pi = await info(`/api/play/movie/${id}`, MSE);
    expect(pi.pipeline).toBe('transcode');
    expect(pi.diagnostics?.videoEncoder).toEqual({ active: 'h264_vaapi', method: 'vaapi', label: 'VAAPI' });

    const fetchFile = async (name: string) => {
      const res = await get(pi.url.replace('index.m3u8', name));
      expect(res.status, name).toBe(200);
      return Buffer.from(await res.arrayBuffer());
    };
    const init = await fetchFile('init.mp4');
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'anycast-hw-')), 's0.mp4');
    writeFileSync(file, Buffer.concat([init, await fetchFile('seg/0.m4s')]));
    const codec = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'csv=p=0', file]).toString().trim();
    expect(codec).toBe('h264,yuv420p');

    const s = hw.status();
    expect(s).toMatchObject({ active: 'libx264', method: 'software' });
    expect(s.unhealthyUntil).toBeGreaterThan(Date.now());
    expect(s.reason).toMatch(/VAAPI failed during playback/);
    expect(s.reason).not.toContain('/nonexistent');
    const log = logs.join('');
    expect(log).toContain('hardware encoder failed, using the software encoder for a while');
    // new streams are told the software encoder while the hardware cools down
    expect((await info(`/api/play/movie/${id}`, MSE)).diagnostics?.videoEncoder?.active).toBe('libx264');
  });

  test('live: the hardware run fails, the same channel input goes to libx264 and the playlist comes', async () => {
    const hw = built.services.playback.hw;
    expect((await hw.check()).active).toBe('h264_vaapi');
    const id = ids('live_hevc_aac', 'live')[0]!;
    const pi = await info(`/api/play/live/${id}`, NO_MSE);
    expect(pi).toMatchObject({ type: 'hls', pipeline: 'transcode' });
    expect(pi.diagnostics?.videoEncoder?.method).toBe('vaapi');
    const res = await get(pi.url);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).toContain('#EXTINF');
    expect(hw.status().active).toBe('libx264');
    expect(hw.status().unhealthyUntil).not.toBeNull();
  }, 60_000);

  test('diagnostics and the admin routes show the encoder; viewers are refused', async () => {
    await built.services.users.create('hwviewer', 'viewer-password-1', false);
    const viewer = await login(built.app, { username: 'hwviewer', password: 'viewer-password-1' });
    const hw = built.services.playback.hw;
    await hw.check();
    const d = (await (await get('/api/diagnostics')).json()) as ServerDiagnostics;
    expect(d.videoEncoder).toMatchObject({ active: 'h264_vaapi', method: 'vaapi', setting: 'vaapi', source: 'env', envSetting: 'vaapi', unhealthyUntil: null });
    expect(d.videoEncoder.probes).toEqual([{ method: 'vaapi', ok: true, error: null }]);
    expect(JSON.stringify(d)).not.toContain('/nonexistent');

    const put = async (setting: unknown, who = cookie) =>
      fetch(`${base}/api/hwaccel`, { method: 'PUT', headers: { cookie: who, 'content-type': 'application/json' }, body: JSON.stringify({ setting }) });
    let r = await put('off');
    expect(r.status).toBe(200);
    expect(((await r.json()) as VideoEncoderStatus)).toMatchObject({ active: 'libx264', setting: 'off', source: 'admin' });
    expect(((await (await get('/api/hwaccel')).json()) as VideoEncoderStatus).setting).toBe('off');
    expect((await put('cuda')).status).toBe(400);
    r = await put(null);
    expect(((await r.json()) as VideoEncoderStatus)).toMatchObject({ active: 'h264_vaapi', source: 'env' });
    const check = await fetch(`${base}/api/hwaccel/check`, { method: 'POST', headers: { cookie } });
    expect(check.status).toBe(200);

    expect((await fetch(`${base}/api/hwaccel`, { headers: { cookie: viewer } })).status).toBe(403);
    expect((await put('off', viewer)).status).toBe(403);
    expect((await fetch(`${base}/api/hwaccel/check`, { method: 'POST', headers: { cookie: viewer } })).status).toBe(403);
  });
});
