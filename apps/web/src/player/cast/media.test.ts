import { describe, expect, test } from 'vitest';
import type { CastPlayResponse, PlaybackInfo } from '@anycast/shared';
import { castMediaFor, castUrl, unreachableFromTv } from './media';

const resp = (info: Partial<PlaybackInfo>, baseUrl: string | null = null): CastPlayResponse => {
  const full = { url: '/api/stream/live/1/remux/index.m3u8', type: 'hls', pipeline: 'remux', ...info } as PlaybackInfo;
  return { info: full, castPath: `/cast/TOKEN${full.url}`, baseUrl };
};

describe('cast media', () => {
  test('uses the address set for TVs, else this origin', () => {
    expect(castUrl(resp({}), 'https://anycast.example')).toBe('https://anycast.example/cast/TOKEN/api/stream/live/1/remux/index.m3u8');
    expect(castUrl(resp({}, 'http://192.168.1.20:8787'), 'https://x')).toBe('http://192.168.1.20:8787/cast/TOKEN/api/stream/live/1/remux/index.m3u8');
  });

  test('HLS from FFmpeg is fMP4, the buffer as recorded is TS, movies are MP4', () => {
    const live = castMediaFor(resp({}), { live: true, title: 'News' }, 'https://h');
    expect(live).toMatchObject({ contentType: 'application/x-mpegURL', segments: 'fmp4', live: true, startTime: 0 });
    const buf = castMediaFor(resp({ url: '/api/stream/buffer/1/2/3/index.m3u8', pipeline: 'passthrough' }), { live: true, title: 'x' }, 'https://h');
    expect(buf.segments).toBe('ts');
    const mp4 = castMediaFor(resp({ url: '/api/stream/movie/9/video.mp4', type: 'file', pipeline: 'passthrough' }), { live: false, startTime: 61.5, title: 'Film' }, 'https://h');
    expect(mp4).toMatchObject({ contentType: 'video/mp4', segments: null, startTime: 61.5, live: false });
  });

  test('artwork the TV can load without signing in', () => {
    expect(castMediaFor(resp({}), { live: true, title: 'x', image: '/api/art/live/1' }, 'https://h').image).toBeNull();
    expect(castMediaFor(resp({}), { live: true, title: 'x', image: 'https://cdn/logo.png' }, 'https://h').image).toBe('https://cdn/logo.png');
  });

  test('addresses a TV cannot reach', () => {
    expect(unreachableFromTv('http://localhost:5173')).toBe(true);
    expect(unreachableFromTv('https://server.tail1234.ts.net')).toBe(true);
    expect(unreachableFromTv('http://192.168.1.20:8787')).toBe(false);
    expect(unreachableFromTv('https://tv.example.com')).toBe(false);
  });
});
