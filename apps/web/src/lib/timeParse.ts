/**
 * Parse what a viewer types into the "Jump to time" box.
 *
 *   "20:15", "20.15", "2015", "8:15pm"  -> that clock time today (or yesterday if it is still in the future)
 *   "-45m", "+10m", "-1h30m", "-90s", "−2h" -> relative to the current position
 *   "45m", "1h"                          -> unsigned durations mean "that long ago" (relative, backwards)
 *   "now", "live"                        -> now
 */
export type TimeParseResult = { ok: true; at: number } | { ok: false; error: string };

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };

export function parseTimeInput(raw: string, ctx: { now: number; position: number }): TimeParseResult {
  const input = raw.trim().toLowerCase().replace(/−/g, '-').replace(/\s+/g, '');
  if (!input) return { ok: false, error: 'Type a time like 20:15, or -45m / +10m.' };
  if (input === 'now' || input === 'live') return { ok: true, at: ctx.now };

  // Relative: optional sign, then one or more <number><unit> parts.
  const rel = /^([+-]?)((?:\d+(?:\.\d+)?[hms])+)$/.exec(input);
  if (rel) {
    const sign = rel[1] === '+' ? 1 : -1; // unsigned means "ago"
    let ms = 0;
    for (const part of rel[2]!.matchAll(/(\d+(?:\.\d+)?)([hms])/g)) {
      ms += Number(part[1]) * UNIT_MS[part[2]!]!;
    }
    if (ms === 0) return { ok: false, error: 'That is zero time.' };
    return { ok: true, at: ctx.position + sign * ms };
  }

  // Signed plain minutes: "-45" / "+10"
  const signedMin = /^([+-])(\d+)$/.exec(input);
  if (signedMin) {
    const ms = Number(signedMin[2]) * 60_000;
    return { ok: true, at: ctx.position + (signedMin[1] === '+' ? ms : -ms) };
  }

  // Clock: 20:15, 20.15, 2015, 8:15pm, 8pm
  const clock = /^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm)?$/.exec(input);
  if (clock) {
    let h = Number(clock[1]);
    const m = clock[2] ? Number(clock[2]) : 0;
    const ampm = clock[3];
    if (!clock[2] && !ampm && clock[1]!.length > 2) return { ok: false, error: 'Use a time like 20:15.' };
    if (ampm) {
      if (h < 1 || h > 12) return { ok: false, error: 'Hours must be 1–12 with am/pm.' };
      if (ampm === 'pm' && h !== 12) h += 12;
      if (ampm === 'am' && h === 12) h = 0;
    }
    if (h > 23 || m > 59) return { ok: false, error: 'That is not a valid time of day.' };
    const d = new Date(ctx.now);
    d.setHours(h, m, 0, 0);
    let at = d.getTime();
    // A clock time later than now means the most recent occurrence: yesterday.
    if (at > ctx.now + 60_000) at -= 86_400_000;
    return { ok: true, at };
  }

  return { ok: false, error: `Didn't understand "${raw.trim()}". Try 20:15, -45m or +10m.` };
}

/**
 * For movies/episodes: "1:20:00" / "45:10" jump to that media time; "+10m" / "-90s" relative to the position.
 * Returns seconds.
 */
export function parseMediaTime(raw: string, ctx: { position: number; duration: number }): { ok: true; at: number } | { ok: false; error: string } {
  const input = raw.trim().replace(/−/g, '-');
  const hms = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (hms) {
    const at = hms[3] !== undefined ? Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]) : Number(hms[1]) * 60 + Number(hms[2]);
    return { ok: true, at: Math.min(at, ctx.duration || at) };
  }
  if (/^[+-]/.test(input)) {
    const r = parseTimeInput(input, { now: Infinity, position: ctx.position * 1000 });
    if (r.ok) return { ok: true, at: Math.max(0, Math.min(ctx.duration || Infinity, r.at / 1000)) };
  }
  return { ok: false, error: 'Type a time like 1:20:00, 45:10, -5m or +10m.' };
}
