/** Pure maths for the live timeline ribbon: time <-> position, windows, gaps, program blocks. */
import type { EpgProgram, TimelineInfo, TimelineRange } from '@anycast/shared';

export interface Win {
  start: number;
  end: number;
}

const MIN = 60_000;

export const timeToFrac = (t: number, w: Win) => (w.end === w.start ? 0 : (t - w.start) / (w.end - w.start));
export const fracToTime = (f: number, w: Win) => w.start + f * (w.end - w.start);
export const clampFrac = (f: number) => Math.min(1, Math.max(0, f));

/**
 * Window shown on the ribbon. It ends a little after now (so the live edge sits near the right),
 * spans `span` ms, snaps to 5 minutes to stay steady, and slides back when the playhead is earlier.
 */
export function computeWindow(now: number, position: number, span: number): Win {
  const snap = 5 * MIN;
  let end = Math.ceil((now + span * 0.08) / snap) * snap;
  let start = end - span;
  if (position < start + span * 0.1) {
    start = Math.floor((position - span * 0.35) / snap) * snap;
    end = start + span;
  }
  return { start, end };
}

export function earliestPlayable(ranges: TimelineRange[]): number | null {
  return ranges.length ? ranges[0]!.start : null;
}

export function rangeAt(t: number, ranges: TimelineRange[]): TimelineRange | null {
  return ranges.find((r) => t >= r.start && t <= r.end) ?? null;
}

export function gapAt(t: number, gaps: TimelineInfo['gaps']) {
  return gaps.find((g) => t >= g.start && t < g.end) ?? null;
}

/**
 * Resolve where a seek to `t` can actually go. Inside a playable range: t itself.
 * In a gap or before everything: the nearest playable edge, with the reason so the UI can say why.
 * After now: live.
 */
/** Snap this far inside a range edge, so a range that moves (rolling buffer) still contains the target. */
const EDGE_MARGIN = 30_000;

export function resolveSeek(
  t: number,
  info: Pick<TimelineInfo, 'ranges' | 'gaps'>,
  now: number,
): { at: number; live: boolean; reason: string | null } {
  if (t >= now - 5_000) return { at: now, live: true, reason: null };
  if (rangeAt(t, info.ranges)) return { at: t, live: false, reason: null };
  const gap = gapAt(t, info.gaps);
  let reason = (gap?.reason ?? 'Not available at that time').replace(/\.\s*$/, '');
  // nearest playable edge, nudged inside the range
  let best: readonly [number, number] | null = null;
  for (const r of info.ranges) {
    const m = Math.min(EDGE_MARGIN, (r.end - r.start) / 2);
    for (const [edge, inside] of [[r.start, r.start + m], [r.end, r.end - Math.min(5_000, m)]] as const) {
      if (best === null || Math.abs(edge - t) < Math.abs(best[0] - t)) best = [edge, inside];
    }
  }
  if (best === null) return { at: now, live: true, reason: info.ranges.length ? reason : 'This channel has no archive' };
  if (best[0] >= now - 5_000) return { at: now, live: true, reason };
  if (!gap && info.ranges.length && t < info.ranges[0]!.start) reason = 'Nothing recorded before this point';
  return { at: best[1], live: false, reason };
}

export type BlockState = 'past' | 'now' | 'future';
export interface Block {
  program: EpgProgram;
  left: number;
  width: number;
  state: BlockState;
  playable: boolean;
}

/** Program blocks clipped to the window, as fractions (0..1). `playable` = its start can be played. */
export function layoutBlocks(programs: EpgProgram[], w: Win, position: number, now: number, ranges: TimelineRange[]): Block[] {
  const out: Block[] = [];
  for (const p of programs) {
    if (p.end <= w.start || p.start >= w.end) continue;
    const s = Math.max(p.start, w.start);
    const e = Math.min(p.end, w.end);
    const state: BlockState = position >= p.start && position < p.end ? 'now' : p.end <= position ? 'past' : 'future';
    out.push({
      program: p,
      left: timeToFrac(s, w),
      width: timeToFrac(e, w) - timeToFrac(s, w),
      state,
      playable: p.start < now && !!rangeAt(Math.max(p.start, ranges[0]?.start ?? Infinity), ranges),
    });
  }
  return out;
}

export function programAt(t: number, programs: EpgProgram[]): EpgProgram | null {
  return programs.find((p) => t >= p.start && t < p.end) ?? null;
}

/** Absolute position (epoch ms) of the playhead. */
export function absolutePosition(startsAt: number | undefined, currentTime: number, seekEnd: number, now: number): number {
  if (startsAt !== undefined) return startsAt + currentTime * 1000;
  return now - Math.max(0, seekEnd - currentTime) * 1000;
}

/** Media time (seconds) for an absolute time inside the current stream, or null if outside it. */
export function mediaTimeFor(t: number, startsAt: number | undefined, seekStart: number, seekEnd: number, now: number): number | null {
  const sec = startsAt !== undefined ? (t - startsAt) / 1000 : seekEnd - (now - t) / 1000;
  if (sec < seekStart - 0.5 || sec > seekEnd + 0.5) return null;
  return Math.min(seekEnd, Math.max(seekStart, sec));
}
