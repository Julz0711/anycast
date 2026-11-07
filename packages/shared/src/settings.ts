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

export type TabId = 'home' | 'search' | 'favorites' | 'lists' | 'live' | 'movies' | 'series';
/** Every main tab, in the default order. */
export const ALL_TABS: readonly TabId[] = ['home', 'search', 'favorites', 'lists', 'live', 'movies', 'series'];

/** The sections of the Home dashboard. */
export type HomeSectionId = 'continue' | 'recent' | 'next' | 'favorites' | 'watchLater';
/** Every Home section, in the default order. */
export const ALL_HOME_SECTIONS: readonly HomeSectionId[] = ['continue', 'recent', 'next', 'favorites', 'watchLater'];

/** A saved Home section order made valid: unknown and repeated ids dropped, missing sections added at the end in default order. */
export function normalizeHomeSections(order: unknown): HomeSectionId[] {
  const out: HomeSectionId[] = [];
  for (const t of Array.isArray(order) ? order : []) if (ALL_HOME_SECTIONS.includes(t as HomeSectionId) && !out.includes(t as HomeSectionId)) out.push(t as HomeSectionId);
  for (const t of ALL_HOME_SECTIONS) if (!out.includes(t)) out.push(t);
  return out;
}

/** Earlier default orders. A saved order equal to one of them was never changed by the user, so it follows the new default. */
const OLD_DEFAULT_ORDERS: readonly (readonly string[])[] = [
  ['live', 'movies', 'series', 'search'],
  ['live', 'favorites', 'movies', 'series', 'search'],
  ['search', 'favorites', 'lists', 'live', 'movies', 'series'],
];

/**
 * A saved tab order made valid: unknown and repeated ids dropped, missing tabs added in default order.
 * An untouched old default becomes the current default. Orders saved before Favorites existed get it
 * right after Live TV; orders saved before Lists existed get it right after Favorites; orders saved
 * before Home existed get it first.
 */
export function normalizeTabOrder(order: unknown): TabId[] {
  if (Array.isArray(order) && OLD_DEFAULT_ORDERS.some((d) => d.length === order.length && d.every((t, i) => order[i] === t))) return [...ALL_TABS];
  const out: TabId[] = [];
  for (const t of Array.isArray(order) ? order : []) if (ALL_TABS.includes(t as TabId) && !out.includes(t as TabId)) out.push(t as TabId);
  if (!out.length) return [...ALL_TABS];
  for (const t of ALL_TABS) if (t !== 'home' && t !== 'favorites' && t !== 'lists' && !out.includes(t)) out.push(t);
  if (!out.includes('favorites')) out.splice(out.indexOf('live') + 1, 0, 'favorites');
  if (!out.includes('lists')) out.splice(out.indexOf('favorites') + 1, 0, 'lists');
  if (!out.includes('home')) out.unshift('home');
  return out;
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
  };
  player: {
    skipBackSeconds: 5 | 10 | 15 | 30;
    skipForwardSeconds: 10 | 15 | 30 | 60;
    timelineStyle: 'ribbon' | 'bar';
    autoplayNext: boolean;
    autoplayCountdown: number;
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
  },
  player: {
    skipBackSeconds: 10,
    skipForwardSeconds: 30,
    timelineStyle: 'ribbon',
    autoplayNext: true,
    autoplayCountdown: 10,
    subtitlesDefault: 'off',
    preferredAudioLanguage: 'en',
    preferredSubtitleLanguage: null,
  },
  start: {
    startTab: 'home',
    tabOrder: ['home', 'search', 'favorites', 'lists', 'live', 'movies', 'series'],
    hiddenTabs: [],
  },
  home: {
    sections: ['continue', 'recent', 'next', 'favorites', 'watchLater'],
    hiddenSections: [],
    showHero: true,
    favoritesWithGuideOnly: false,
    rowLimit: 12,
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
  start.hiddenTabs = Array.isArray(start.hiddenTabs) ? start.tabOrder.filter((t) => start.hiddenTabs.includes(t)) : [];
  if (!ALL_TABS.includes(start.startTab)) start.startTab = DEFAULT_PREFERENCES.start.startTab;
  // Saved before Home existed, still on the old default start tab: open on Home from now on.
  const raw = partial as Record<string, unknown>;
  const savedStart = raw.start as Record<string, unknown> | undefined;
  if (!('home' in raw) && savedStart && savedStart.startTab === 'live') start.startTab = 'home';
  const home = prefs.home;
  home.sections = normalizeHomeSections(home.sections);
  home.hiddenSections = Array.isArray(home.hiddenSections) ? home.sections.filter((t) => home.hiddenSections.includes(t)) : [];
  if (![6, 12, 24].includes(home.rowLimit)) home.rowLimit = DEFAULT_PREFERENCES.home.rowLimit;
  return prefs;
}
