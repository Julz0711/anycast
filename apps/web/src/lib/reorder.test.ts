import { describe, expect, test } from 'vitest';
import { moveItem, toggleId } from './reorder';

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
