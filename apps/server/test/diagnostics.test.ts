import type { PlaybackInfo, ServerDiagnostics } from '@anycast/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { detectTools, parseHwEncoders, parseToolVersion, type CommandRunner } from '../src/diagnostics';
import { explainPipeline, choosePipeline } from '../src/playback/pipeline';
import { parseFrameRate, type ProbeResult } from '../src/playback/probe';
import { createMockXtream, FORMAT_MATRIX, login, makeApp } from './helpers';

const ENCODERS = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
`;
const fakeRun: CommandRunner = async (cmd, args) => {
  if (args.includes('-encoders')) return ENCODERS;
  if (cmd === 'ffmpeg') return 'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers\nbuilt with gcc 13 (Ubuntu)\nconfiguration: --prefix=/usr\n';
  return null; // ffprobe missing
};

describe('parsers', () => {
  test('tool versions are a short token from the first line only', () => {
    expect(parseToolVersion('ffprobe version n7.0.2 Copyright (c)\nconfiguration: --prefix=/opt/secret')).toBe('n7.0.2');
    expect(parseToolVersion(null)).toBeNull();
    expect(parseToolVersion('garbage')).toBeNull();
  });
  test('hardware encoders are picked out of ffmpeg -encoders', () => {
    expect(parseHwEncoders(ENCODERS)).toEqual(['h264_nvenc', 'h264_vaapi', 'hevc_nvenc']);
    expect(parseHwEncoders(null)).toEqual([]);
  });
  test('detectTools reports a missing tool as unavailable', async () => {
    expect(await detectTools(fakeRun)).toEqual({
      ffmpeg: { available: true, version: '6.1.1-3ubuntu5' },
      ffprobe: { available: false, version: null },
      hwEncoders: ['h264_nvenc', 'h264_vaapi', 'hevc_nvenc'],
    });
  });
  test('frame rates', () => {
    expect(parseFrameRate('30000/1001')).toBe(29.97);
    expect(parseFrameRate('25/1')).toBe(25);
    expect(parseFrameRate('0/0')).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
  });
  test('pipeline reasons name the codecs and the decision', () => {
    const p = (container: string, v: string | null, a: string | null): ProbeResult => ({
      container, duration: 10, video: v ? { codec: v, width: 1920, height: 1080 } : null, audio: a ? [{ codec: a, language: null, channels: 2 }] : [], subtitles: [],
    });
    const chrome = { hls: false, mse: true, codecs: ['avc1', 'mp4a'] };
    const why = (probe: ProbeResult, mode: 'vod' | 'live', assumed = false) => explainPipeline(probe, chrome, mode, choosePipeline(probe, chrome, mode), assumed);
    expect(why(p('mp4', 'h264', 'aac'), 'vod')).toMatch(/H\.264\/AAC in MP4 plays directly/);
    expect(why(p('mkv', 'h264', 'aac'), 'vod')).toMatch(/MKV container doesn't.*repackaged/);
    expect(why(p('mkv', 'hevc', 'ac3'), 'vod')).toMatch(/can't decode HEVC video.*AC-3 audio to AAC/);
    expect(why(p('mkv', 'h264', 'eac3'), 'vod')).toMatch(/E-AC-3 audio doesn't/);
    expect(why(p('ts', 'h264', 'aac'), 'live', true)).toMatch(/Media Source Extensions.*typical codecs were assumed/);
  });
});

describe('routes', () => {
  let mock: Awaited<ReturnType<typeof createMockXtream>>;
  let built: Awaited<ReturnType<typeof makeApp>>;
  let admin: string;
  let viewer: string;
  const secrets = ['diag-user-5521', 'diag-pass-8830'];

  beforeAll(async () => {
    mock = await createMockXtream({ port: 0, size: 'small', maxConnections: 3, username: secrets[0], password: secrets[1] });
    built = await makeApp({ url: mock.url, username: mock.username, password: mock.password }, { runCommand: fakeRun, config: { buffer: { enabled: true } } });
    await built.services.sync.syncCatalog();
    admin = await login(built.app);
    await built.services.users.create('viewer', 'viewer-password-1', false);
    viewer = await login(built.app, { username: 'viewer', password: 'viewer-password-1' });
  });
  afterAll(async () => {
    await built.app.close();
    await mock.close();
  });

  const noSecrets = (body: string) => {
    const host = new URL(mock.url).host;
    for (const s of [...secrets, host, mock.url, '127.0.0.1', 'localhost', built.services.config.dataDir, built.services.config.bufferDir]) expect(body).not.toContain(s);
    expect(body).not.toMatch(/https?:\/\//);
  };

  test('requires a session', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/diagnostics' });
    expect(res.statusCode).toBe(401);
  });

  test('is admin only', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/diagnostics', headers: { cookie: viewer } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  test('reports version, tools, connections and disk use without secrets', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/diagnostics', headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const d = res.json<ServerDiagnostics>();
    expect(d).toMatchObject({
      version: expect.any(String),
      ffmpeg: { available: true, version: '6.1.1-3ubuntu5' },
      ffprobe: { available: false, version: null },
      hwEncoders: ['h264_nvenc', 'h264_vaapi', 'hevc_nvenc'],
      connections: { active: 0, max: 3, byKind: {} },
      hlsSessions: 0,
      buffer: { enabled: true, bytes: 0, maxBytes: expect.any(Number), recording: 0 },
    });
    expect(d.uptimeSeconds).toBeGreaterThanOrEqual(0);
    noSecrets(res.body);
  });

  test('counts provider connections by kind', async () => {
    const lease = built.services.playback.pool.acquire('movie:1');
    const lease2 = built.services.playback.pool.acquire('ts:5:100');
    try {
      const d = (await built.app.inject({ method: 'GET', url: '/api/diagnostics', headers: { cookie: admin } })).json<ServerDiagnostics>();
      expect(d.connections).toEqual({ active: 2, max: 3, byKind: { movie: 1, timeshift: 1 } });
    } finally {
      lease.release();
      lease2.release();
    }
  });

  test('PlaybackInfo carries source, probe and reason, but no provider URL', async () => {
    const id = FORMAT_MATRIX.find((f) => f.id === 'mp4_h264_aac' && f.kind === 'movie')!.ids[0]!;
    const res = await built.app.inject({
      method: 'GET', url: `/api/play/movie/${id}`,
      headers: { cookie: admin, 'x-anycast-caps': JSON.stringify({ hls: false, mse: true, codecs: ['avc1', 'mp4a'] }) },
    });
    expect(res.statusCode, res.body).toBe(200);
    const pi = res.json<PlaybackInfo>();
    expect(pi.pipeline).toBe('passthrough');
    expect(pi.diagnostics).toMatchObject({
      source: 'movie',
      assumed: false,
      reason: expect.stringContaining('plays directly'),
      probe: { container: 'mp4', video: { codec: 'h264', width: expect.any(Number), height: expect.any(Number) }, audio: [{ codec: 'aac' }] },
    });
    noSecrets(res.body.replace(pi.url, ''));
  });
});
