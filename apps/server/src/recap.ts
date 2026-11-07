/** Watch history and the recap built from it (@anycast/shared recap.ts). */
import {
  RECAP_MIN_SECONDS, WATCH_REPORT_MAX_SECONDS, type Recap, type RecapGenre, type RecapItem, type WatchKind,
} from '@anycast/shared';
import { artUrl, getEpisode, type ChannelRow, type MovieRow, type SeriesRow } from './catalog/store';
import type { Db } from './db';
import type { AdultView } from './parental';

const HOUR = 3_600_000;
const TOP = 5;

interface Row { hour: number; kind: WatchKind; item_id: string; series_id: string | null; seconds: number }

/** Adds played seconds to the item's current hour. */
export function recordWatch(
  db: Db,
  profileId: string,
  input: { kind: WatchKind; id: string; seconds: number; seriesId?: string | null },
  now = Date.now(),
): void {
  const seconds = Math.min(Math.max(0, input.seconds), WATCH_REPORT_MAX_SECONDS);
  if (!(seconds > 0)) return;
  let seriesId = input.kind === 'episode' ? (input.seriesId ?? null) : null;
  if (input.kind === 'episode' && !seriesId) seriesId = getEpisode(db, input.id)?.series_id ?? null;
  db.prepare(
    `INSERT INTO watch_history (profile_id, hour, kind, item_id, series_id, seconds) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, hour, kind, item_id) DO UPDATE SET seconds = seconds + excluded.seconds,
       series_id = COALESCE(excluded.series_id, series_id)`,
  ).run(profileId, Math.floor(now / HOUR) * HOUR, input.kind, input.id, seriesId, seconds);
}

export function clearWatchHistory(db: Db, profileId: string): void {
  db.prepare('DELETE FROM watch_history WHERE profile_id = ?').run(profileId);
}

/** A time zone Intl knows, else UTC. */
export function safeTimeZone(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Local date, hour and weekday of each hour bucket, cached per call. */
function localClock(tz: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const cache = new Map<number, { date: string; hour: number; weekday: number }>();
  return (ms: number) => {
    let v = cache.get(ms);
    if (!v) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      v = { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: WEEKDAY[p.weekday!] ?? 0 };
      cache.set(ms, v);
    }
    return v;
  };
}

/** "UK · Sports" -> "Sports"; "Sports" stays. */
export const genreOf = (category: string) => {
  const i = category.lastIndexOf(' · ');
  return (i >= 0 ? category.slice(i + 3) : category).trim();
};

