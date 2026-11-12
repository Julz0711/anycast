import { describe, expect, it } from 'vitest';
import { clampMiniWidth, MINI_MIN_WIDTH } from './miniSize';

describe('a dragged mini player width', () => {
  it('stays between a usable minimum and what fits the window at 16:9', () => {
    expect(clampMiniWidth(500, 1440, 900)).toBe(500);
    expect(clampMiniWidth(80, 1440, 900)).toBe(MINI_MIN_WIDTH);
    // wide window: the width is the limit
    expect(clampMiniWidth(5000, 1000, 900)).toBe(960);
    // low window: the height is
    expect(clampMiniWidth(5000, 1440, 400)).toBe(640);
    // a tiny window never goes under the minimum
    expect(clampMiniWidth(300, 200, 150)).toBe(MINI_MIN_WIDTH);
  });
});
