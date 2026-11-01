import { describe, expect, it } from 'vitest';
import { pickNearest, type Rect } from './spatial';

const r = (left: number, top: number, w = 100, h = 50): Rect => ({ left, top, right: left + w, bottom: top + h });

describe('pickNearest', () => {
  // A 3x3 grid of 100x50 tiles with 20px gaps
  const grid = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => ({ rect: r(col * 120, row * 70), item: `${row}${col}` })));
  const from = r(120, 70); // centre "11"
  const others = grid.filter((g) => g.item !== '11');

  it('moves in all four directions to the adjacent tile', () => {
    expect(pickNearest(from, others, 'right')).toBe('12');
    expect(pickNearest(from, others, 'left')).toBe('10');
    expect(pickNearest(from, others, 'up')).toBe('01');
    expect(pickNearest(from, others, 'down')).toBe('21');
  });
  it('returns null at an edge', () => {
    const corner = r(240, 140);
    expect(pickNearest(corner, grid.filter((g) => g.item !== '22'), 'right')).toBeNull();
    expect(pickNearest(corner, grid.filter((g) => g.item !== '22'), 'down')).toBeNull();
  });
  it('prefers an aligned element over a closer diagonal one', () => {
    const cands = [
      { rect: r(130, 200), item: 'aligned-far' },
      { rect: r(260, 130), item: 'diagonal-near' },
    ];
    expect(pickNearest(r(120, 70), cands, 'down')).toBe('aligned-far');
  });
  it('handles wide rows (guide programmes) by overlap', () => {
    const cands = [
      { rect: r(0, 60, 400, 40), item: 'long-programme' },
      { rect: r(420, 60, 100, 40), item: 'next-programme' },
    ];
    expect(pickNearest(r(300, 0, 80, 40), cands, 'down')).toBe('long-programme');
  });
});
