/** Small, dependency-free time formatting helpers. */
import { describeGap, type GapCause } from '@anycast/shared';

const pad = (n: number) => String(n).padStart(2, '0');

/** "21:46" in local time */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A timeline gap's reason in the viewer's time zone (the server's `reason` text uses the server's). */
export function gapText(g: { reason: string; cause?: GapCause }): string {
  return g.cause ? describeGap(g.cause, fmtClock) : g.reason;
}

/** "20:30 – 22:30" */
export function fmtRange(start: number, end: number): string {
  return `${fmtClock(start)} – ${fmtClock(end)}`;
}

/** Seconds as "1:12:40" or "4:05" */
export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Milliseconds behind live as "−24:10" (U+2212 minus). */
export function fmtBehind(ms: number): string {
  return `−${fmtDuration(ms / 1000)}`;
}

/** "1 h 58 min", "24 min" */
export function fmtLength(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** "Today", "Yesterday", or a weekday + date */
export function fmtDay(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const t = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(t) - startOf(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff === -1) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function fmtRelativeAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
