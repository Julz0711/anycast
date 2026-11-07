import { describe, expect, test } from 'vitest';
import { initials } from './misc';

describe('initials', () => {
  test('skip quality words', () => {
    expect(initials('ABC HD')).toBe('ABC');
    expect(initials('BBC One FHD')).toBe('BO');
    expect(initials('Arena Sport 1')).toBe('AS1');
    expect(initials('News 24')).toBe('N24');
    expect(initials('HD')).toBe('HD');
    expect(initials('')).toBe('?');
  });
});
