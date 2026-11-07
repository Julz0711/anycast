import { describe, expect, it } from 'vitest';
import { nearestCorner, parsePlayPath, sessionPath } from './PlayerHost';

describe('parsePlayPath', () => {
  it('reads the player routes with their query', () => {
    expect(parsePlayPath('/play/live/abc')).toEqual({ kind: 'live', id: 'abc', search: '' });
    expect(parsePlayPath('/play/episode/9?series=4')).toEqual({ kind: 'episode', id: '9', search: '?series=4' });
    expect(parsePlayPath('/play/movie/a%20b/')).toEqual({ kind: 'movie', id: 'a b', search: '' });
  });
  it('ignores everything else', () => {
    for (const p of ['/live', '/play/radio/1', '/play/live', '/play/live/1/2', '/movies/1']) expect(parsePlayPath(p)).toBeNull();
  });
  it('round-trips', () => {
    const s = { kind: 'live' as const, id: 'x/y', search: '?at=5' };
    expect(parsePlayPath(sessionPath(s))).toEqual(s);
  });
});

describe('nearestCorner', () => {
  it('docks to the quarter the centre is in', () => {
    expect(nearestCorner(10, 10, 400, 800)).toBe('tl');
    expect(nearestCorner(390, 10, 400, 800)).toBe('tr');
    expect(nearestCorner(10, 790, 400, 800)).toBe('bl');
    expect(nearestCorner(300, 500, 400, 800)).toBe('br');
  });
});
