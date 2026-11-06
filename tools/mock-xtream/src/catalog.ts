/**
 * Deterministic fake catalog. Names are written the messy ways real providers write them
 * ("DE | ARD HD", "UK: BBC One", "[FR] TF1", "|EN| Sky Sports 1 FHD", ...), and every
 * category/item name is registered with its ground-truth tags (see `expectedTags`).
 *
 * Ids, catalog order and format profiles do not depend on the seed and `small` is a prefix of
 * `full`, so the ids in FORMAT_MATRIX are valid for every size and seed. The seed varies
 * names, ratings, archive flags and the like.
 */
import {
  liveProfileForIndex,
  vodDurationForId,
  vodProfileForIndex,
  type LiveProfileId,
  type VodProfileId,
} from './formats.js';
import { hashString, intBetween, pick, rngFor, type Rng } from './random.js';

export type CatalogSize = 'full' | 'small' | 'huge' | 'real';

export interface Tags {
  /** ISO-3166 alpha-2, lowercase ("gb" for UK), null when the name does not tell. */
  country: string | null;
  /** ISO-639-1, lowercase, null when the name does not tell. */
  language: string | null;
  adult: boolean;
}

export interface Category {
  category_id: string;
  category_name: string;
  parent_id: 0;
  tags: Tags;
}

export interface LiveChannel {
  index: number;
  id: number;
  num: number;
  name: string;
  categoryId: string;
  /** Icon slug served at /images/{slug}.png, or null for channels without an icon. */
  icon: string | null;
  /** Real panels omit this in two ways: null and "". */
  epgChannelId: string | null;
  /** false when the id has no programmes in the guide (real panels list ids they have no data for) */
  epgListed: boolean;
  archive: boolean;
  archiveDays: number;
  added: number;
  customSid: string;
  profile: LiveProfileId;
  tags: Tags;
}

export interface Movie {
  index: number;
  id: number;
  num: number;
  name: string;
  title: string;
  year: number;
  categoryId: string;
  icon: string | null;
  added: number;
  rating: string | number;
  plot: string;
  genre: string;
  director: string;
  cast: string;
  tmdbId: string;
  durationSecs: number;
  profile: VodProfileId;
  tags: Tags;
}

export interface Episode {
  id: number;
  seriesId: number;
  season: number;
  episodeNum: number;
  title: string;
  plot: string;
  added: number;
  durationSecs: number;
  profile: VodProfileId;
}

export interface Series {
  index: number;
  id: number;
  num: number;
  name: string;
  categoryId: string;
  icon: string | null;
  plot: string;
  cast: string;
  director: string;
  genre: string;
  releaseDate: string;
  lastModified: number;
  rating: string;
  year: number;
  seasons: Episode[][];
  tags: Tags;
}

export interface Catalog {
  size: CatalogSize;
  seed: number;
  liveCategories: Category[];
  vodCategories: Category[];
  seriesCategories: Category[];
  live: LiveChannel[];
  movies: Movie[];
  series: Series[];
  liveById: Map<number, LiveChannel>;
  movieById: Map<number, Movie>;
  seriesById: Map<number, Series>;
  episodeById: Map<number, Episode>;
  /** Ground truth for every category and item name in this catalog. */
  tags: Map<string, Tags>;
}

export const DEFAULT_SEED = 42;

export const SIZES: Record<CatalogSize, { live: number; movies: number; series: number }> = {
  full: { live: 2000, movies: 5000, series: 500 },
  small: { live: 60, movies: 100, series: 20 },
  // the shape of a large real panel: ~195k items, few archives, sparse EPG
  huge: { live: 19810, movies: 139250, series: 35663 },
  // huge with a full guide: every one of the ~4k epg ids is its own channel and has programmes
  real: { live: 19810, movies: 139250, series: 35663 },
};

/**
 * How a size spreads its items. `full` and `small` use the hand-written categories only; `huge`
 * adds generated categories per region up to the counts, gives few channels an archive (1 or 3
 * days) and few an EPG id, and leaves some EPG ids without programmes.
 */
