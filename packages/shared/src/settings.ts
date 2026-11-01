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

export type TabId = 'live' | 'movies' | 'series' | 'search';

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
  };
  player: {
    skipBackSeconds: 5 | 10 | 15 | 30;
    skipForwardSeconds: 10 | 15 | 30 | 60;
    timelineStyle: 'ribbon' | 'bar';
    autoplayNext: boolean;
    autoplayCountdown: number;
    subtitlesDefault: 'off' | 'auto' | 'on';
    preferredAudioLanguage: string | null;
    preferredSubtitleLanguage: string | null;
  };
  start: {
    startTab: TabId;
    tabOrder: TabId[];
    hiddenTabs: TabId[];
  };
  settingsMode: 'basic' | 'all';
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
  },
  player: {
    skipBackSeconds: 10,
    skipForwardSeconds: 30,
    timelineStyle: 'ribbon',
    autoplayNext: true,
    autoplayCountdown: 10,
    subtitlesDefault: 'auto',
    preferredAudioLanguage: null,
    preferredSubtitleLanguage: null,
  },
  start: {
    startTab: 'live',
    tabOrder: ['live', 'movies', 'series', 'search'],
    hiddenTabs: [],
  },
  settingsMode: 'basic',
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
  return out as unknown as Preferences;
}
