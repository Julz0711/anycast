/**
 * HTTP API contract between apps/web and apps/server. All routes are under /api.
 * Auth: POST /api/auth/login sets an httpOnly cookie "anycast_session" (90 days).
 * Every route except /api/auth/login and /api/health requires the session cookie.
 * Profile: requests carry header "x-anycast-profile: <profileId>" (defaults to the user's first profile).
 *
 * Artwork: logo/poster fields are /api/art/{kind}/{id} paths (provider hosts never reach the client).
 * Realtime: GET /api/events?profile=<id> is a Server-Sent Events stream (EventSource cannot send headers). Events are SyncEvent JSON in `data:`.
 */
import type {
  Category, Channel, EpgProgram, Episode, Favorite, HideRules, ItemRef, Movie, PlaybackInfo,
  Progress, Series, SeriesDetail, TimelineInfo,
} from './catalog';
import type { Preferences } from './settings';

export interface Profile { id: string; name: string; }

export interface Me {
  user: { id: string; username: string; isAdmin: boolean };
  profiles: Profile[];
}

export interface SourceStatus {
  configured: boolean;
  /** never includes credentials or the provider URL */
  account: {
    status: string;
    expiresAt: number | null;
    maxConnections: number | null;
    activeConnections: number | null;
  } | null;
  lastSync: { catalog: number | null; epg: number | null };
  syncing: boolean;
  counts: { live: number; movie: number; series: number };
}

export interface Page<T> { items: T[]; total: number; }

export interface LiveChannelWithNow extends Channel {
  now: EpgProgram | null;
  next: EpgProgram | null;
}

export interface SearchResults {
  live: Channel[];
  movies: Movie[];
  series: Series[];
}

export interface TagSummary { country: string | null; language: string | null; count: number; }

export type SyncEvent =
  | { type: 'favorites'; profileId: string; favorites: Favorite[] }
  | { type: 'progress'; profileId: string; progress: Progress }
  | { type: 'preferences'; profileId: string; preferences: Preferences }
  | { type: 'hide-rules'; profileId: string; rules: HideRules }
  | { type: 'catalog-updated' };

/** Route table (method + path -> request/response). Documentation as code. */
export interface Api {
  'GET /api/health': { res: { ok: true; version: string } };
  'POST /api/auth/login': { body: { username: string; password: string }; res: Me };
  'POST /api/auth/logout': { res: { ok: true } };
  'GET /api/me': { res: Me };

  /** Profiles share the user's login and the one Xtream source; each has its own favorites, progress, preferences and hide rules */
  'GET /api/profiles': { res: Profile[] };
  'POST /api/profiles': { body: { name: string }; res: Profile };
  'PATCH /api/profiles/:id': { body: { name: string }; res: Profile };
  /** cannot delete the last profile */
  'DELETE /api/profiles/:id': { res: { ok: true } };

  'GET /api/source': { res: SourceStatus };
  'POST /api/source/sync': { res: { ok: true } };

  /** all=1 includes categories hidden by the profile's rules (for Settings) */
  'GET /api/categories': { query: { kind: 'live' | 'movie' | 'series'; all?: '1' }; res: Category[] };
  'GET /api/tags': { res: { countries: TagSummary[]; languages: TagSummary[] } };

  /** hidden items already filtered out for the current profile */
  'GET /api/live': { query: { categoryId?: string; offset?: number; limit?: number }; res: Page<LiveChannelWithNow> };
  'GET /api/epg': { query: { channelIds: string; from: number; to: number }; res: Record<string, EpgProgram[]> };
  'GET /api/movies': { query: { categoryId?: string; offset?: number; limit?: number }; res: Page<Movie> };
  'GET /api/series': { query: { categoryId?: string; offset?: number; limit?: number }; res: Page<Series> };
  'GET /api/series/:id': { res: SeriesDetail };
  'GET /api/search': { query: { q: string }; res: SearchResults };

  'GET /api/play/live/:id': { res: PlaybackInfo };
  /** at = epoch ms; returns a stream starting at that time (archive or buffer) */
  'GET /api/play/live/:id/at': { query: { at: number }; res: PlaybackInfo };
  'GET /api/timeline/:channelId': { res: TimelineInfo };
  'GET /api/play/movie/:id': { res: PlaybackInfo };
  'GET /api/play/episode/:id': { res: PlaybackInfo };

  'GET /api/favorites': { res: Favorite[] };
  'PUT /api/favorites': { body: { kind: Favorite['kind']; id: string; favorite: boolean }; res: Favorite[] };
  'GET /api/progress': { res: Progress[] };
  'PUT /api/progress': { body: Omit<Progress, 'updatedAt' | 'finished'>; res: Progress };
  'GET /api/continue': { res: { movies: (Movie & { progress: Progress })[]; episodes: (Episode & { progress: Progress; series: Series })[] } };
  'GET /api/preferences': { res: Preferences };
  'PUT /api/preferences': { body: Partial<Preferences>; res: Preferences };
  'GET /api/hide-rules': { res: HideRules };
  'PUT /api/hide-rules': { body: HideRules; res: HideRules };
}

export type { ItemRef, Episode };

/** Over this fraction watched counts as finished (CT-2) */
export const FINISHED_THRESHOLD = 0.95;
