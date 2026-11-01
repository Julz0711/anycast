import { describe, expect, test } from 'vitest';
import { DEFAULT_CAPS, parseCaps } from '../src/playback/caps';
import { buildHlsArgs, completedSegments } from '../src/playback/ffmpeg';
import { choosePipeline } from '../src/playback/pipeline';
import { parseFfprobe, type ProbeResult } from '../src/playback/probe';

const probe = (container: string, video: string | null, audio: string | null): ProbeResult => ({
  container, duration: 100,
  video: video ? { codec: video, width: 1920, height: 1080 } : null,
  audio: audio ? [{ codec: audio, language: null, channels: 2 }] : [],
  subtitles: [],
});
const chrome = { hls: false, mse: true, codecs: ['avc1', 'mp4a', 'opus', 'vp09'] };
const safari = { hls: true, mse: true, codecs: ['avc1', 'hvc1', 'mp4a', 'ac-3', 'ec-3'] };
const noMse = { hls: true, mse: false, codecs: ['avc1', 'mp4a'] };

describe('choosePipeline', () => {
  test.each([
    ['mp4 h264/aac vod -> file', probe('mp4', 'h264', 'aac'), chrome, 'vod', 'passthrough', 'file'],
    ['mkv h264/aac vod -> remux', probe('mkv', 'h264', 'aac'), chrome, 'vod', 'remux', 'hls'],
    ['mkv hevc/ac3 on chrome -> transcode', probe('mkv', 'hevc', 'ac3'), chrome, 'vod', 'transcode', 'hls'],
    ['mkv hevc/ac3 on safari -> remux', probe('mkv', 'hevc', 'ac3'), safari, 'vod', 'remux', 'hls'],
    ['mkv h264/dts -> transcode-audio', probe('mkv', 'h264', 'dts'), safari, 'vod', 'transcode-audio', 'hls'],
    ['mkv h264/eac3 on chrome -> transcode-audio', probe('mkv', 'h264', 'eac3'), chrome, 'vod', 'transcode-audio', 'hls'],
    ['mp4 hevc/aac on safari -> remux (not file)', probe('mp4', 'hevc', 'aac'), safari, 'vod', 'remux', 'hls'],
    ['live ts h264/aac with mse -> mpegts', probe('ts', 'h264', 'aac'), chrome, 'live', 'passthrough', 'mpegts'],
    ['live ts h264/aac without mse -> remux', probe('ts', 'h264', 'aac'), noMse, 'live', 'remux', 'hls'],
    ['live ts h264/ac3 on chrome -> transcode-audio', probe('ts', 'h264', 'ac3'), chrome, 'live', 'transcode-audio', 'hls'],
    ['live ts hevc on chrome -> transcode', probe('ts', 'hevc', 'aac'), chrome, 'live', 'transcode', 'hls'],
    ['audio-only mp4 aac -> remux', probe('mp4', null, 'aac'), chrome, 'vod', 'remux', 'hls'],
  ] as const)('%s', (_n, p, caps, mode, pipeline, type) => {
    expect(choosePipeline(p, caps, mode)).toEqual({ pipeline, type });
  });
});

describe('parseCaps', () => {
  test('header JSON, codec strings normalized', () => {
    expect(parseCaps('{"hls":true,"mse":false,"codecs":["avc1.640028","HVC1","mp4a.40.2"]}')).toEqual({ hls: true, mse: false, codecs: ['avc1', 'hvc1', 'mp4a'] });
  });
  test('garbage falls back to defaults', () => {
    expect(parseCaps('nope')).toEqual(DEFAULT_CAPS);
    expect(parseCaps(undefined)).toEqual(DEFAULT_CAPS);
  });
});

test('parseFfprobe normalizes containers and skips cover art', () => {
  const r = parseFfprobe({
    format: { format_name: 'matroska,webm', duration: '125.5' },
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160 },
      { codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'deu' } },
      { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
    ],
  });
  expect(r).toEqual({
    container: 'mkv', duration: 125.5, video: { codec: 'hevc', width: 3840, height: 2160 },
    audio: [{ codec: 'eac3', language: 'deu', channels: 6 }], subtitles: [{ codec: 'subrip', language: 'eng' }],
  });
});

test('hls args: vod seek keeps timestamps, transcode forces keyframes from the seek point', () => {
  const args = buildHlsArgs({ input: 'http://x/movie.mkv', pipeline: 'transcode', dir: '/tmp/s', run: 3, segmentSeconds: 6, mode: 'vod', seek: 60, startNumber: 10 });
  expect(args.join(' ')).toContain('-ss 60.000');
  expect(args).toContain('-copyts');
  expect(args.join(' ')).toContain('expr:gte(t,60.000+n_forced*6)');
  expect(args.join(' ')).toContain('-start_number 10');
  expect(args.at(-1)).toBe('/tmp/s/r3.m3u8');
  const live = buildHlsArgs({ input: 'pipe:0', pipeline: 'remux', dir: '/d', run: 0, segmentSeconds: 4, mode: 'live' });
  expect(live.join(' ')).toContain('-f mpegts -i pipe:0');
  expect(live.join(' ')).toContain('-c:v copy');
  expect(live.join(' ')).toContain('-c:a copy');
  expect(live).not.toContain('-copyts');
  expect(live).not.toContain('aac_adtstoasc');
});

test('hls args: remuxed AAC gets ADTS -> ASC so it fits fMP4; other copied audio does not', () => {
  const base = { input: 'pipe:0', pipeline: 'remux', dir: '/d', run: 0, segmentSeconds: 4, mode: 'live' } as const;
  expect(buildHlsArgs({ ...base, audioCodec: 'aac' }).join(' ')).toContain('-c:a copy -bsf:a aac_adtstoasc');
  expect(buildHlsArgs({ ...base, audioCodec: 'ac3' })).not.toContain('aac_adtstoasc');
  expect(buildHlsArgs({ ...base, pipeline: 'transcode-audio', audioCodec: 'aac' })).not.toContain('aac_adtstoasc');
});

test('completedSegments reads only the given run', () => {
  expect(completedSegments('#EXTM3U\n#EXTINF:6,\nr2_4.m4s\n#EXTINF:6,\nr2_5.m4s\nr1_9.m4s\n', 2)).toEqual([4, 5]);
});
