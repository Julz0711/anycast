/** Deterministic fictional catalog for demo mode. No real channel or brand names. */
import type { Category, Channel, EpgProgram, Episode, Movie, Series, SeriesDetail } from '@anycast/shared';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type Genre = 'sport' | 'news' | 'movies' | 'kids' | 'docs' | 'general' | 'music';
const LIVE_CATS: { prefix: string; country: string; language: string; genre: Genre; label: string }[] = [
  { prefix: 'UK', country: 'gb', language: 'en', genre: 'general', label: 'Entertainment' },
  { prefix: 'UK', country: 'gb', language: 'en', genre: 'sport', label: 'Sport' },
  { prefix: 'UK', country: 'gb', language: 'en', genre: 'news', label: 'News' },
  { prefix: 'UK', country: 'gb', language: 'en', genre: 'kids', label: 'Kids' },
  { prefix: 'UK', country: 'gb', language: 'en', genre: 'docs', label: 'Documentary' },
  { prefix: 'US', country: 'us', language: 'en', genre: 'movies', label: 'Movies' },
  { prefix: 'US', country: 'us', language: 'en', genre: 'music', label: 'Music' },
  { prefix: 'DE', country: 'de', language: 'de', genre: 'general', label: 'Allgemein' },
  { prefix: 'DE', country: 'de', language: 'de', genre: 'sport', label: 'Sport' },
  { prefix: 'DE', country: 'de', language: 'de', genre: 'news', label: 'Nachrichten' },
  { prefix: 'FR', country: 'fr', language: 'fr', genre: 'general', label: 'Général' },
  { prefix: 'ES', country: 'es', language: 'es', genre: 'sport', label: 'Deportes' },
  { prefix: 'IT', country: 'it', language: 'it', genre: 'general', label: 'Generale' },
  { prefix: 'TR', country: 'tr', language: 'tr', genre: 'general', label: 'Ulusal' },
  { prefix: 'AR', country: 'ae', language: 'ar', genre: 'news', label: 'News' },
];

const CH_NAMES: Record<Genre, string[]> = {
  sport: ['Arena Sport 1', 'Arena Sport 2', 'Goal TV', 'Velo Channel', 'Court Side', 'Pitch One', 'Ringside', 'Summit Sports', 'Racing Live', 'Fairway'],
  news: ['News 24', 'World Desk', 'Daily Wire TV', 'Metro News', 'Global Report', 'Capital News', 'Signal News'],
  movies: ['Kino Plus', 'Cinema Lane', 'Reel One', 'Matinee', 'Film Vault', 'Screen Classics', 'Premiere 2'],
  kids: ['Kidz', 'Toon Town', 'Little Ones', 'Paper Kite', 'Story Time'],
  docs: ['Docu Earth', 'Planet Lens', 'History Hall', 'Field Notes', 'Deep Blue'],
  general: ['Nordlicht 1', 'Channel Ten', 'Metro Mix', 'Prime One', 'Lumen TV', 'Horizon', 'Studio 4', 'Bright Side', 'Harbour TV'],
  music: ['Beat FM TV', 'Loop', 'Encore', 'Stage Live'],
};
const SHOWS: Record<Genre, string[]> = {
  sport: ['Matchday Live', 'Pre-match', 'Cup Final: North vs. Harbour', 'Highlights', 'Classic Finals', 'Cycling: Stage 9', 'Tennis: Quarter-finals', 'Motor Weekly', 'The Goal Show', 'Boxing Night'],
  news: ['Morning Briefing', 'World Tonight', 'Evening Bulletin', 'Weather', 'Late News', 'Business Hour', 'The Interview', 'Headlines'],
  movies: ['The Long Coast', 'Glass Harbour', 'Night Train East', 'Late Film', 'Red Meridian', 'Slow Tide', 'Afterlight', 'Ninefold'],
  kids: ['Paper Planes', 'Bedtime Stories', 'Robot Pals', 'The Garden Gang', 'Bubble Lab', 'Tiny Explorers'],
  docs: ['Rivers of Ice', 'Coastlines', 'Wild Coasts', 'Cities at Night', 'The Deep', 'Ancient Roads', 'Desert Bloom'],
  general: ['Quiz Night', 'Evening News', 'Late Talk', 'Kitchen Duel', 'Home Rescue', 'The Weekly', 'Garden Hour', 'Comedy Club'],
  music: ['Music Charts', 'Late Show', 'Live Sessions', 'Throwback Hour', 'Night Mix'],
};