interface Shape {
  categories: { live: number; vod: number; series: number } | null;
  /** first category id of each kind */
  firstCategoryId: { live: number; vod: number; series: number };
  /** archive days from the archive roll (and the rng, for the length) */
  archiveDays: (roll: number, rng: Rng) => number;
  /** roll < this: no epg id (half null, half "") */
  noEpg: number;
  /** epg ids are unique per channel group instead of shared by every variant of a base name */
  uniqueEpg: boolean;
  /** uniqueEpg: variants of a base share an id in groups of this many */
  epgGroup: number;
  /** uniqueEpg: about a fifth of the ids have no programmes */
  epgGaps: boolean;
}

const SHAPES: Record<CatalogSize, Shape> = {
  full: {
    categories: null,
    firstCategoryId: { live: 1, vod: 100, series: 500 },
    archiveDays: (roll, rng) => (roll < 0.4 ? intBetween(rng, 1, 7) : 0),
    noEpg: 0.1,
    uniqueEpg: false,
    epgGroup: 1,
    epgGaps: false,
  },
  small: {
    categories: null,
    firstCategoryId: { live: 1, vod: 100, series: 500 },
    archiveDays: (roll, rng) => (roll < 0.4 ? intBetween(rng, 1, 7) : 0),
    noEpg: 0.1,
    uniqueEpg: false,
    epgGroup: 1,
    epgGaps: false,
  },
  huge: {
    categories: { live: 522, vod: 145, series: 128 },
    firstCategoryId: { live: 1, vod: 1000, series: 2000 },
    // ~3.2% of channels: 578 with 1 day, 54 with 3 days in a 19,810 channel panel
    archiveDays: (roll) => (roll < 0.0292 ? 1 : roll < 0.0319 ? 3 : 0),
    noEpg: 0.794,
    uniqueEpg: true,
    epgGroup: 4,
    epgGaps: true,
  },
  real: {
    categories: { live: 522, vod: 145, series: 128 },
    firstCategoryId: { live: 1, vod: 1000, series: 2000 },
    archiveDays: (roll) => (roll < 0.0292 ? 1 : roll < 0.0319 ? 3 : 0),
    noEpg: 0.794,
    uniqueEpg: true,
    epgGroup: 1,
    epgGaps: false,
  },
};

const EXTRA_CATEGORY_WORDS = ['CHANNELS', 'REGIONAL', 'LOCAL', 'EXTRA', 'MIX', 'PLUS', 'CINEMA', 'MUSIC', 'NEWS', 'KIDS', 'DOCS', 'EVENTS'];

/** Generated category names for a region ("DE | REGIONAL 3"), tagged like the region. */
function extraCategoryName(region: Region, n: number, kindWord = ''): string {
  const word = EXTRA_CATEGORY_WORDS[n % EXTRA_CATEGORY_WORDS.length]!;
  return `${region.styles[0] ?? ''}${word}${kindWord} ${Math.floor(n / EXTRA_CATEGORY_WORDS.length) + 1}`;
}

// ---------------------------------------------------------------------------------------------
// Regions: prefix styles and ground truth
// ---------------------------------------------------------------------------------------------

type Words = 'en' | 'de' | 'fr' | 'es' | 'tr';

interface Region {
  key: string;
  country: string | null;
  language: string | null;
  adult?: boolean;
  /** Primary prefix (used ~85% of the time) followed by alternates. */
  styles: string[];
  words: Words;
  /** Short code used in epg_channel_id ("ard.de"). */
  epgSuffix: string;
  live: Record<string, string[]>;
  vod: string[];
  series: string[];
  /** Prefix for movie/series names; "" means unprefixed. */
  vodPrefix: string[];
}

