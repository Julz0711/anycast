/** User preferences. Synced per profile across devices. Every field has a default. */

export const ACCENTS = {
  amber: { name: 'Amber', hex: '#F5A524' },
  coral: { name: 'Coral', hex: '#FF7A6B' },
  rose: { name: 'Rose', hex: '#FF6FA8' },
  orchid: { name: 'Orchid', hex: '#D58CFF' },
  violet: { name: 'Violet', hex: '#A99BFF' },
  sky: { name: 'Sky', hex: '#5CB8FF' },
  aqua: { name: 'Aqua', hex: '#3DD6D0' },
  mint: { name: 'Mint', hex: '#5EE08A' },
  lime: { name: 'Lime', hex: '#B8E04A' },
  sand: { name: 'Sand', hex: '#E8CFA0' },
} as const;
export type AccentId = keyof typeof ACCENTS;

export type TabId = 'home' | 'search' | 'live' | 'movies' | 'series' | 'library';
/** Every main tab, in the default order. Phones leave Search out of the tab bar (a button on each page). */
export const ALL_TABS: readonly TabId[] = ['home', 'search', 'live', 'movies', 'series', 'library'];
/** Favorites and Lists were tabs of their own before Library held both. */
const LIBRARY_PARTS: readonly string[] = ['favorites', 'lists'];
const asTab = (t: unknown): TabId | null => (LIBRARY_PARTS.includes(t as string) ? 'library' : ALL_TABS.includes(t as TabId) ? (t as TabId) : null);

/** The sections of the Home dashboard. */
export type HomeSectionId = 'continue' | 'recap' | 'newEpisodes' | 'recent' | 'next' | 'favorites' | 'watchLater';
/** Every Home section, in the default order. */
export const ALL_HOME_SECTIONS: readonly HomeSectionId[] = ['continue', 'recap', 'newEpisodes', 'recent', 'next', 'favorites', 'watchLater'];

/**
 * A saved Home section order made valid: unknown and repeated ids dropped, and missing sections
 * (new ones too) added right after the section that comes before them in the default order.
 */
export function normalizeHomeSections(order: unknown): HomeSectionId[] {
  const out: HomeSectionId[] = [];
  for (const t of Array.isArray(order) ? order : []) if (ALL_HOME_SECTIONS.includes(t as HomeSectionId) && !out.includes(t as HomeSectionId)) out.push(t as HomeSectionId);
  ALL_HOME_SECTIONS.forEach((t, i) => {
    if (out.includes(t)) return;
    const prev = i > 0 ? out.indexOf(ALL_HOME_SECTIONS[i - 1]!) : -1;
    out.splice(prev + 1, 0, t);
  });
  return out;
}

/** Earlier default orders. A saved order equal to one of them was never changed by the user, so it follows the new default. */
const OLD_DEFAULT_ORDERS: readonly (readonly string[])[] = [
  ['live', 'movies', 'series', 'search'],
  ['live', 'favorites', 'movies', 'series', 'search'],
  ['search', 'favorites', 'lists', 'live', 'movies', 'series'],
  ['home', 'search', 'favorites', 'lists', 'live', 'movies', 'series'],
];

/**
 * A saved tab order made valid: unknown and repeated ids dropped, missing tabs added in default order.
 * An untouched old default becomes the current default. Favorites and Lists become Library, at the
 * place of the first of them; orders saved before Home existed get it first.
 */
export function normalizeTabOrder(order: unknown): TabId[] {
  if (Array.isArray(order) && OLD_DEFAULT_ORDERS.some((d) => d.length === order.length && d.every((t, i) => order[i] === t))) return [...ALL_TABS];
  const out: TabId[] = [];
  for (const t of Array.isArray(order) ? order : []) {
    const id = asTab(t);
    if (id && !out.includes(id)) out.push(id);
  }
  if (!out.length) return [...ALL_TABS];
  for (const t of ALL_TABS) if (t !== 'home' && !out.includes(t)) out.push(t);
  if (!out.includes('home')) out.unshift('home');
  return out;
}

/** Saved hidden tabs made valid: Library is hidden when it is, or when both Favorites and Lists were. */
export function normalizeHiddenTabs(hidden: unknown, order: readonly TabId[]): TabId[] {
  if (!Array.isArray(hidden)) return [];
  const has = (t: string) => hidden.includes(t);
  const out = new Set<TabId>();
  for (const t of hidden) {
    const id = asTab(t);
    if (id && id !== 'library') out.add(id);
  }
  if (has('library') || (has('favorites') && has('lists'))) out.add('library');
  return order.filter((t) => out.has(t));
}