const MOVIE_GENRES = ['Drama', 'Thriller', 'Comedy', 'Sci-Fi', 'Documentary', 'Family', 'Action', 'Romance'];
const SERIES_GENRES = ['Drama', 'Crime', 'Comedy', 'Sci-Fi', 'Documentary', 'Kids'];
const ADJ = ['Glass', 'Quiet', 'Red', 'Slow', 'Silent', 'Paper', 'Northern', 'Hollow', 'Golden', 'Last', 'Distant', 'Broken', 'Iron', 'Velvet', 'Bright', 'Lost', 'Hidden', 'Winter', 'Summer', 'Electric'];
const NOUN = ['Harbour', 'Field', 'Meridian', 'Tide', 'Coast', 'Lanterns', 'Signal', 'Train', 'Garden', 'River', 'Station', 'Orchard', 'Valley', 'Light', 'Mile', 'Hours', 'Shore', 'Line', 'Kingdom', 'Season'];
const PLOTS = [
  'A ferry captain returns to the island she left twenty years ago and finds the town keeping a secret.',
  'Two strangers share a night train across the border and a briefcase that is not theirs.',
  'A small orchestra tries to save its old concert hall before the last winter season.',
  'An engineer receives a radio signal that seems to come from her own future.',
  'Three siblings inherit a crumbling seaside hotel and one very stubborn guest.',
  'A detective with one week left before retirement reopens the case that made her career.',
];

export interface Fixtures {
  liveCategories: Category[];
  movieCategories: Category[];
  seriesCategories: Category[];
  channels: Channel[];
  movies: Movie[];
  series: Series[];
  seriesDetail: (id: string) => SeriesDetail | null;
  epgFor: (channel: Channel) => EpgProgram[];
}