const REGIONS: Region[] = [
  {
    key: 'DE', country: 'de', language: 'de', words: 'de', epgSuffix: 'de',
    styles: ['DE | ', 'DE: ', '[DE] ', 'DE - ', '🇩🇪 ', 'DE| '],
    live: {
      'DE | GENERAL': ['ARD', 'ZDF', 'RTL', 'SAT.1', 'ProSieben', 'VOX', 'kabel eins', 'RTL II'],
      'DE | NEWS': ['tagesschau24', 'n-tv', 'WELT', 'phoenix'],
      'DE | SPORT': ['Sky Sport Bundesliga 1', 'Sport1', 'Eurosport 1', 'DAZN 1'],
      'DE | KIDS': ['KiKA', 'Super RTL', 'Nick'],
      'DE | DOKU': ['ARTE', '3sat', 'DMAX', 'N24 Doku'],
    },
    vod: ['DE | KINO 2024', 'DE | ACTION', 'DE | KOMÖDIE'],
    series: ['DE | SERIEN', 'DE | NETFLIX SERIEN'],
    vodPrefix: ['DE - ', 'DE | ', 'DE: '],
  },
  {
    key: 'UK', country: 'gb', language: 'en', words: 'en', epgSuffix: 'uk',
    styles: ['UK: ', 'UK | ', '[UK] ', 'UK - ', '🇬🇧 ', 'GB: '],
    live: {
      'UK ENTERTAINMENT': ['BBC One', 'BBC Two', 'ITV 1', 'Channel 4', 'Channel 5', 'Sky One', 'Dave'],
      'UK | NEWS': ['BBC News', 'Sky News', 'GB News'],
      'UK: SPORTS': ['Sky Sports Main Event', 'TNT Sports 1', 'Sky Sports F1'],
    },
    vod: ['UK | BRITISH MOVIES'],
    series: ['UK | BBC DRAMA'],
    vodPrefix: ['UK - ', 'UK: '],
  },
  {
    key: 'EN', country: null, language: 'en', words: 'en', epgSuffix: 'en',
    styles: ['|EN| ', 'EN | ', 'EN: ', '[EN] '],
    live: {
      '|EN| SPORTS': ['Sky Sports 1', 'ESPN', 'Eurosport'],
      '|EN| DOCUMENTARIES': ['Discovery Channel', 'National Geographic', 'History'],
    },
    vod: ['EN - Movies 2024', 'EN - Action', 'EN - Horror', 'EN - Kids & Family'],
    series: ['EN - TV Shows', 'EN - Netflix Originals'],
    vodPrefix: ['EN - ', 'EN | ', '|EN| '],
  },
  {
    key: 'FR', country: 'fr', language: 'fr', words: 'fr', epgSuffix: 'fr',
    styles: ['[FR] ', 'FR | ', 'FR: ', 'FR - ', '🇫🇷 '],
    live: {
      '[FR] GÉNÉRALISTE': ['TF1', 'France 2', 'France 3', 'M6', 'Canal+'],
      '[FR] SPORT': ['beIN Sports 1', 'RMC Sport 1', "L'Équipe"],
      '[FR] INFO': ['BFM TV', 'CNews', 'franceinfo'],
    },
    vod: ['[FR] FILMS', '[FR] FILMS 2024'],
    series: ['[FR] SÉRIES'],
    vodPrefix: ['FR - ', '[FR] '],
  },
  {
    key: 'NL', country: 'nl', language: 'nl', words: 'en', epgSuffix: 'nl',
    styles: ['NL - ', 'NL | ', 'NL: ', '[NL] '],
    live: {
      'NL - ALGEMEEN': ['NPO 1', 'NPO 2', 'RTL 4', 'SBS6'],
      'NL - SPORT': ['ESPN 1', 'Ziggo Sport'],
    },
    vod: ['NL - FILMS'],
    series: [],
    vodPrefix: ['NL - '],
  },
  {
    key: 'ES', country: 'es', language: 'es', words: 'es', epgSuffix: 'es',
    styles: ['ES ▎ ', 'ES | ', 'ES: ', '[ES] '],
    live: {
      'ES ▎ GENERALES': ['La 1', 'La 2', 'Antena 3', 'Cuatro', 'Telecinco'],
      'ES ▎ DEPORTES': ['Movistar LaLiga', 'DAZN LaLiga'],
    },
    vod: ['ES ▎ PELÍCULAS'],
    series: ['ES ▎ SERIES'],
    vodPrefix: ['ES - ', 'ES ▎ '],
  },
  {
    key: 'TR', country: 'tr', language: 'tr', words: 'tr', epgSuffix: 'tr',
    styles: ['TR: ', 'TR | ', '[TR] ', 'TR - '],
    live: {
      'TR: ULUSAL': ['TRT 1', 'Show TV', 'Star TV', 'ATV', 'Kanal D'],
      'TR: SPOR': ['beIN Sports Haber', 'TRT Spor'],
    },
    vod: ['TR: FILMLER'],
    series: ['TR: DIZILER'],
    vodPrefix: ['TR: ', 'TR - '],
  },
  {
    // "AR" on IPTV panels means Arabic language, not Argentina: no country.
    key: 'AR', country: null, language: 'ar', words: 'en', epgSuffix: 'ar',
    styles: ['AR | ', 'AR: ', 'ARABIC | ', '[AR] '],
    live: {
      'AR | MBC': ['MBC 1', 'MBC 2', 'MBC Drama'],
      'AR | NEWS': ['Al Jazeera', 'Al Arabiya', 'Sky News Arabia'],
    },
    vod: ['AR | AFLAM'],
    series: ['AR | MUSALSALAT'],
    vodPrefix: ['AR - ', 'AR | '],
  },
  {
    key: 'PL', country: 'pl', language: 'pl', words: 'en', epgSuffix: 'pl',
    styles: ['PL ● ', 'PL | ', 'PL: ', '[PL] '],
    live: {
      'PL ● OGÓLNE': ['TVP 1', 'TVP 2', 'Polsat', 'TVN'],
      'PL ● SPORT': ['Canal+ Sport', 'Polsat Sport'],
    },
    vod: ['PL ● FILMY'],
    series: ['PL ● SERIALE'],
    vodPrefix: ['PL - ', 'PL ● '],
  },
  {
    key: 'IT', country: 'it', language: 'it', words: 'en', epgSuffix: 'it',
    styles: ['IT: ', 'IT | ', '[IT] ', 'IT - '],
    live: {
      'IT | RAI & MEDIASET': ['Rai 1', 'Rai 2', 'Rai 3', 'Canale 5', 'Italia 1'],
      'IT | SPORT': ['Sky Sport Uno', 'DAZN 1 IT'],
    },
    vod: ['IT | FILM'],
    series: [],
    vodPrefix: ['IT - ', 'IT: '],
  },
  {
    key: 'PT', country: 'pt', language: 'pt', words: 'en', epgSuffix: 'pt',
    styles: ['PT | ', 'PT: ', '[PT] '],
    live: { 'PT | GERAL': ['RTP 1', 'SIC', 'TVI'] },
    vod: [],
    series: [],
    vodPrefix: ['PT - '],
  },
  {
    key: 'US', country: 'us', language: 'en', words: 'en', epgSuffix: 'us',
    styles: ['US| ', 'USA | ', 'US: ', '[US] '],
    live: {
      'USA | NETWORKS': ['ABC', 'CBS', 'NBC', 'FOX'],
      'USA | NEWS': ['CNN', 'Fox News', 'MSNBC'],
    },
    vod: [],
    series: ['USA | TV SHOWS'],
    vodPrefix: ['US - '],
  },
  {
    key: 'ALB', country: 'al', language: 'sq', words: 'en', epgSuffix: 'al',
    styles: ['ALB | ', 'AL | '],
    live: { 'ALB | SHQIP': ['Top Channel', 'Klan', 'RTSH 1'] },
    vod: [],
    series: [],
    vodPrefix: ['ALB - '],
  },
  {
    key: 'VIP', country: null, language: null, words: 'en', epgSuffix: 'vip',
    styles: ['VIP | '],
    live: { 'VIP | 4K': ['4K Movies', '4K Nature', 'UHD Events'] },
    vod: ['4K UHD MOVIES'],
    series: [],
    vodPrefix: [''],
  },
  {
    key: 'SPORTS', country: null, language: null, words: 'en', epgSuffix: 'int',
    styles: ['SPORTS | '],
    live: { 'SPORTS | beIN': ['beIN 1', 'beIN 2', 'beIN 3', 'beIN MAX 4'] },
    vod: [],
    series: [],
    vodPrefix: [''],
  },
  {
    key: 'NETFLIX', country: null, language: null, words: 'en', epgSuffix: 'int',
    styles: ['PPV '],
    live: { 'PPV EVENTS': ['EVENT 01', 'EVENT 02', 'EVENT 03', 'EVENT 04'] },
    vod: ['NETFLIX MOVIES (MULTI-SUB)'],
    series: ['NETFLIX SERIES (MULTI-SUB)'],
    vodPrefix: [''],
  },
  {
    key: 'XXX', country: null, language: null, adult: true, words: 'en', epgSuffix: 'xxx',
    styles: ['XXX | '],
    live: { 'XXX | Adult': ['Adult', 'Adult 2', 'Red Room'] },
    vod: ['XXX | Adult Movies'],
    series: [],
    vodPrefix: ['XXX - '],
  },
];