export interface Preferences {
  appearance: {
    accent: AccentId;
    theme: 'dark' | 'black' | 'dim';
    textSize: 'small' | 'medium' | 'large' | 'xlarge';
    density: 'comfortable' | 'compact';
    showArtwork: boolean;
    animations: 'full' | 'reduced' | 'off';
  };
  live: {
    /** Simple = channel list with now/next; Extended = EPG guide grid */
    layoutPhone: 'simple' | 'extended';
    layoutLarge: 'simple' | 'extended';
    layoutTv: 'simple' | 'extended';
    showChannelNumbers: boolean;
    showLogos: boolean;
    showProgress: boolean;
    reopenLastChannel: boolean;
    guideHoursVisible: 2 | 3 | 4 | 6;
    /** Live TV lists and the guide show only channels that have guide data */
    guideOnlyWithEpg: boolean;
    /** one row per channel when the provider has it in several versions (HD, FHD, RAW…) */
    mergeVariants: boolean;
  };
  player: {
    skipBackSeconds: 5 | 10 | 15 | 30;
    skipForwardSeconds: 10 | 15 | 30 | 60;
    timelineStyle: 'ribbon' | 'bar';
    autoplayNext: boolean;
    autoplayCountdown: number;
    /** leaving the player keeps the stream playing in a small window while you browse */
    miniPlayer: boolean;
    /**
     * off: no subtitles unless chosen for the item; on: always, in the preferred subtitle language
     * when there is one; auto: only when the audio is not in the preferred subtitle language
     */
    subtitlesDefault: 'off' | 'auto' | 'on';
    /** ISO 639-1; picked automatically when a stream has several audio tracks. null: the stream's default */
    preferredAudioLanguage: string | null;
    /** ISO 639-1; null: the stream's default subtitle track, else the first one */
    preferredSubtitleLanguage: string | null;
  };
  start: {
    startTab: TabId;
    tabOrder: TabId[];
    hiddenTabs: TabId[];
  };
  /** The Home dashboard */
  home: {
    /** every section, in the user's order */
    sections: HomeSectionId[];
    hiddenSections: HomeSectionId[];
    /** a large "pick up where you left off" card above the sections */
    showHero: boolean;
    /** Favorite channels: only the ones with guide data (what's on now) */
    favoritesWithGuideOnly: boolean;
    /** most cards a row shows before "See all" */
    rowLimit: 6 | 12 | 24;
  };
  /** Category chips: pinned categories (ids of every kind, in the user's order) come first */
  categories: {
    pinned: string[];
  };
  /** Watch history: what played and for how long, for the recap */
  history: {
    record: boolean;
  };
  settingsMode: 'basic' | 'all';
  /** First-run setup (language filter) finished or skipped for this profile */
  setupDone: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  appearance: {
    accent: 'amber',
    theme: 'dark',
    textSize: 'medium',
    density: 'comfortable',
    showArtwork: true,
    animations: 'full',
  },
  live: {
    layoutPhone: 'simple',
    layoutLarge: 'extended',
    layoutTv: 'extended',
    showChannelNumbers: true,
    showLogos: true,
    showProgress: true,
    reopenLastChannel: false,
    guideHoursVisible: 3,
    guideOnlyWithEpg: false,
    mergeVariants: true,
  },
  player: {
    skipBackSeconds: 10,
    skipForwardSeconds: 30,
    timelineStyle: 'ribbon',
    autoplayNext: true,
    autoplayCountdown: 10,
    miniPlayer: true,
    subtitlesDefault: 'off',
    preferredAudioLanguage: 'en',
    preferredSubtitleLanguage: null,
  },
  start: {
    startTab: 'home',
    tabOrder: [...ALL_TABS],
    hiddenTabs: [],
  },
  home: {
    sections: [...ALL_HOME_SECTIONS],
    hiddenSections: [],
    showHero: true,
    favoritesWithGuideOnly: false,
    rowLimit: 12,
  },
  categories: {
    pinned: [],
  },
  history: {
    record: true,
  },
  settingsMode: 'basic',
  setupDone: false,
};

/** Deep-merge a partial preferences object over defaults (unknown keys dropped). */
export function mergePreferences(partial: unknown): Preferences {
  const out = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, Record<string, unknown> | unknown>;
  if (!partial || typeof partial !== 'object') return out as unknown as Preferences;
  for (const [section, value] of Object.entries(partial as Record<string, unknown>)) {
    if (!(section in out)) continue;
    const base = out[section];
    if (base && typeof base === 'object' && !Array.isArray(base) && value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k in (base as Record<string, unknown>) && v !== undefined) (base as Record<string, unknown>)[k] = v;
      }
    } else if (typeof value === typeof base) {
      out[section] = value;
    }
  }
  const prefs = out as unknown as Preferences;
  const start = prefs.start;
  start.tabOrder = normalizeTabOrder(start.tabOrder);
  start.hiddenTabs = normalizeHiddenTabs(start.hiddenTabs, start.tabOrder);
  start.startTab = asTab(start.startTab) ?? DEFAULT_PREFERENCES.start.startTab;
  // Saved before Home existed, still on the old default start tab: open on Home from now on.
  const raw = partial as Record<string, unknown>;
  const savedStart = raw.start as Record<string, unknown> | undefined;
  if (!('home' in raw) && savedStart && savedStart.startTab === 'live') start.startTab = 'home';
  const home = prefs.home;
  home.sections = normalizeHomeSections(home.sections);
  home.hiddenSections = Array.isArray(home.hiddenSections) ? home.sections.filter((t) => home.hiddenSections.includes(t)) : [];
  if (![6, 12, 24].includes(home.rowLimit)) home.rowLimit = DEFAULT_PREFERENCES.home.rowLimit;
  const pinned = prefs.categories.pinned;
  prefs.categories.pinned = Array.isArray(pinned) ? [...new Set(pinned.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))].slice(0, 200) : [];
  return prefs;
}
