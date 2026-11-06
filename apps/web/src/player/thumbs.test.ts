import { describe, expect, test } from 'vitest';
import type { ThumbIndex } from '@anycast/shared';
import { tileAt } from './thumbs';

const tile = (start: number) => ({ start, url: `/api/thumbs/movie/1/sheet/${Math.floor(start / 1000)}.jpg?v=3`, x: ((start / 10) % 10) * 160, y: Math.floor((start / 10) % 100 / 10) * 90, w: 160, h: 90 });
// played 0:00-0:30 and 2:10-2:20, and 16:40 (the first tile of the second sheet)
const index: ThumbIndex = { interval: 10, width: 160, height: 90, tiles: [0, 10, 20, 130, 140, 1000].map(tile) };

describe('tileAt', () => {
  test('finds the tile whose interval covers the time', () => {
    expect(tileAt(index, 0)).toMatchObject({ start: 0, x: 0, y: 0 });
    expect(tileAt(index, 9.99)).toMatchObject({ start: 0 });
    expect(tileAt(index, 10)).toMatchObject({ start: 10, x: 160 });
    expect(tileAt(index, 29.5)).toMatchObject({ start: 20, x: 320 });
    expect(tileAt(index, 135)).toMatchObject({ start: 130, x: 480, y: 90 });
    expect(tileAt(index, 1005)).toMatchObject({ start: 1000, x: 0, y: 0, url: '/api/thumbs/movie/1/sheet/1.jpg?v=3' });
  });

  test('times without a tile (not played yet, past the end) give null', () => {
    expect(tileAt(index, 30)).toBeNull();
    expect(tileAt(index, 75)).toBeNull();
    expect(tileAt(index, 129.9)).toBeNull();
    expect(tileAt(index, 150)).toBeNull();
    expect(tileAt(index, 5000)).toBeNull();
  });

  test('no index, an empty one, or a bad time give null', () => {
    expect(tileAt(null, 10)).toBeNull();
    expect(tileAt({ interval: 10, width: 160, height: 0, tiles: [] }, 10)).toBeNull();
    expect(tileAt(index, -1)).toBeNull();
    expect(tileAt(index, Number.NaN)).toBeNull();
  });
});
