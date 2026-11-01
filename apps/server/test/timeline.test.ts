import { expect, test } from 'vitest';
import type { ChannelRow } from '../src/catalog/store';
import { archiveSource, buildTimeline, LIVE_EDGE_MS, sourceAt, type TimelineSource } from '../src/playback/timeline';

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

test('a buffer source fills in where there is no archive', () => {
  const buffer: TimelineSource = { kind: 'buffer', ranges: () => [{ start: NOW - 3600_000, end: NOW - LIVE_EDGE_MS, source: 'buffer' }] };
  const t = buildTimeline(channel(0), [archiveSource, buffer], NOW);
  expect(t.ranges.map((r) => r.source)).toEqual(['buffer', 'live']);
  expect(t.gaps).toEqual([]);
});