const VARIANTS = [
  ' HD', ' FHD', '', ' SD', ' 4K', ' HEVC', ' +1', ' (BACKUP)', ' RAW', ' UHD', ' H265', ' 50FPS',
  ' LOW', ' ᴴᴰ', ' HD²', ' FHD (MULTI-AUDIO)', ' HD [Geo]', ' SD (OLD)', ' VIP', ' HQ',
];

const WORDS: Record<Words, { adj: string[]; noun: string[]; the: string }> = {
  en: {
    the: 'The',
    adj: ['Silent', 'Last', 'Broken', 'Hidden', 'Golden', 'Dark', 'Lost', 'Final', 'Wild', 'Cold', 'Crimson', 'Endless'],
    noun: ['River', 'Empire', 'Horizon', 'Promise', 'Signal', 'Winter', 'Harbor', 'Witness', 'Kingdom', 'Frontier', 'Echo', 'Garden'],
  },
  de: {
    the: 'Der',
    adj: ['Stille', 'Letzte', 'Dunkle', 'Verlorene', 'Goldene', 'Kalte', 'Wilde', 'Geheime'],
    noun: ['Fluss', 'Sommer', 'Zeuge', 'Hafen', 'Wald', 'Schatten', 'Grenze', 'Winter'],
  },
  fr: {
    the: 'Le',
    adj: ['Dernier', 'Grand', 'Petit', 'Noir', 'Secret', 'Perdu'],
    noun: ['Voyage', 'Silence', 'Jardin', 'Rivage', 'Témoin', 'Hiver'],
  },
  es: {
    the: 'El',
    adj: ['Último', 'Oscuro', 'Perdido', 'Secreto', 'Dorado', 'Frío'],
    noun: ['Río', 'Invierno', 'Puerto', 'Testigo', 'Reino', 'Jardín'],
  },
  tr: {
    the: '',
    adj: ['Son', 'Kayıp', 'Karanlık', 'Gizli', 'Altın', 'Soğuk'],
    noun: ['Nehir', 'Kış', 'Liman', 'Tanık', 'Krallık', 'Bahçe'],
  },
};