export function buildFixtures(): Fixtures {
  const liveCategories: Category[] = LIVE_CATS.map((c, i) => ({
    id: `lc${i + 1}`,
    kind: 'live',
    name: `${c.prefix} | ${c.label}`,
    country: c.country,
    language: c.language,
    adult: false,
  }));

  const channels: Channel[] = [];
  let number = 101;
  LIVE_CATS.forEach((c, ci) => {
    const r = rng(hash(c.prefix + c.label));
    const names = CH_NAMES[c.genre];
    const n = c.prefix === 'UK' || c.prefix === 'DE' ? names.length : Math.min(names.length, 3 + Math.floor(r() * 3));
    for (let i = 0; i < n; i++) {
      const base = names[i]!;
      const name = c.prefix === 'UK' ? base : `${base} ${c.prefix}`;
      const id = `ch${number}`;
      channels.push({
        id,
        name,
        rawName: `${c.prefix} | ${name} HD`,
        number,
        categoryId: liveCategories[ci]!.id,
        logo: null,
        country: c.country,
        language: c.language,
        archiveDays: r() < 0.45 ? pick(r, [1, 3, 7]) : 0,
        // like real panels, some channels come without guide data
        epgChannelId: number % 7 === 3 ? null : `${id}.epg`,
        hasEpg: number % 7 !== 3,
      });
      number++;
    }
    number = Math.ceil(number / 10) * 10 + 1;
  });

  const movieCategories: Category[] = [
    ...MOVIE_GENRES.map((g, i) => ({ id: `mc${i + 1}`, kind: 'movie' as const, name: `EN | ${g}`, country: 'gb', language: 'en', adult: false })),
    { id: 'mc90', kind: 'movie', name: 'DE | Filme', country: 'de', language: 'de', adult: false },
    { id: 'mc91', kind: 'movie', name: 'FR | Films', country: 'fr', language: 'fr', adult: false },
    { id: 'mc92', kind: 'movie', name: 'TR | Filmler', country: 'tr', language: 'tr', adult: false },
  ];
  const seriesCategories: Category[] = [
    ...SERIES_GENRES.map((g, i) => ({ id: `sc${i + 1}`, kind: 'series' as const, name: `EN | ${g}`, country: 'gb', language: 'en', adult: false })),
    { id: 'sc90', kind: 'series', name: 'DE | Serien', country: 'de', language: 'de', adult: false },
    { id: 'sc91', kind: 'series', name: 'ES | Series', country: 'es', language: 'es', adult: false },
  ];

  const title = (r: () => number) => (r() < 0.3 ? `The ${pick(r, ADJ)} ${pick(r, NOUN)}` : `${pick(r, ADJ)} ${pick(r, NOUN)}`);
  const movies: Movie[] = [];
  movieCategories.forEach((c, ci) => {
    const r = rng(1000 + ci);
    const n = c.id.startsWith('mc9') ? 14 : 36;
    for (let i = 0; i < n; i++) {
      const name = title(r);
      movies.push({
        id: `m${ci * 100 + i + 1}`,
        name,
        rawName: `${c.name.split(' | ')[0]} | ${name}`,
        categoryId: c.id,
        poster: null,
        year: 1990 + Math.floor(r() * 36),
        rating: Math.round((5.4 + r() * 3.2) * 10) / 10,
        plot: pick(r, PLOTS),
        duration: (80 + Math.floor(r() * 70)) * 60,
        container: 'mp4',
        country: c.country,
        language: c.language,
      });
    }
  });

  const series: Series[] = [];
  seriesCategories.forEach((c, ci) => {
    const r = rng(2000 + ci);
    const n = c.id.startsWith('sc9') ? 10 : 24;
    for (let i = 0; i < n; i++) {
      const name = title(r);
      series.push({
        id: `s${ci * 100 + i + 1}`,
        name,
        rawName: `${c.name.split(' | ')[0]} | ${name}`,
        categoryId: c.id,
        poster: null,
        year: 2005 + Math.floor(r() * 21),
        rating: Math.round((6 + r() * 2.8) * 10) / 10,
        plot: pick(r, PLOTS),
        country: c.country,
        language: c.language,
      });
    }
  });

  const EP_TITLES = ['Arrivals', 'The Crossing', 'Low Tide', 'Signals', 'Night Shift', 'Old Friends', 'The Visitor', 'Fault Lines', 'Homecoming', 'Last Light'];
  const seriesDetail = (id: string): SeriesDetail | null => {
    const s = series.find((x) => x.id === id);
    if (!s) return null;
    const r = rng(hash(id));
    const nSeasons = 1 + Math.floor(r() * 4);
    const seasons = Array.from({ length: nSeasons }, (_, si) => {
      const nEp = 6 + Math.floor(r() * 5);
      const episodes: Episode[] = Array.from({ length: nEp }, (_, ei) => ({
        id: `${id}e${si + 1}x${ei + 1}`,
        seriesId: id,
        season: si + 1,
        episode: ei + 1,
        title: ei === 0 && si === 0 ? 'Pilot' : pick(r, EP_TITLES),
        plot: pick(r, PLOTS),
        duration: (38 + Math.floor(r() * 22)) * 60,
        container: 'mp4',
      }));
      return { season: si + 1, episodes };
    });
    return { ...s, seasons };
  };

  const genreOf = new Map(channels.map((ch) => [ch.id, LIVE_CATS[liveCategories.findIndex((c) => c.id === ch.categoryId)]!.genre]));
  const epgCache = new Map<string, EpgProgram[]>();
  const epgFor = (ch: Channel): EpgProgram[] => {
    const hit = epgCache.get(ch.id);
    if (hit) return hit;
    if (!ch.hasEpg) return [];
    const r = rng(hash(ch.id));
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    let t = d.getTime() - 8 * 86_400_000;
    const end = Date.now() + 2 * 86_400_000;
    const shows = SHOWS[genreOf.get(ch.id) ?? 'general'];
    const out: EpgProgram[] = [];
    while (t < end) {
      const dur = pick(r, [30, 30, 45, 60, 60, 90, 120]) * 60_000;
      out.push({ channelId: ch.id, title: pick(r, shows), description: pick(r, PLOTS), start: t, end: t + dur });
      t += dur;
    }
    epgCache.set(ch.id, out);
    return out;
  };

  return { liveCategories, movieCategories, seriesCategories, channels, movies, series, seriesDetail, epgFor };
}
