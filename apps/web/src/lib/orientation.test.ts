import { describe, expect, it } from 'vitest';
import { sidewaysFrom } from './orientation';

describe('sideways phone', () => {
  it('goes by how the screen is turned, not by the window', () => {
    // a keyboard can leave the window wider than tall while the phone is still upright
    expect(sidewaysFrom({ orientationType: 'portrait-primary', width: 360, height: 300 })).toBe(false);
    expect(sidewaysFrom({ orientationType: 'landscape-secondary', width: 844, height: 390 })).toBe(true);
  });

  it('falls back to the older iOS angle, then to the window', () => {
    expect(sidewaysFrom({ windowOrientation: -90, width: 390, height: 844 })).toBe(true);
    expect(sidewaysFrom({ windowOrientation: 0, width: 844, height: 390 })).toBe(false);
    expect(sidewaysFrom({ width: 844, height: 390 })).toBe(true);
    expect(sidewaysFrom({ width: 390, height: 844 })).toBe(false);
  });
});
