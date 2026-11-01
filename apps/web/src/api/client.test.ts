import { describe, expect, it } from 'vitest';
import { buildPath } from './client';

describe('buildPath', () => {
  it('fills params and query, skipping empty values', () => {
    expect(buildPath('GET /api/play/live/:id/at', { id: 'a b' }, { at: 123 })).toBe('/api/play/live/a%20b/at?at=123');
    expect(buildPath('GET /api/live', undefined, { categoryId: undefined, offset: 0, limit: 50 })).toBe('/api/live?offset=0&limit=50');
  });
  it('throws on a missing param', () => {
    expect(() => buildPath('GET /api/series/:id')).toThrow(/id/);
  });
});
