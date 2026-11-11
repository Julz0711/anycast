import { describe, expect, it } from 'vitest';
import { keyboardInset } from './viewport';

describe('keyboard inset', () => {
  it('measures the part of the screen the keyboard covers', () => {
    expect(keyboardInset(844, 508, 0)).toBe(336);
    // page scrolled up inside the visual viewport while typing
    expect(keyboardInset(844, 508, 40)).toBe(296);
  });
  it('ignores browser chrome changes', () => {
    expect(keyboardInset(844, 780, 0)).toBe(0);
    expect(keyboardInset(844, 844, 0)).toBe(0);
  });
});
