import { describe, expect, it } from 'vitest';
import { detectCaps, preferNativeHls, withoutConverted } from './caps';
import { chooseEngine } from './engine';

describe('detectCaps', () => {
  it('reports MSE codecs (Chrome-like)', () => {
    const supported = ['avc1', 'mp4a', 'opus'];
    const caps = detectCaps({
      MediaSource: { isTypeSupported: (t) => supported.some((c) => t.includes(c)) },
      canPlayType: () => '',
    });
    expect(caps).toEqual({ hls: false, mse: true, codecs: ['avc1', 'avc1-10', 'mp4a', 'opus'] });
  });
  it('reports native HLS and canPlayType codecs without MSE (iPhone-like)', () => {
    const caps = detectCaps({
      canPlayType: (t) => (t === 'application/vnd.apple.mpegurl' ? 'maybe' : /avc1|hvc1|mp4a|ac-3|ec-3/.test(t) ? 'probably' : ''),
    });
    expect(caps.hls).toBe(true);
    expect(caps.mse).toBe(false);
    expect(caps.codecs).toEqual(['avc1', 'hvc1', 'hvc1-10', 'avc1-10', 'mp4a', 'ac-3', 'ec-3']);
  });
  it('uses ManagedMediaSource when MediaSource is missing', () => {
    const caps = detectCaps({ ManagedMediaSource: { isTypeSupported: (t) => t.includes('hev1') }, canPlayType: () => '' });
    expect(caps).toMatchObject({ mse: true, codecs: ['hev1', 'hvc1-10'] });
  });
  it('reports 10-bit only when the device says so for the 10-bit profile', () => {
    const caps = detectCaps({ MediaSource: { isTypeSupported: (t) => /hvc1\.1\.|avc1\.64|mp4a/.test(t) }, canPlayType: () => '' });
    expect(caps.codecs).toEqual(['avc1', 'hvc1', 'mp4a']);
  });
  it('never claims HEVC on Firefox and its forks (washed-out, speckled picture)', () => {
    const caps = detectCaps({ MediaSource: { isTypeSupported: () => true }, canPlayType: () => '', gecko: true });
    expect(caps.codecs).not.toContain('hvc1');
    expect(caps.codecs).not.toContain('hev1');
    expect(caps.codecs).not.toContain('hvc1-10');
    expect(caps.codecs).toContain('avc1');
  });
  it('leaves out codecs this device converts', () => {
    const caps = { hls: false, mse: true, codecs: ['avc1', 'hvc1', 'hev1', 'hvc1-10', 'mp4a'] };
    expect(withoutConverted(caps, ['hevc']).codecs).toEqual(['avc1', 'mp4a']);
    expect(withoutConverted(caps, [])).toBe(caps);
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

describe('preferNativeHls', () => {
  const caps = { hls: true, mse: true, codecs: ['avc1', 'mp4a'] };
  it('Safari with AirPlay plays HLS itself, so AirPlay can take the video', () => {
    expect(preferNativeHls(caps, { appleWebKit: true, airPlay: true })).toEqual({ ...caps, mse: false });
  });
  it('leaves other browsers alone', () => {
    expect(preferNativeHls(caps, { appleWebKit: false, airPlay: false })).toBe(caps);
    expect(preferNativeHls(caps, { appleWebKit: true, airPlay: false })).toBe(caps);
    expect(preferNativeHls({ ...caps, hls: false }, { appleWebKit: true, airPlay: true }).mse).toBe(true);
  });
});