const GENRES = ['Action', 'Drama', 'Comedy', 'Thriller', 'Documentary', 'Sci-Fi', 'Horror', 'Animation', 'Crime'];
const PEOPLE = ['Alex Morgan', 'Jamie Lee', 'Chris Novak', 'Sam Weber', 'Robin Kraus', 'Taylor Brooks', 'Mika Laine', 'Noa Peretz'];

// ---------------------------------------------------------------------------------------------
// Ground truth registry
// ---------------------------------------------------------------------------------------------

const globalTags = new Map<string, Tags>();
let defaultFullBuilt = false;

/**
 * Ground truth for a category or item name: what an ideal tagger should extract.
 * Covers every name of every catalog built in this process; unknown names fall back to the
 * default full catalog. Returns undefined for names the mock never produced.
 */
export function expectedTags(name: string): Tags | undefined {
  const hit = globalTags.get(name);
  if (hit || defaultFullBuilt) return hit;
  defaultFullBuilt = true;
  buildCatalog('full', DEFAULT_SEED);
  return globalTags.get(name);
}

function tagsOf(region: Region): Tags {
  return { country: region.country, language: region.language, adult: region.adult === true };
}

const NO_TAGS: Tags = { country: null, language: null, adult: false };

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\w]+/g, '')
    .toLowerCase();

