/**
 * Live channel timeline: which past moments can be played and from where.
 * Sources (provider archive, the local rolling buffer) each report playable ranges; the buffer
 * wins where both cover a moment (local, faster, saves a provider connection). Whatever no source
 * covers inside the window becomes a gap with a human reason.
 */
import { describeGap, type GapCause, type GapCode, type TimelineInfo, type TimelineRange } from '@anycast/shared';
import type { ChannelRow } from '../catalog/store';

/** The provider archive lags the live stream by about this much. */
export const LIVE_EDGE_MS = 2 * 60_000;
const NO_ARCHIVE_WINDOW_MS = 6 * 3600_000;
const AHEAD_MS = 6 * 3600_000;

/** A source range; `endReason` explains why coverage stops at `end` (shown if nothing else covers what follows). */
export interface SourceRange extends TimelineRange {
  endReason?: GapCode;
}

export interface TimelineSource {
  readonly kind: 'archive' | 'buffer';
  /** Playable ranges in the past (end <= now), sorted ascending. */
  ranges(channel: ChannelRow, now: number): SourceRange[];
}

/** Provider catch-up: [now - archiveDays, now - 2 min] for channels with tv_archive. */
export const archiveSource: TimelineSource = {
  kind: 'archive',
  ranges(channel, now) {
    if (channel.archive_days <= 0) return [];
    return [{ start: now - channel.archive_days * 86400_000, end: now - LIVE_EDGE_MS, source: 'archive' }];
  },
};

/** Removes the parts of `r` already covered by `taken` (sorted, non-overlapping). */
function subtract(r: SourceRange, taken: SourceRange[]): SourceRange[] {
  const out: SourceRange[] = [];
  let start = r.start;
  for (const t of taken) {
    if (t.end <= start || t.start >= r.end) continue;
    if (t.start > start) out.push({ ...r, start, end: t.start, endReason: undefined });
    start = Math.max(start, t.end);
    if (start >= r.end) return out;
  }
  if (start < r.end) out.push({ ...r, start });
  return out;
}

/** Sorted, non-overlapping ranges; buffer ranges take priority over archive ranges. */
export function mergeRanges(ranges: SourceRange[]): SourceRange[] {
  const rank = (r: SourceRange) => (r.source === 'buffer' ? 0 : 1);
  const byPriority = [...ranges].filter((r) => r.end > r.start).sort((a, b) => rank(a) - rank(b) || a.start - b.start);
  let taken: SourceRange[] = [];
  for (const r of byPriority) {
    const pieces = subtract(r, taken);
    taken = [...taken, ...pieces].sort((a, b) => a.start - b.start);
  }
  // join touching ranges of the same source
  const out: SourceRange[] = [];
  for (const r of taken) {
    const prev = out[out.length - 1];
    if (prev && prev.source === r.source && prev.end >= r.start) {
      prev.end = Math.max(prev.end, r.end);
      prev.endReason = r.endReason;
    } else out.push({ ...r });
  }
  return out;
}

const clockIn = (timeZone?: string) => (ms: number) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) }).format(ms);

export interface TimelineOptions {
  /** time zone for clock times in the gap `reason` text (default: the server's); `cause` stays structured */
  timeZone?: string;
}

type Built = Omit<TimelineInfo, 'programs'> & { window: { start: number; end: number } };

/** Window start, playable ranges (past + live edge) and gaps. Programs are added by the caller. */
export function buildTimeline(channel: ChannelRow, sources: TimelineSource[], now: number, opts: TimelineOptions = {}): Built {
  const past = mergeRanges(
    sources.flatMap((s) => s.ranges(channel, now)).map((r) => ({ ...r, end: Math.min(r.end, now) })),
  );
  const last = past[past.length - 1];
  // live starts where the past coverage ends when that coverage is still following the stream
  // (archive: now - 2 min; a recording buffer: its newest segment); otherwise only "now" is live
  const liveStart = last && last.end >= now - LIVE_EDGE_MS && !last.endReason ? last.end : now;
  const hasArchive = channel.archive_days > 0 && past.some((r) => r.source === 'archive');
  const windowStart = hasArchive ? past[0]!.start : Math.min(past[0]?.start ?? Infinity, now - NO_ARCHIVE_WINDOW_MS);
  const firstBuffer = past.find((r) => r.source === 'buffer');

  const ranges: SourceRange[] = [...past, { start: liveStart, end: now, source: 'live' }];
  const gaps: TimelineInfo['gaps'] = [];
  let cursor = windowStart;
  let prev: SourceRange | null = null;
  for (const r of ranges) {
    if (r.start > cursor) {
      let cause: GapCause;
      if (prev) cause = { code: prev.endReason ?? 'not_recorded' };
      else if (firstBuffer && !hasArchive) cause = { code: 'no_archive', at: firstBuffer.start };
      else cause = { code: hasArchive ? 'not_recorded' : 'no_archive' };
      gaps.push({ start: cursor, end: r.start, reason: describeGap(cause, clockIn(opts.timeZone)), cause });
    }
    cursor = Math.max(cursor, r.end);
    prev = r;
  }
  return {
    channelId: channel.id,
    now,
    ranges: ranges.map(({ start, end, source }) => ({ start, end, source })),
    gaps,
    window: { start: windowStart, end: now + AHEAD_MS },
  };
}

/** Which source covers `at`; null when nothing does. */
export function sourceAt(timeline: Pick<TimelineInfo, 'ranges'>, at: number): TimelineRange | null {
  return timeline.ranges.find((r) => at >= r.start && at <= r.end) ?? null;
}

/** Why `at` cannot be played (the gap that contains it). */
export function gapAt(timeline: Pick<TimelineInfo, 'gaps'>, at: number): { reason: string; cause: GapCause } {
  const g = timeline.gaps.find((x) => at >= x.start && at < x.end);
  return g ? { reason: g.reason, cause: g.cause } : { reason: describeGap({ code: 'no_archive' }, clockIn()), cause: { code: 'no_archive' } };
}
