/**
 * Live channel timeline: which past moments can be played and from where.
 * Sources (provider archive today, a local rolling buffer later) each report playable ranges;
 * whatever they do not cover inside the window becomes a gap with a reason.
 */
import type { TimelineInfo, TimelineRange } from '@anycast/shared';
import type { ChannelRow } from '../catalog/store';

export const LIVE_EDGE_MS = 2 * 60_000;
const NO_ARCHIVE_WINDOW_MS = 6 * 3600_000;
const AHEAD_MS = 6 * 3600_000;

export interface TimelineSource {
  readonly kind: 'archive' | 'buffer';
  /** Playable ranges in the past (end <= now - LIVE_EDGE_MS), sorted ascending. */
  ranges(channel: ChannelRow, now: number): TimelineRange[];
}

/** Provider catch-up: [now - archiveDays, now - 2 min] for channels with tv_archive. */
export const archiveSource: TimelineSource = {
  kind: 'archive',
  ranges(channel, now) {
    if (channel.archive_days <= 0) return [];
    return [{ start: now - channel.archive_days * 86400_000, end: now - LIVE_EDGE_MS, source: 'archive' }];
  },
};

function mergeRanges(ranges: TimelineRange[]): TimelineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: TimelineRange[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    // earlier sources win on overlap (archive before buffer)
    if (prev && r.start < prev.end) {
      if (r.end > prev.end) out.push({ ...r, start: prev.end });
    } else out.push({ ...r });
  }
  return out;
}

export function noArchiveReason(sources: TimelineSource[]): string {
  return sources.some((s) => s.kind === 'buffer') ? 'Not recorded yet' : 'This channel has no archive';
}

/** Window start, playable ranges (past + live edge) and gaps. Programs are added by the caller. */
export function buildTimeline(channel: ChannelRow, sources: TimelineSource[], now: number): Omit<TimelineInfo, 'programs'> & { window: { start: number; end: number } } {
  const past = mergeRanges(sources.flatMap((s) => s.ranges(channel, now)).filter((r) => r.end > r.start));
  const windowStart = past[0]?.start ?? now - NO_ARCHIVE_WINDOW_MS;
  const liveStart = past.length ? now - LIVE_EDGE_MS : now;
  const ranges: TimelineRange[] = [...past, { start: liveStart, end: now, source: 'live' }];
  const gaps: TimelineInfo['gaps'] = [];
  let cursor = windowStart;
  for (const r of ranges) {
    if (r.start > cursor) gaps.push({ start: cursor, end: r.start, reason: noArchiveReason(sources) });
    cursor = Math.max(cursor, r.end);
  }
  return { channelId: channel.id, now, ranges, gaps, window: { start: windowStart, end: now + AHEAD_MS } };
}

/** Which source covers `at`; 'live' when at the live edge or in the future. */
export function sourceAt(timeline: Pick<TimelineInfo, 'ranges'>, at: number): TimelineRange | null {
  return timeline.ranges.find((r) => at >= r.start && at <= r.end) ?? null;
}
