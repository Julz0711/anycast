import { describe, expect, test } from 'vitest';
import { dropIndex, moveItem, shiftFor, toggleId } from './reorder';

describe('moveItem', () => {
  test('moves down, up, and clamps', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 1, -5)).toEqual(['b', 'a', 'c']);
  });
  test('leaves the input alone and ignores bad indexes', () => {
    const src = ['a', 'b'];
    expect(moveItem(src, 5, 0)).toEqual(['a', 'b']);
    moveItem(src, 0, 1);
    expect(src).toEqual(['a', 'b']);
  });
});

describe('toggleId', () => {
  test('adds at the end once, removes', () => {
    expect(toggleId(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c']);
    expect(toggleId(['a', 'b'], 'a', true)).toEqual(['b', 'a']);
    expect(toggleId(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggleId(['a'], 'x', false)).toEqual(['a']);
  });
});

describe('dropIndex', () => {
  // four 50px rows: centres at 25, 75, 125, 175
  const mids = [25, 75, 125, 175];
  test('stays put until the centre passes a neighbour', () => {
    expect(dropIndex(mids, 1, 75)).toBe(1);
    expect(dropIndex(mids, 1, 74)).toBe(1);
    expect(dropIndex(mids, 1, 126)).toBe(2);
    expect(dropIndex(mids, 1, 24)).toBe(0);
  });
  test('ends of the list', () => {
    expect(dropIndex(mids, 0, 500)).toBe(3);
    expect(dropIndex(mids, 3, -500)).toBe(0);
  });
  test('dropping where it landed reproduces the move', () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(moveItem(items, 0, dropIndex(mids, 0, 130))).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('shiftFor', () => {
  test('dragging down moves the passed items up', () => {
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 0, 2))).toEqual([0, -1, -1, 0]);
  });
  test('dragging up moves the passed items down', () => {
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 3, 1))).toEqual([0, 1, 1, 0]);
  });
  test('no move, no shift', () => {
    expect([0, 1, 2].map((i) => shiftFor(i, 1, 1))).toEqual([0, 0, 0]);
  });
});
