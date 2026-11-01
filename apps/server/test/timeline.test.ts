import { expect, test } from 'vitest';
import type { ChannelRow } from '../src/catalog/store';
import { archiveSource, buildTimeline, gapReasonAt, LIVE_EDGE_MS, mergeRanges, sourceAt, type TimelineSource } from '../src/playback/timeline';

const NOW = Date.UTC(2026, 10, 1, 12);
const channel = (archive_days: number): ChannelRow => ({
  id: '7', name: 'X', raw_name: 'X', number: 1, category_id: 'l1', logo: null, country: null, language: null, archive_days, epg_channel_id: null,
});

test('archive channel: archive range then live edge, no gaps', () => {
  const t = buildTimeline(channel(3), [archiveSource], NOW);
  expect(t.ranges).toEqual([
    { start: NOW - 3 * 86400_000, end: NOW - LIVE_EDGE_MS, source: 'archive' },
    { start: NOW - LIVE_EDGE_MS, end: NOW, source: 'live' },
  ]);
  expect(t.gaps).toEqual([]);
  expect(sourceAt(t, NOW - 3600_000)?.source).toBe('archive');
  expect(sourceAt(t, NOW - 4 * 86400_000)).toBeNull();
});

test('no archive: a gap with a reason up to the live edge', () => {
  const t = buildTimeline(channel(0), [archiveSource], NOW);
  expect(t.ranges).toEqual([{ start: NOW, end: NOW, source: 'live' }]);
  expect(t.gaps).toEqual([{ start: NOW - 6 * 3600_000, end: NOW, reason: 'This channel has no archive' }]);
});

const buf = (...ranges: [number, number, string?][]): TimelineSource => ({
  kind: 'buffer',
  ranges: () => ranges.map(([start, end, endReason]) => ({ start, end, source: 'buffer' as const, ...(endReason ? { endReason } : {}) })),
});
const hhmm = (ms: number) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(ms);

test('a buffer source fills in where there is no archive; the gap before it says since when', () => {
  const t = buildTimeline(channel(0), [archiveSource, buf([NOW - 3600_000, NOW - LIVE_EDGE_MS])], NOW, { timeZone: 'UTC' });
  expect(t.ranges.map((r) => r.source)).toEqual(['buffer', 'live']);
  expect(t.gaps).toEqual([{ start: NOW - 6 * 3600_000, end: NOW - 3600_000, reason: `This channel has no archive before ${hhmm(NOW - 3600_000)}` }]);
  expect(hhmm(NOW - 3600_000)).toBe('11:00');
});

test('a recording buffer reaches the live edge: live starts where the buffer ends', () => {
  const t = buildTimeline(channel(0), [archiveSource, buf([NOW - 30_000, NOW - 2000])], NOW);
  expect(t.ranges).toEqual([
    { start: NOW - 30_000, end: NOW - 2000, source: 'buffer' },
    { start: NOW - 2000, end: NOW, source: 'live' },
  ]);
  expect(sourceAt(t, NOW - 20_000)?.source).toBe('buffer');
  expect(sourceAt(t, NOW - 1000)?.source).toBe('live');
});

test('the buffer wins over the archive where both cover; ranges stay sorted and non-overlapping', () => {
  const t = buildTimeline(channel(1), [archiveSource, buf([NOW - 3 * 3600_000, NOW - 2 * 3600_000, 'Stream dropped'], [NOW - 600_000, NOW - 1000])], NOW);
  expect(t.ranges).toEqual([
    { start: NOW - 86400_000, end: NOW - 3 * 3600_000, source: 'archive' },
    { start: NOW - 3 * 3600_000, end: NOW - 2 * 3600_000, source: 'buffer' },
    { start: NOW - 2 * 3600_000, end: NOW - 600_000, source: 'archive' },
    { start: NOW - 600_000, end: NOW - 1000, source: 'buffer' },
    { start: NOW - 1000, end: NOW, source: 'live' },
  ]);
  expect(t.gaps).toEqual([]);
  for (let i = 1; i < t.ranges.length; i++) expect(t.ranges[i]!.start).toBeGreaterThanOrEqual(t.ranges[i - 1]!.end);
});

test('a drop between two buffered runs is a gap with its reason, not stitched', () => {
  const t = buildTimeline(channel(0), [archiveSource, buf([NOW - 100_000, NOW - 60_000, 'Stream dropped'], [NOW - 50_000, NOW - 1000])], NOW);
  expect(t.ranges.map((r) => r.source)).toEqual(['buffer', 'buffer', 'live']);
  expect(t.gaps).toContainEqual({ start: NOW - 60_000, end: NOW - 50_000, reason: 'Stream dropped' });
  expect(gapReasonAt(t, NOW - 55_000)).toBe('Stream dropped');
});

test('an old buffer with nothing since: the gap after it carries the stop reason and only now is live', () => {
  const t = buildTimeline(channel(0), [archiveSource, buf([NOW - 3600_000, NOW - 3000_000, 'Not recorded: nobody was watching'])], NOW);
  expect(t.ranges[t.ranges.length - 1]).toEqual({ start: NOW, end: NOW, source: 'live' });
  expect(t.gaps[t.gaps.length - 1]).toEqual({ start: NOW - 3000_000, end: NOW, reason: 'Not recorded: nobody was watching' });
});

test('mergeRanges joins touching ranges of one source and trims overlaps', () => {
  expect(
    mergeRanges([
      { start: 0, end: 10, source: 'buffer' },
      { start: 10, end: 20, source: 'buffer' },
      { start: 15, end: 30, source: 'buffer' },
      { start: 5, end: 40, source: 'archive' },
    ]),
  ).toEqual([
    { start: 0, end: 30, source: 'buffer' },
    { start: 30, end: 40, source: 'archive' },
  ]);
});
