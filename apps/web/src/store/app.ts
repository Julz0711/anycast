/** Global app state (zustand). Actions live in ./actions.ts. */
import { create } from 'zustand';
import { DEFAULT_PREFERENCES, type ChannelList, type Favorite, type HideRules, type MediaList, type Me, type Preferences, type Progress } from '@anycast/shared';
import type { DeviceOverride } from '../lib/device';
import { readLocal } from '../lib/storage';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export interface AppState {
  auth: 'unknown' | 'anon' | 'authed';
  me: Me | null;
  profileId: string | null;
  prefs: Preferences;
  /** true once prefs for the current profile came from the server */
  prefsLoaded: boolean;
  favorites: Favorite[];
  progress: Record<string, Progress>;
  hideRules: HideRules;
  hideRulesLoaded: boolean;
  /** the profile's channel lists, in the user's order (LB-3) */
  lists: ChannelList[];
  listsLoaded: boolean;
  /** the profile's movie and series lists, Watch Later first */
  mediaLists: MediaList[];
  mediaListsLoaded: boolean;
  /** the channel, movie or series the "Add to list" sheet is open for */
  addToList: AddToListTarget | null;
  /** bumps when the catalog or hide rules change, so lists refetch */
  catalogVersion: number;
  deviceOverride: DeviceOverride;
  /** channel ids of the list the viewer last opened a channel from, for up/down zapping */
  zapList: string[];
  toasts: Toast[];
  online: boolean;
  /** set when another device took over this tab's provider connection (SSE 'playback-stopped') */
  playbackStopped: { by: { profileName: string; device?: string }; at: number } | null;
}

export interface AddToListTarget { kind: 'live' | 'movie' | 'series'; id: string; name: string }

export const EMPTY_RULES: HideRules = { countries: [], languages: [], categoryIds: [] };

export const useApp = create<AppState>(() => ({
  auth: 'unknown',
  me: null,
  profileId: null,
  prefs: DEFAULT_PREFERENCES,
  prefsLoaded: false,
  favorites: [],
  progress: {},
  hideRules: EMPTY_RULES,
  hideRulesLoaded: false,
  lists: [],
  listsLoaded: false,
  mediaLists: [],
  mediaListsLoaded: false,
  addToList: null,
  catalogVersion: 0,
  deviceOverride: (readLocal('anycast.device') as DeviceOverride | null) ?? 'auto',
  zapList: [],
  toasts: [],
  online: true,
  playbackStopped: null,
}));

export const progressKey = (kind: Progress['kind'], id: string) => `${kind}:${id}`;

export function useIsFavorite(kind: Favorite['kind'], id: string): boolean {
  return useApp((s) => s.favorites.some((f) => f.kind === kind && f.id === id));
}

export function useProgress(kind: Progress['kind'], id: string): Progress | undefined {
  return useApp((s) => s.progress[progressKey(kind, id)]);
}
