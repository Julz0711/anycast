import { describe, expect, it } from 'vitest';
import { detectCaps } from './caps';
import { chooseEngine } from './engine';

describe('detectCaps', () => {
  it('reports MSE codecs (Chrome-like)', () => {
    const supported = ['avc1', 'mp4a', 'opus'];
    const caps = detectCaps({
      MediaSource: { isTypeSupported: (t) => supported.some((c) => t.includes(c)) },
      canPlayType: () => '',
    });
    expect(caps).toEqual({ hls: false, mse: true, codecs: ['avc1', 'mp4a', 'opus'] });
  });
  it('reports native HLS and canPlayType codecs without MSE (iPhone-like)', () => {
    const caps = detectCaps({
      canPlayType: (t) => (t === 'application/vnd.apple.mpegurl' ? 'maybe' : /avc1|hvc1|mp4a|ac-3|ec-3/.test(t) ? 'probably' : ''),
    });
    expect(caps.hls).toBe(true);
    expect(caps.mse).toBe(false);
    expect(caps.codecs).toEqual(['avc1', 'hvc1', 'mp4a', 'ac-3', 'ec-3']);
  });
  it('uses ManagedMediaSource when MediaSource is missing', () => {
    const caps = detectCaps({ ManagedMediaSource: { isTypeSupported: (t) => t.includes('hev1') }, canPlayType: () => '' });
    expect(caps).toMatchObject({ mse: true, codecs: ['hev1'] });
  });
  it('survives a throwing probe', () => {
    const caps = detectCaps({ MediaSource: { isTypeSupported: () => { throw new Error('x'); } }, canPlayType: () => '' });
    expect(caps.codecs).toEqual([]);
  });
});

describe('chooseEngine', () => {
  const chrome = { mse: true, nativeHls: false, appleWebKit: false };
  const safari = { mse: true, nativeHls: true, appleWebKit: true };
  const iphone = { mse: false, nativeHls: true, appleWebKit: true };
  it('picks per type and browser', () => {
    expect(chooseEngine('hls', chrome)).toBe('hls.js');
    expect(chooseEngine('hls', safari)).toBe('native-hls');
    expect(chooseEngine('hls', iphone)).toBe('native-hls');
    expect(chooseEngine('hls', { mse: true, nativeHls: true, appleWebKit: false })).toBe('hls.js');
    expect(chooseEngine('mpegts', chrome)).toBe('mpegts');
    expect(chooseEngine('file', chrome)).toBe('native');
  });
});