/** Ids have small gaps, like real panels. Seed independent. */
const liveIdAt = (i: number): number => 1 + i * 3 + ((i * 7) % 3);
const movieIdAt = (i: number): number => 100000 + i * 3 + ((i * 5) % 3);
const seriesIdAt = (i: number): number => 1 + i * 2 + (i % 2);
const episodeIdFor = (seriesId: number, season: number, ep: number): number =>
  500000 + seriesId * 100 + (season - 1) * 12 + ep;

const ADDED_BASE = 1_640_000_000;

function makeCategories(
  names: { name: string; region: Region }[],
  firstId: number,
  tags: Map<string, Tags>,
): Category[] {
  return names.map(({ name, region }, i) => {
    const t = tagsOf(region);
    tags.set(name, t);
    return { category_id: String(firstId + i), category_name: name, parent_id: 0, tags: t };
  });
}

function prefixFor(rng: Rng, styles: string[]): string {
  const primary = styles[0] ?? '';
  return rng() < 0.85 || styles.length === 1 ? primary : pick(rng, styles.slice(1));
}

function titleFor(rng: Rng, words: Words): string {
  const w = WORDS[words];
  const core = `${pick(rng, w.adj)} ${pick(rng, w.noun)}`;
  const r = rng();
  if (r < 0.35 && w.the) return `${w.the} ${core}`;
  if (r < 0.5) return `${core} ${intBetween(rng, 2, 4)}`;
  return core;
}

function yearSuffix(rng: Rng, year: number): string {
  const r = rng();
  if (r < 0.6) return ` (${year})`;
  if (r < 0.75) return ` - ${year}`;
  if (r < 0.85) return ` [${year}]`;
  return '';
}

function buildLive(seed: number, count: number, tags: Map<string, Tags>, shape: Shape) {
  const catNames: { name: string; region: Region }[] = [];
  const bases: { region: Region; catIndex: number; base: string }[][] = [];
  for (const region of REGIONS) {
    const list: { region: Region; catIndex: number; base: string }[] = [];
    for (const [catName, names] of Object.entries(region.live)) {
      const catIndex = catNames.push({ name: catName, region }) - 1;
      for (const base of names) list.push({ region, catIndex, base });
    }
    bases.push(list);
  }
  // generated categories (huge): channels of a region spread over its categories
  const regionCats = new Map<Region, number[]>();
  catNames.forEach((c, i) => regionCats.set(c.region, [...(regionCats.get(c.region) ?? []), i]));
  for (let n = 0; shape.categories && catNames.length < shape.categories.live; n++) {
    const region = REGIONS[n % REGIONS.length]!;
    regionCats.get(region)!.push(catNames.push({ name: extraCategoryName(region, Math.floor(n / REGIONS.length)), region }) - 1);
  }
  const categories = makeCategories(catNames, shape.firstCategoryId.live, tags);

  // Interleave: variant -> base position -> region, so a small catalog still spans every region.
  const order: { region: Region; catIndex: number; base: string; variant: string; round: number }[] = [];
  const maxBases = Math.max(...bases.map((b) => b.length));
  // Each base cycles through every variant once (rotated by base position) before numbering kicks in.
  for (let round = 0; order.length < count; round++) {
    for (let b = 0; b < maxBases && order.length < count; b++) {
      const variant =
        round < VARIANTS.length ? (VARIANTS[(round + b) % VARIANTS.length] ?? '') : ` (${round - VARIANTS.length + 2})`;
      for (const list of bases) {
        const entry = list[b];
        if (entry && order.length < count) order.push({ ...entry, variant, round });
      }
    }
  }

  const channels: LiveChannel[] = order.map((o, i) => {
    const rng = rngFor(seed, `live:${i}`);
    // The plain variant always uses the region's primary style ("PL ● TVP 1"); others vary.
    const prefix = o.variant === '' ? (o.region.styles[0] ?? '') : prefixFor(rng, o.region.styles);
    const name = `${prefix}${o.base}${o.variant}`.trimEnd();
    const t = tagsOf(o.region);
    tags.set(name, t);
    const epgRoll = rng();
    // huge: variants of a base share an id in groups of four ("ard.de", "ard-2.de", ...); real: one id per channel
    const group = shape.uniqueEpg && o.round >= shape.epgGroup ? `-${Math.floor(o.round / shape.epgGroup) + 1}` : '';
    const epgChannelId =
      epgRoll < shape.noEpg * 0.6 ? null : epgRoll < shape.noEpg ? '' : `${slug(o.base)}${group}.${o.region.epgSuffix}`;
    const archiveRoll = rng();
    const id = liveIdAt(i);
    const cats = regionCats.get(o.region)!;
    const catIndex = shape.categories && o.round > 0 ? cats[(i * 7919) % cats.length]! : o.catIndex;
    const category = categories[catIndex];
    const icon = rng() < 0.1 ? null : `${slug(o.base)}`;
    const archiveDays = shape.archiveDays(archiveRoll, rng);
    const archive = archiveDays > 0;
    return {
      index: i,
      id,
      num: i + 1,
      name,
      categoryId: category?.category_id ?? '1',
      icon,
      epgChannelId,
      // huge: about a fifth of the epg ids have no programmes, like real guides
      epgListed: !shape.epgGaps || !epgChannelId || hashString(epgChannelId) % 5 !== 0,
      archive,
      archiveDays,
      added: ADDED_BASE + Math.floor(rng() * 60_000_000),
      customSid: rng() < 0.8 ? '' : `:0:1:${(id * 37).toString(16).toUpperCase()}:0:0:0:0:0:0:`,
      profile: liveProfileForIndex(i),
      tags: t,
    };
  });
  return { categories, channels };
}

