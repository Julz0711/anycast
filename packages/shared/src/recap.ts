/**
 * Watch history and the recap (a Wrapped-style look back at what a profile watched).
 *
 * The player reports watched time while something plays (POST /api/watch-time): seconds that
 * actually played, never paused or buffering time. The server keeps them per profile, item and
 * hour, so a recap can say when, what and how much for any period.
 */

/** What a watch-time report is for. */
export type WatchKind = 'live' | 'movie' | 'episode';

/** The most seconds one report may carry (the player reports about once a minute). */
export const WATCH_REPORT_MAX_SECONDS = 600;

/** Below this, an item doesn't count as watched in a recap (zapping past, a peek at a movie). */
export const RECAP_MIN_SECONDS: Record<WatchKind, number> = { live: 60, movie: 300, episode: 180 };

/** A channel, movie or series in a recap. `count`: days a channel was on, episodes of a series. */
export interface RecapItem {
  kind: 'live' | 'movie' | 'series';
  id: string;
  name: string;
  /** logo or poster (/api/art/...) */
  art: string | null;
  seconds: number;
  count?: number;
  /** in a locked adult category: name is LOCKED_NAME and art is null */
  locked?: boolean;
}

export interface RecapGenre {
  name: string;
  seconds: number;
}

/** The recap periods the app offers. */
export type RecapPeriod = 'month' | 'lastMonth' | 'year' | 'lastYear' | 'all';

export interface Recap {
  /** epoch ms, as asked */
  from: number;
  to: number;
  /** the IANA time zone days and hours are counted in */
  tz: string;
  totalSeconds: number;
  byKind: Record<WatchKind, number>;
  /** the same length of time right before `from`; null when there is no history from then */
  previousSeconds: number | null;
  /** how many of each counted as watched (RECAP_MIN_SECONDS) */
  counts: { channels: number; movies: number; episodes: number; series: number; days: number };
  topChannels: RecapItem[];
  topMovies: RecapItem[];
  topSeries: RecapItem[];
  /** category names without the region ("UK · Sports" -> "Sports"), most watched first */
  genres: RecapGenre[];
  /** seconds per local hour of the day, 0..23 */
  hours: number[];
  /** seconds per weekday, Monday first */
  weekdays: number[];
  /** the local day with the most watching, YYYY-MM-DD */
  topDay: { date: string; seconds: number } | null;
  /** most days in a row with any watching */
  longestStreak: number;
  /** the first thing the profile watched in the period */
  first: (RecapItem & { at: number }) | null;
  /** when the profile's history starts (ms), null when there is none */
  historySince: number | null;
}

export type RecapPersonaId = 'night-owl' | 'early-bird' | 'binger' | 'cinephile' | 'surfer' | 'loyal' | 'weekender' | 'explorer';

export interface RecapPersona {
  id: RecapPersonaId;
  title: string;
  line: string;
}

const share = (part: number, total: number) => (total > 0 ? part / total : 0);

/** The viewer type a recap shows on its last card: the strongest habit wins. */
export function recapPersona(r: Recap): RecapPersona {
  const t = r.totalSeconds;
  const night = share([22, 23, 0, 1, 2, 3].reduce((a, h) => a + (r.hours[h] ?? 0), 0), t);
  const morning = share([5, 6, 7, 8, 9].reduce((a, h) => a + (r.hours[h] ?? 0), 0), t);
  const weekend = share((r.weekdays[5] ?? 0) + (r.weekdays[6] ?? 0), t);
  const series = share(r.byKind.episode, t);
  const movies = share(r.byKind.movie, t);
  const live = share(r.byKind.live, t);
  const topChannel = share(r.topChannels[0]?.seconds ?? 0, r.byKind.live);
  const scores: [RecapPersonaId, number][] = [
    ['night-owl', night / 0.35],
    ['early-bird', morning / 0.25],
    ['binger', r.counts.episodes >= 4 ? series / 0.5 : 0],
    ['cinephile', r.counts.movies >= 2 ? movies / 0.45 : 0],
    ['loyal', live > 0.4 && r.counts.channels >= 1 ? topChannel / 0.6 : 0],
    ['surfer', live > 0.4 ? Math.min(r.counts.channels / 12, 1.4) : 0],
    ['weekender', weekend / 0.55],
    ['explorer', Math.min(r.genres.length / 6, 1) * 0.9],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const id = scores[0]![0];
  return { id, ...PERSONAS[id] };
}

const PERSONAS: Record<RecapPersonaId, { title: string; line: string }> = {
  'night-owl': { title: 'The Night Owl', line: 'Your best watching happens after dark.' },
  'early-bird': { title: 'The Early Bird', line: 'Coffee in one hand, remote in the other.' },
  binger: { title: 'The Binger', line: 'One more episode. And then one more.' },
  cinephile: { title: 'The Cinephile', line: 'Lights down, phone away, film on.' },
  surfer: { title: 'The Channel Surfer', line: 'Always curious what else is on.' },
  loyal: { title: 'The Loyal One', line: 'You know what you like, and you stick with it.' },
  weekender: { title: 'The Weekender', line: 'Saturdays and Sundays are for the couch.' },
  explorer: { title: 'The Explorer', line: 'A bit of everything, never the same twice.' },
};

/** The time span of a recap period in the viewer's local time: [from, to) in ms, and a title. */
export function recapRange(period: RecapPeriod, now: Date = new Date()): { from: number; to: number; title: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const monthName = (d: Date) => d.toLocaleString('en', { month: 'long' });
  switch (period) {
    case 'month':
      return { from: new Date(y, m, 1).getTime(), to: new Date(y, m + 1, 1).getTime(), title: monthName(now) };
    case 'lastMonth': {
      const start = new Date(y, m - 1, 1);
      return { from: start.getTime(), to: new Date(y, m, 1).getTime(), title: monthName(start) };
    }
    case 'year':
      return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime(), title: String(y) };
    case 'lastYear':
      return { from: new Date(y - 1, 0, 1).getTime(), to: new Date(y, 0, 1).getTime(), title: String(y - 1) };
    case 'all':
      return { from: 0, to: new Date(y + 1, 0, 1).getTime(), title: 'All time' };
  }
}
