import { describe, expect, it } from 'vitest';
import { detectFormFactor, isTvUserAgent } from './device';

describe('form factor', () => {
  it('detects TV user agents', () => {
    expect(isTvUserAgent('Mozilla/5.0 (Linux; Android 12; BRAVIA 4K VH2) AppleWebKit/537.36')).toBe(true);
    expect(isTvUserAgent('Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36')).toBe(true);
    expect(isTvUserAgent('Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36')).toBe(true);
    expect(isTvUserAgent('Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233)')).toBe(true);
    expect(isTvUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(false);
  });
  it('honours ?tv=1, width and the override', () => {
    const base = { ua: 'Mozilla/5.0 (Macintosh)', search: '', width: 1440, override: 'auto' as const };
    expect(detectFormFactor(base)).toBe('large');
    expect(detectFormFactor({ ...base, width: 390 })).toBe('phone');
    expect(detectFormFactor({ ...base, search: '?tv=1' })).toBe('tv');
    expect(detectFormFactor({ ...base, search: '?tv=1', override: 'desktop' })).toBe('large');
    expect(detectFormFactor({ ...base, override: 'phone' })).toBe('phone');
  });
  it('keeps the phone layout on a phone turned sideways, not on tablets or desktops', () => {
    const base = { ua: 'Mozilla/5.0 (iPhone)', search: '', override: 'auto' as const };
    expect(detectFormFactor({ ...base, width: 844, screenShort: 390, touch: true })).toBe('phone');
    expect(detectFormFactor({ ...base, width: 932, screenShort: 430, touch: true })).toBe('phone');
    // iPad mini in landscape, a laptop window of the same size, an iPad in portrait
    expect(detectFormFactor({ ...base, width: 1133, screenShort: 744, touch: true })).toBe('large');
    expect(detectFormFactor({ ...base, width: 844, screenShort: 390, touch: false })).toBe('large');
    expect(detectFormFactor({ ...base, width: 820, screenShort: 820, touch: true })).toBe('large');
    expect(detectFormFactor({ ...base, width: 844, screenShort: 390, touch: true, override: 'desktop' })).toBe('large');
  });
});