function vodCategoryList(kind: 'vod' | 'series', total: number | null): { name: string; region: Region }[] {
  const out: { name: string; region: Region }[] = [];
  for (const region of REGIONS) for (const name of region[kind]) out.push({ name, region });
  // generated categories only for regions that have this kind at all
  const regions = REGIONS.filter((r) => r[kind].length > 0);
  for (let n = 0; total !== null && out.length < total; n++) {
    const region = regions[n % regions.length]!;
    out.push({ name: extraCategoryName(region, Math.floor(n / regions.length), kind === 'vod' ? ' MOVIES' : ' SERIES'), region });
  }
  return out;
}

function itemName(rng: Rng, region: Region, title: string, year: number, categoryName: string): string {
  const prefix = pick(rng, region.vodPrefix);
  let name = `${prefix}${title}${yearSuffix(rng, year)}`;
  if (categoryName.includes('MULTI-SUB')) name += ' [MULTI-SUB]';
  if (categoryName.startsWith('4K')) name += ' 4K';
  return name;
}

function buildMovies(seed: number, count: number, tags: Map<string, Tags>, shape: Shape) {
  const catList = vodCategoryList('vod', shape.categories?.vod ?? null);
  const categories = makeCategories(catList, shape.firstCategoryId.vod, tags);
  const movies: Movie[] = [];
  for (let i = 0; i < count; i++) {
    const rng = rngFor(seed, `movie:${i}`);
    const c = catList[i % catList.length];
    const category = categories[i % categories.length];
    if (!c || !category) throw new Error('no vod categories');
    const year = intBetween(rng, 1985, 2025);
    const title = titleFor(rng, c.region.words);
    const name = itemName(rng, c.region, title, year, c.name);
    const t = c.region.vodPrefix.every((p) => p === '') ? NO_TAGS : tagsOf(c.region);
    tags.set(name, t);
    const id = movieIdAt(i);
    const ratingNum = Math.round((4 + rng() * 5) * 10) / 10;
    const ratingRoll = rng();
    movies.push({
      index: i,
      id,
      num: i + 1,
      name,
      title,
      year,
      categoryId: category.category_id,
      icon: rng() < 0.08 ? null : `movie-${id}`,
      added: ADDED_BASE + Math.floor(rng() * 60_000_000),
      rating: ratingRoll < 0.1 ? '' : ratingRoll < 0.3 ? ratingNum : String(ratingNum),
      plot: `${title} is a deterministic mock film about a ${pick(rng, WORDS.en.noun).toLowerCase()}.`,
      genre: `${pick(rng, GENRES)}, ${pick(rng, GENRES)}`,
      director: pick(rng, PEOPLE),
      cast: [pick(rng, PEOPLE), pick(rng, PEOPLE), pick(rng, PEOPLE)].join(', '),
      tmdbId: rng() < 0.15 ? '' : String(10000 + Math.floor(rng() * 900000)),
      durationSecs: vodDurationForId(id),
      profile: vodProfileForIndex(i),
      tags: t,
    });
  }
  return { categories, movies };
}

