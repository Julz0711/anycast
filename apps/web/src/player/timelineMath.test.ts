import { describe, expect, it } from 'vitest';
import type { TimelineInfo } from '@anycast/shared';
import { absolutePosition, computeWindow, fracToTime, layoutBlocks, mediaTimeFor, resolveSeek, timeToFrac } from './timelineMath';
import { fmtClock } from '../lib/time';

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.UTC(2026, 10, 1, 21, 46);

describe('time <-> position', () => {
  const w = { start: now - 3 * HOUR, end: now + HOUR };
  it('round-trips', () => {
    for (const f of [0, 0.25, 0.5, 0.999, 1]) expect(timeToFrac(fracToTime(f, w), w)).toBeCloseTo(f, 9);
    expect(timeToFrac(now, w)).toBeCloseTo(0.75);
  });
});

describe('computeWindow', () => {
  it('keeps the live edge near the right and snaps to 5 minutes', () => {
    const w = computeWindow(now, now - 10 * MIN, 3 * HOUR);
    expect(w.end - w.start).toBe(3 * HOUR);
    expect(w.end % (5 * MIN)).toBe(0);
    expect(w.end).toBeGreaterThan(now);
    expect(timeToFrac(now, w)).toBeGreaterThan(0.85);
  });
  it('slides back when the playhead is earlier than the window', () => {
    const pos = now - 10 * HOUR;
    const w = computeWindow(now, pos, 3 * HOUR);
    expect(pos).toBeGreaterThan(w.start);
    expect(pos).toBeLessThan(w.end);
  });
});

describe('resolveSeek', () => {
  const tl: Pick<TimelineInfo, 'ranges' | 'gaps'> = {
    ranges: [
      { start: now - 6 * HOUR, end: now - 5 * HOUR, source: 'archive' },
      { start: now - 4 * HOUR, end: now, source: 'archive' },
    ],
    gaps: [{ start: now - 5 * HOUR, end: now - 4 * HOUR, reason: 'Stream dropped', cause: { code: 'dropped' } }],
  };
  it('plays inside a range', () => {
    expect(resolveSeek(now - HOUR, tl, now)).toEqual({ at: now - HOUR, live: false, reason: null });
  });
  it('goes live at or after now', () => {
    expect(resolveSeek(now + HOUR, tl, now).live).toBe(true);
  });
  it('snaps out of a gap to the nearest edge and says why', () => {
    const r = resolveSeek(now - 4 * HOUR - 10 * MIN, tl, now);
    expect(r.at).toBe(now - 4 * HOUR + 30_000);
    expect(r.reason).toBe('Stream dropped');
  });
  it('snaps to the start of the archive when seeking before it', () => {
    const r = resolveSeek(now - 9 * HOUR, tl, now);
    expect(r.at).toBe(now - 6 * HOUR + 30_000);
    expect(r.reason).toMatch(/before/);
  });
  it('formats the gap time in the viewer\'s time zone, not the server text', () => {
    const at = now - 5 * HOUR;
    const r = resolveSeek(now - 4.5 * HOUR, { ...tl, gaps: [{ start: now - 5 * HOUR, end: now - 4 * HOUR, reason: 'server text 03:00', cause: { code: 'no_archive', at } }] }, now);
    expect(r.reason).toBe(`This channel has no archive before ${fmtClock(at)}`);
  });
  it('without any archive, returns live with a reason', () => {
    const r = resolveSeek(now - HOUR, { ranges: [], gaps: [] }, now);
    expect(r).toMatchObject({ live: true });
    expect(r.reason).toBeTruthy();
  });
});

describe('layoutBlocks', () => {
  it('clips programmes to the window and marks state', () => {
    const w = { start: now - 2 * HOUR, end: now + HOUR };
    const progs = [
      { channelId: 'c', title: 'A', description: null, start: now - 3 * HOUR, end: now - HOUR },
      { channelId: 'c', title: 'B', description: null, start: now - HOUR, end: now + 30 * MIN },
      { channelId: 'c', title: 'C', description: null, start: now + 30 * MIN, end: now + 2 * HOUR },
      { channelId: 'c', title: 'Z', description: null, start: now + 3 * HOUR, end: now + 4 * HOUR },
    ];
    const blocks = layoutBlocks(progs, w, now - 10 * MIN, now, [{ start: now - 5 * HOUR, end: now, source: 'archive' }]);
    expect(blocks.map((b) => b.program.title)).toEqual(['A', 'B', 'C']);
    expect(blocks[0]!.left).toBe(0);
    expect(blocks[0]!.width).toBeCloseTo(1 / 3);
    expect(blocks.map((b) => b.state)).toEqual(['past', 'now', 'future']);
    expect(blocks[0]!.playable).toBe(true);
    expect(blocks[2]!.playable).toBe(false);
  });
});

describe('stream position mapping', () => {
  it('uses startsAt when given', () => {
    expect(absolutePosition(now - HOUR, 60, 0, now)).toBe(now - HOUR + 60_000);
    expect(mediaTimeFor(now - HOUR + 30_000, now - HOUR, 0, 120, now)).toBe(30);
    expect(mediaTimeFor(now - 2 * HOUR, now - HOUR, 0, 120, now)).toBeNull();
  });
  it('maps pure live from the seekable end', () => {
    expect(absolutePosition(undefined, 90, 100, now)).toBe(now - 10_000);
    expect(mediaTimeFor(now - 10_000, undefined, 40, 100, now)).toBe(90);
    expect(mediaTimeFor(now - 2 * HOUR, undefined, 40, 100, now)).toBeNull();
  });
});
