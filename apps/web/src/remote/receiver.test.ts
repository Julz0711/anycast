import type { RemoteNowPlaying } from '@anycast/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { drifted, remoteAllowed, setRemoteAllowed, signature } from './receiver';
import { positionNow } from './devices';

const movie: RemoteNowPlaying = {
  kind: 'movie', id: 'm1', title: 'A', paused: false, waiting: false, position: 100, duration: 600, volume: 1, muted: false, canPrev: false, canNext: false,
};

describe('remote: what makes a device announce again', () => {
  test('play state, volume and the item change the signature; the position does not', () => {
    expect(signature({ ...movie, position: 300 })).toBe(signature(movie));
    expect(signature({ ...movie, paused: true })).not.toBe(signature(movie));
    expect(signature({ ...movie, volume: 0.5 })).not.toBe(signature(movie));
    expect(signature({ ...movie, id: 'm2' })).not.toBe(signature(movie));
    expect(signature(null)).toBe('-');
  });

  test('a seek counts as drift, playing on does not', () => {
    const sent = { p: movie, at: 1_000_000 };
    expect(drifted(sent, { ...movie, position: 110 }, 1_010_000)).toBe(false);
    expect(drifted(sent, { ...movie, position: 160 }, 1_010_000)).toBe(true);
    // paused: the position should stand still
    expect(drifted({ p: { ...movie, paused: true }, at: 1_000_000 }, { ...movie, position: 100 }, 1_010_000)).toBe(false);
    // live positions are epoch ms
    const live = { ...movie, kind: 'live' as const, position: 5_000_000, duration: 0 };
    expect(drifted({ p: live, at: 1_000_000 }, { ...live, position: 5_010_000 }, 1_010_000)).toBe(false);
    expect(drifted({ p: live, at: 1_000_000 }, { ...live, position: 4_990_000 }, 1_010_000)).toBe(true);
  });
});

describe('remote: the phone moves the position on between updates', () => {
  test('playing moves, paused and waiting stand still, the end stops it', () => {
    expect(positionNow({ playing: movie, seenAt: 1_000 }, 6_000)).toBe(105);
    expect(positionNow({ playing: { ...movie, paused: true }, seenAt: 1_000 }, 6_000)).toBe(100);
    expect(positionNow({ playing: { ...movie, waiting: true }, seenAt: 1_000 }, 6_000)).toBe(100);
    expect(positionNow({ playing: movie, seenAt: 0 }, 10_000_000)).toBe(600);
    expect(positionNow({ playing: { ...movie, kind: 'live', position: 50_000, duration: 0 }, seenAt: 1_000 }, 3_000)).toBe(52_000);
  });
});

describe('remote: who may be steered', () => {
  beforeEach(() => localStorage.clear());
  test('computers and TVs by default, phones only when turned on', () => {
    expect(remoteAllowed('large')).toBe(true);
    expect(remoteAllowed('tv')).toBe(true);
    expect(remoteAllowed('phone')).toBe(false);
    setRemoteAllowed(true);
    expect(remoteAllowed('phone')).toBe(true);
    setRemoteAllowed(false);
    expect(remoteAllowed('tv')).toBe(false);
  });
});