function buildSeries(seed: number, count: number, tags: Map<string, Tags>, shape: Shape) {
  const catList = vodCategoryList('series', shape.categories?.series ?? null);
  const categories = makeCategories(catList, shape.firstCategoryId.series, tags);
  const series: Series[] = [];
  for (let i = 0; i < count; i++) {
    const rng = rngFor(seed, `series:${i}`);
    // Structure (seasons/episodes) is seed independent so episode ids are stable.
    const srng = rngFor(0, `series-structure:${i}`);
    const c = catList[i % catList.length];
    const category = categories[i % categories.length];
    if (!c || !category) throw new Error('no series categories');
    const year = intBetween(rng, 1995, 2025);
    const title = titleFor(rng, c.region.words);
    const name = itemName(rng, c.region, title, year, c.name);
    const t = c.region.vodPrefix.every((p) => p === '') ? NO_TAGS : tagsOf(c.region);
    tags.set(name, t);
    const id = seriesIdAt(i);
    const seasonCount = intBetween(srng, 1, 4);
    const seasons: Episode[][] = [];
    let ordinal = 0;
    for (let s = 1; s <= seasonCount; s++) {
      const eps: Episode[] = [];
      const epCount = intBetween(srng, 3, 10);
      for (let e = 1; e <= epCount; e++) {
        const epId = episodeIdFor(id, s, e);
        const epTitle = titleFor(rng, c.region.words);
        eps.push({
          id: epId,
          seriesId: id,
          season: s,
          episodeNum: e,
          title: `${name} - S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')} - ${epTitle}`,
          plot: `Episode ${e} of season ${s}: ${epTitle}.`,
          added: ADDED_BASE + Math.floor(rng() * 60_000_000),
          durationSecs: vodDurationForId(epId),
          profile: vodProfileForIndex(i + ordinal),
        });
        ordinal++;
      }
      seasons.push(eps);
    }
    series.push({
      index: i,
      id,
      num: i + 1,
      name,
      categoryId: category.category_id,
      icon: rng() < 0.08 ? null : `series-${id}`,
      plot: `${title}: a deterministic mock series.`,
      cast: [pick(rng, PEOPLE), pick(rng, PEOPLE)].join(', '),
      director: pick(rng, PEOPLE),
      genre: pick(rng, GENRES),
      releaseDate: `${year}-${String(intBetween(rng, 1, 12)).padStart(2, '0')}-${String(intBetween(rng, 1, 28)).padStart(2, '0')}`,
      lastModified: ADDED_BASE + Math.floor(rng() * 60_000_000),
      rating: String(Math.round((5 + rng() * 4) * 10) / 10),
      year,
      seasons,
      tags: t,
    });
  }
  return { categories, series };
}

export function buildCatalog(size: CatalogSize = 'full', seed: number = DEFAULT_SEED): Catalog {
  const counts = SIZES[size];
  const tags = new Map<string, Tags>();
  const shape = SHAPES[size];
  const live = buildLive(seed, counts.live, tags, shape);
  const vod = buildMovies(seed, counts.movies, tags, shape);
  const ser = buildSeries(seed, counts.series, tags, shape);
  for (const [k, v] of tags) globalTags.set(k, v);
  if (size === 'full' && seed === DEFAULT_SEED) defaultFullBuilt = true;

  const episodeById = new Map<number, Episode>();
  for (const s of ser.series) for (const season of s.seasons) for (const e of season) episodeById.set(e.id, e);

  return {
    size,
    seed,
    liveCategories: live.categories,
    vodCategories: vod.categories,
    seriesCategories: ser.categories,
    live: live.channels,
    movies: vod.movies,
    series: ser.series,
    liveById: new Map(live.channels.map((c) => [c.id, c])),
    movieById: new Map(vod.movies.map((m) => [m.id, m])),
    seriesById: new Map(ser.series.map((s) => [s.id, s])),
    episodeById,
    tags,
  };
}