function longestStreak(dates: string[]): number {
  const days = [...new Set(dates)].map((d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000).sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1]! + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

export function buildRecap(db: Db, profileId: string, q: { from: number; to: number; tz?: string }, adult: AdultView): Recap {
  const tz = safeTimeZone(q.tz);
  const rows = db
    .prepare('SELECT hour, kind, item_id, series_id, seconds FROM watch_history WHERE profile_id = ? AND hour >= ? AND hour < ? ORDER BY hour')
    .all(profileId, Math.floor(q.from / HOUR) * HOUR, q.to) as Row[];

  // catalog rows, once each
  const channels = new Map<string, ChannelRow | null>();
  const movies = new Map<string, MovieRow | null>();
  const series = new Map<string, SeriesRow | null>();
  const getC = db.prepare('SELECT * FROM channels WHERE id = ?');
  const getM = db.prepare('SELECT * FROM movies WHERE id = ?');
  const getS = db.prepare('SELECT * FROM series WHERE id = ?');
  const lookup = <T>(m: Map<string, T | null>, stmt: typeof getC, id: string): T | null => {
    if (!m.has(id)) m.set(id, (stmt.get(id) as T | undefined) ?? null);
    return m.get(id)!;
  };
  const categories = new Map((db.prepare('SELECT id, name FROM categories').all() as { id: string; name: string }[]).map((c) => [c.id, c.name]));

  /** the catalog row behind a history row: its category, display item and the key it adds up under */
  const resolve = (r: Row): { categoryId: string | null; item: RecapItem } | null => {
    if (r.kind === 'live') {
      const c = lookup(channels, getC, r.item_id);
      // duplicate channels add up under their group (one "BBC One" for its HD and FHD versions)
      const name = c ? (c.group_size > 1 && c.group_name ? c.group_name : c.name) : null;
      return { categoryId: c?.category_id ?? null, item: { kind: 'live', id: r.item_id, name: name ?? 'Unknown channel', art: c ? artUrl('live', c.id, c.logo) : null, seconds: 0 } };
    }
    if (r.kind === 'movie') {
      const m = lookup(movies, getM, r.item_id);
      return { categoryId: m?.category_id ?? null, item: { kind: 'movie', id: r.item_id, name: m?.name ?? 'Unknown movie', art: m ? artUrl('movie', m.id, m.poster) : null, seconds: 0 } };
    }
    const sid = r.series_id ?? getEpisode(db, r.item_id)?.series_id ?? null;
    if (!sid) return { categoryId: null, item: { kind: 'series', id: `?${r.item_id}`, name: 'Unknown series', art: null, seconds: 0 } };
    const s = lookup(series, getS, sid);
    return { categoryId: s?.category_id ?? null, item: { kind: 'series', id: sid, name: s?.name ?? 'Unknown series', art: s ? artUrl('series', s.id, s.poster) : null, seconds: 0 } };
  };

  const mask = (item: RecapItem, categoryId: string | null): RecapItem => {
    if (!categoryId) return item;
    const shown = adult.item({ ...item, categoryId, rawName: item.name, logo: item.kind === 'live' ? item.art : undefined, poster: item.kind !== 'live' ? item.art : undefined });
    return { kind: item.kind, id: item.id, name: shown.name, art: (item.kind === 'live' ? shown.logo : shown.poster) ?? null, seconds: item.seconds, ...(item.count !== undefined ? { count: item.count } : {}), ...(shown.locked ? { locked: true } : {}) };
  };

  const clock = localClock(tz);
  const byKind: Record<WatchKind, number> = { live: 0, movie: 0, episode: 0 };
  const hours = Array<number>(24).fill(0);
  const weekdays = Array<number>(7).fill(0);
  const days = new Map<string, number>();
  const items = new Map<string, { item: RecapItem; categoryId: string | null; days: Set<string>; episodes: Map<string, number> }>();
  const perItem = new Map<string, number>(); // kind:item_id -> seconds (what counts as watched)
  const genres = new Map<string, number>();
  let first: (RecapItem & { at: number }) | null = null;
  let firstKey: string | null = null;
  let firstAt = 0;
  let total = 0;
  const hidden = new Set(adult.hiddenIds);

  for (const r of rows) {
    const resolved = resolve(r);
    if (!resolved) continue;
    const { categoryId } = resolved;
    if (categoryId && hidden.has(categoryId)) continue;
    const local = clock(r.hour);
    total += r.seconds;
    byKind[r.kind] += r.seconds;
    hours[local.hour]! += r.seconds;
    weekdays[local.weekday]! += r.seconds;
    days.set(local.date, (days.get(local.date) ?? 0) + r.seconds);
    const key = `${resolved.item.kind}:${resolved.item.kind === 'live' ? (lookup(channels, getC, r.item_id)?.group_key ?? r.item_id) : resolved.item.id}`;
    let agg = items.get(key);
    if (!agg) items.set(key, (agg = { item: resolved.item, categoryId, days: new Set(), episodes: new Map() }));
    agg.item.seconds += r.seconds;
    agg.days.add(local.date);
    if (r.kind === 'episode') agg.episodes.set(r.item_id, (agg.episodes.get(r.item_id) ?? 0) + r.seconds);
    perItem.set(`${r.kind}:${r.item_id}`, (perItem.get(`${r.kind}:${r.item_id}`) ?? 0) + r.seconds);
    const cat = categoryId ? categories.get(categoryId) : undefined;
    if (cat && !adult.adultIds.has(categoryId!)) genres.set(genreOf(cat), (genres.get(genreOf(cat)) ?? 0) + r.seconds);
    if (!firstKey) {
      firstKey = key;
      firstAt = r.hour;
    }
  }

  const counted = (kind: WatchKind) => [...perItem].filter(([k, s]) => k.startsWith(`${kind}:`) && s >= RECAP_MIN_SECONDS[kind]).length;
  const top = (kind: RecapItem['kind'], min: number) =>
    [...items.values()]
      .filter((a) => a.item.kind === kind && a.item.seconds >= min)
      .sort((a, b) => b.item.seconds - a.item.seconds)
      .slice(0, TOP)
      .map((a) => {
        const count = kind === 'live' ? a.days.size : kind === 'series' ? [...a.episodes.values()].filter((s) => s >= RECAP_MIN_SECONDS.episode).length : undefined;
        return mask({ ...a.item, ...(count !== undefined ? { count } : {}) }, a.categoryId);
      });
  const topChannels = top('live', RECAP_MIN_SECONDS.live);
  const topSeries = top('series', RECAP_MIN_SECONDS.episode);
  if (firstKey) {
    const a = items.get(firstKey)!;
    first = { ...mask({ ...a.item }, a.categoryId), at: firstAt };
  }

  const dayList = [...days];
  const topDay = dayList.reduce<{ date: string; seconds: number } | null>((best, [date, seconds]) => (!best || seconds > best.seconds ? { date, seconds } : best), null);
  const genreList: RecapGenre[] = [...genres].map(([name, seconds]) => ({ name, seconds })).sort((a, b) => b.seconds - a.seconds).slice(0, 6);

  const span = q.to - q.from;
  const prev = db
    .prepare('SELECT COALESCE(SUM(seconds), 0) AS s, COUNT(*) AS n FROM watch_history WHERE profile_id = ? AND hour >= ? AND hour < ?')
    .get(profileId, Math.floor((q.from - span) / HOUR) * HOUR, Math.floor(q.from / HOUR) * HOUR) as { s: number; n: number };
  const since = db.prepare('SELECT MIN(hour) AS h FROM watch_history WHERE profile_id = ?').get(profileId) as { h: number | null };

  return {
    from: q.from,
    to: q.to,
    tz,
    totalSeconds: Math.round(total),
    byKind: { live: Math.round(byKind.live), movie: Math.round(byKind.movie), episode: Math.round(byKind.episode) },
    previousSeconds: q.from > 0 && prev.n > 0 ? Math.round(prev.s) : null,
    counts: {
      channels: topChannelsCount(items),
      movies: counted('movie'),
      episodes: counted('episode'),
      series: [...items.values()].filter((a) => a.item.kind === 'series' && [...a.episodes.values()].some((s) => s >= RECAP_MIN_SECONDS.episode)).length,
      days: days.size,
    },
    topChannels,
    topMovies: top('movie', RECAP_MIN_SECONDS.movie),
    topSeries,
    genres: genreList,
    hours: hours.map(Math.round),
    weekdays: weekdays.map(Math.round),
    topDay: topDay ? { date: topDay.date, seconds: Math.round(topDay.seconds) } : null,
    longestStreak: longestStreak(dayList.map(([d]) => d)),
    first,
    historySince: since.h,
  };
}

/** channels (merged duplicates count once) watched for at least a minute */
function topChannelsCount(items: Map<string, { item: RecapItem }>): number {
  return [...items.values()].filter((a) => a.item.kind === 'live' && a.item.seconds >= RECAP_MIN_SECONDS.live).length;
}
