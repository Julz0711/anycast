/** Timezone helpers. Real panels express EPG strings and timeshift URLs in the panel's local time. */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function intlParts(epochSec: number, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(Math.floor(epochSec) * 1000))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

const offsetCache = new Map<string, number>();

/** Offset of `tz` from UTC at the given instant, in seconds (Berlin summer: 7200). Cached per 15 min. */
export function tzOffsetSeconds(epochSec: number, tz: string): number {
  const bucket = Math.floor(epochSec / 900);
  const key = `${tz}|${bucket}`;
  let off = offsetCache.get(key);
  if (off === undefined) {
    const t = bucket * 900;
    const p = intlParts(t, tz);
    off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - t;
    if (offsetCache.size > 50000) offsetCache.clear();
    offsetCache.set(key, off);
  }
  return off;
}

export function localParts(epochSec: number, tz: string): LocalParts {
  const d = new Date((Math.floor(epochSec) + tzOffsetSeconds(epochSec, tz)) * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** Converts a wall-clock time in `tz` to unix seconds. */
export function localToEpoch(p: LocalParts, tz: string): number {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  const off1 = tzOffsetSeconds(guess, tz);
  let t = guess - off1;
  const off2 = tzOffsetSeconds(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** "YYYY-MM-DD HH:MM:SS" in the panel timezone. */
export function formatLocal(epochSec: number, tz: string): string {
  const p = localParts(epochSec, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** "HH:MM:SS" in the panel timezone. */
export function formatClock(epochSec: number, tz: string): string {
  const p = localParts(epochSec, tz);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** XMLTV time: "YYYYMMDDHHMMSS +0100". */
export function formatXmltv(epochSec: number, tz: string): string {
  const p = localParts(epochSec, tz);
  const off = tzOffsetSeconds(epochSec, tz);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${p.year}${pad(p.month)}${pad(p.day)}${pad(p.hour)}${pad(p.minute)}${pad(p.second)} ${sign}${pad(Math.floor(a / 3600))}${pad(Math.floor((a % 3600) / 60))}`;
}

/** Seconds since local midnight in the panel timezone (used for the PTS-of-day convention). */
export function secondsOfDay(epochSec: number, tz: string): number {
  const p = localParts(epochSec, tz);
  return p.hour * 3600 + p.minute * 60 + p.second + (epochSec - Math.floor(epochSec));
}

/** Parses timeshift start "YYYY-MM-DD:HH-MM" (also tolerates "YYYY-MM-DD HH:MM" and "YYYY-MM-DD:HH:MM"). */
export function parseTimeshiftStart(s: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[: T_](\d{2})[-:](\d{2})(?:[-:](\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map((v) => Number(v ?? 0)) as [
    number, number, number, number, number, number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return localToEpoch({ year, month, day, hour, minute, second: second || 0 }, tz);
}
