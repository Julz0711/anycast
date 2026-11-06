/**
 * Deterministic EPG schedule. Each epg_channel_id has a schedule per UTC day, made of 30–90 min
 * programmes (5 min steps). The schedule does not depend on the current time, so every
 * request (and XMLTV) agrees on what aired when.
 */
import { hashString, intBetween, mulberry32, pick } from './random.js';

export interface Programme {
  id: string;
  start: number;
  stop: number;
  title: string;
  description: string;
}

const DAY = 86400;

const SHOWS = [
  'Morning News', 'World Report', 'Live: Football Tonight', 'Documentary: Ocean Deep', 'Cooking Club',
  'The Quiz Hour', 'Late Night Talk', 'Weather & Traffic', 'Classic Movie', 'Kids Cartoon Time',
  'Science Weekly', 'Motorsport Magazine', 'History Uncovered', 'Evening Drama', 'Music Charts',
];

const dayCache = new Map<string, Programme[]>();

export function programmesForDay(epgId: string, dayIndex: number): Programme[] {
  const key = `${epgId}#${dayIndex}`;
  const cached = dayCache.get(key);
  if (cached) return cached;
  const rng = mulberry32(hashString(key));
  const out: Programme[] = [];
  const dayStart = dayIndex * DAY;
  let t = dayStart;
  let n = 0;
  while (t < dayStart + DAY) {
    const len = intBetween(rng, 6, 18) * 300;
    const stop = Math.min(t + len, dayStart + DAY);
    const show = pick(rng, SHOWS);
    const episode = intBetween(rng, 1, 250);
    out.push({
      id: String(hashString(`${key}#${n}`) % 100000000),
      start: t,
      stop,
      title: `${show} #${episode}`,
      description: `${show}, episode ${episode} on ${epgId}. Deterministic mock programme.`,
    });
    t = stop;
    n++;
  }
  if (dayCache.size > 20000) dayCache.clear();
  dayCache.set(key, out);
  return out;
}

/** Programmes overlapping [from, to). */
export function programmesBetween(epgId: string, from: number, to: number): Programme[] {
  const out: Programme[] = [];
  for (let d = Math.floor(from / DAY); d * DAY < to; d++) {
    for (const p of programmesForDay(epgId, d)) if (p.stop > from && p.start < to) out.push(p);
  }
  return out;
}
