import { describe, expect, test } from 'vitest';
import type { PlaybackInfo } from '@anycast/shared';
import { audioLine, bufferAhead, convertedByChoice, fmtBitrate, frameCounts, pictureFix, pipelineLine, RateMeter, sourceOf, streamBytes, videoLine } from './sample';

const ranges = (...r: [number, number][]) => ({ length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] }) as TimeRanges;

describe('stats sampling', () => {
  test('buffer ahead counts only the range holding the playhead', () => {
    expect(bufferAhead({ currentTime: 12, buffered: ranges([0, 20], [40, 60]) })).toBe(8);
    expect(bufferAhead({ currentTime: 30, buffered: ranges([0, 20], [40, 60]) })).toBe(0);
    expect(bufferAhead({ currentTime: 39.9, buffered: ranges([40, 60]) })).toBeCloseTo(20.1);
    expect(bufferAhead({ currentTime: 5, buffered: ranges() })).toBe(0);
  });

  test('frame counts from getVideoPlaybackQuality, or the webkit counters', () => {
    const q = { getVideoPlaybackQuality: () => ({ droppedVideoFrames: 3, totalVideoFrames: 900 }) as VideoPlaybackQuality };
    expect(frameCounts(q)).toEqual({ dropped: 3, total: 900 });
    expect(frameCounts({ webkitDroppedFrameCount: 1, webkitDecodedFrameCount: 50 } as never)).toEqual({ dropped: 1, total: 50 });
    expect(frameCounts({} as never)).toBeNull();
  });

  test('rate meter: bits per second over the window, restarts when the counter resets', () => {
    const m = new RateMeter(5000);
    m.add({ t: 0, bytes: 0 });
    expect(m.bps()).toBeNull();
    m.add({ t: 1000, bytes: 250_000 });
    expect(m.bps()).toBe(2_000_000);
    for (let i = 2; i <= 10; i++) m.add({ t: i * 1000, bytes: 250_000 + (i - 1) * 125_000 });
    expect(m.bps()).toBe(1_000_000);
    m.add({ t: 11_000, bytes: 10 });
    expect(m.bps()).toBeNull();
  });

  test('stream bytes sum only AnyCast stream responses', () => {
    expect(
      streamBytes([
        { name: 'http://x/api/stream/movie/1/remux/seg/0.m4s', encodedBodySize: 1000, transferSize: 1300 },
        { name: 'http://x/api/stream/movie/1/remux/seg/1.m4s', encodedBodySize: 0, transferSize: 500 },
        { name: 'http://x/api/art/movie/1', encodedBodySize: 9999, transferSize: 9999 },
      ]),
    ).toBe(1500);
  });

  test('labels', () => {
    expect(fmtBitrate(null)).toBe('—');
    expect(fmtBitrate(850_000)).toBe('850 kbit/s');
    expect(fmtBitrate(4_250_000)).toBe('4.3 Mbit/s');
    expect(fmtBitrate(25_000_000)).toBe('25 Mbit/s');
    expect(videoLine({ codec: 'hevc', width: 3840, height: 2160, fps: 23.98 })).toBe('HEVC · 3840×2160 · 23.98 fps');
    expect(videoLine(null)).toBe('None');
    expect(audioLine([{ codec: 'eac3', channels: 6, language: 'deu' }, { codec: 'aac', channels: 2, language: 'eng' }])).toBe('E-AC-3 · 5.1 · deu · 1 more');
    expect(audioLine([{ codec: 'aac', channels: 2, language: null }])).toBe('AAC · stereo');
  });

  test('source kind from diagnostics, or guessed from the URL for older servers', () => {
    const pi = (url: string, extra: Partial<PlaybackInfo> = {}): PlaybackInfo => ({ url, type: 'hls', pipeline: 'remux', ...extra });
    expect(sourceOf(pi('/api/stream/timeshift/1/2/3.ts'), 'live')).toBe('timeshift');
    expect(sourceOf(pi('/api/stream/buffer/1/2/3/index.m3u8'), 'live')).toBe('buffer');
    expect(sourceOf(pi('/api/stream/live/1.ts'), 'live')).toBe('live');
    expect(sourceOf(pi('/api/stream/episode/1/video.mp4'), 'episode')).toBe('episode');
    const probe = { container: 'ts', duration: null, video: null, audio: [], subtitles: [] };
    expect(sourceOf(pi('/x', { diagnostics: { source: 'buffer', reason: '', probe, assumed: false } }), 'live')).toBe('buffer');
  });

  test('picture help: convert a codec the device plays itself, or point at hardware encoding', () => {
    const video = (codec: string) => ({ codec, width: 1920, height: 1080, fps: 24, bitDepth: 10 });
    const d = (codec: string) => ({ source: 'episode' as const, reason: '', assumed: false, probe: { container: 'mp4', duration: 60, video: video(codec), audio: [], subtitles: [] } });
    expect(pictureFix({ pipeline: 'remux', diagnostics: d('hevc') })).toEqual({ kind: 'convert', codec: 'hevc', label: 'HEVC' });
    expect(pictureFix({ pipeline: 'transcode-audio', diagnostics: d('h264') })).toMatchObject({ kind: 'convert', codec: 'h264' });
    expect(pictureFix({ pipeline: 'remux', diagnostics: d('vp9') })).toBeNull();
    expect(pictureFix({ pipeline: 'transcode', diagnostics: { ...d('hevc'), videoEncoder: { active: 'h264_vaapi', method: 'vaapi', label: 'VAAPI' } } })).toEqual({ kind: 'hardware', label: 'VAAPI' });
    expect(pictureFix({ pipeline: 'transcode', diagnostics: { ...d('hevc'), videoEncoder: { active: 'libx264', method: 'software', label: 'Software' } } })).toBeNull();
    expect(videoLine(video('hevc'))).toBe('HEVC · 10-bit · 1920×1080 · 24 fps');
  });

  test('a conversion this device asked for is named, so it can be undone', () => {
    const video = (codec: string) => ({ codec, width: 1920, height: 1080, fps: 24, bitDepth: 8 });
    const d = (codec: string) => ({ source: 'episode' as const, reason: '', assumed: false, probe: { container: 'mkv', duration: 60, video: video(codec), audio: [], subtitles: [] } });
    expect(convertedByChoice({ pipeline: 'transcode', diagnostics: d('h264') }, ['h264'])).toEqual({ codec: 'h264', label: 'H.264' });
    expect(convertedByChoice({ pipeline: 'transcode', diagnostics: d('hevc') }, ['h264'])).toBeNull();
    expect(convertedByChoice({ pipeline: 'remux', diagnostics: d('h264') }, ['h264'])).toBeNull();
    expect(convertedByChoice({ pipeline: 'transcode', diagnostics: d('h264') }, [])).toBeNull();
  });

  test('the pipeline line names the encoder of a full transcode', () => {
    const probe = { container: 'mkv', duration: 60, video: null, audio: [], subtitles: [] };
    const d = { source: 'movie' as const, reason: '', probe, assumed: false };
    expect(pipelineLine({ pipeline: 'transcode', diagnostics: { ...d, videoEncoder: { active: 'h264_vaapi', method: 'vaapi', label: 'VAAPI' } } })).toBe('Full transcode (to H.264 + AAC) · VAAPI encoder');
    expect(pipelineLine({ pipeline: 'transcode', diagnostics: { ...d, videoEncoder: { active: 'libx264', method: 'software', label: 'Software' } } })).toBe('Full transcode (to H.264 + AAC) · Software encoder');
    // older servers do not say
    expect(pipelineLine({ pipeline: 'transcode', diagnostics: d })).toBe('Full transcode (to H.264 + AAC)');
    expect(pipelineLine({ pipeline: 'remux' })).toBe('Remux (no re-encoding)');
  });
});
