/**
 * HTTP API contract between apps/web and apps/server. All routes are under /api.
 * Auth: POST /api/auth/login sets an httpOnly cookie "anycast_session" (90 days).
 * Every route except /api/auth/login and /api/health requires the session cookie.
 * Profile: requests carry header "x-anycast-profile: <profileId>" (defaults to the user's first profile).
 *
 * Artwork: logo/poster fields are /api/art/{kind}/{id} paths (provider hosts never reach the client).
 * Realtime: GET /api/events?profile=<id> is a Server-Sent Events stream (EventSource cannot send headers). Events are SyncEvent JSON in `data:`.
 *
 * Playback clients: requests to /api/play/* carry "x-anycast-client: <id>" (one id per app instance, e.g. per tab) and
 * "x-anycast-device: <label>" (e.g. "Chrome on Mac"). The server uses them to release a client's previous stream as soon as
 * it asks for the next one (zapping never holds two provider connections) and to say who holds a busy connection.
 */
import type {
  Category, Channel, EpgProgram, Episode, Favorite, HideRules, ItemRef, Movie, PlaybackInfo,
  Progress, Series, SeriesDetail, TimelineInfo,
} from './catalog';
import type { AdultMode, AdultStatus, UnlockMinutes } from './parental';
import type { Preferences } from './settings';
import type { TrackChoice } from './tracks';

export interface Profile { id: string; name: string; }

/**
 * A profile's own named, ordered list of live channels ("News", "Sport", "Kids"), LB-3.
 * `channelIds` is in the user's order. Lists ignore hide rules: a channel the user put in a list
 * stays in it (and visible there) even when its country, language or group is hidden.
 */
export interface ChannelList { id: string; name: string; channelIds: string[] }
export const CHANNEL_LIST_LIMITS = { lists: 100, channels: 2000, name: 60 } as const;

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

export interface BufferPins { channelIds: string[]; maxPins: number | null }
export interface BufferChannelStatus {
  channelId: string; name: string | null; pinned: boolean; recording: boolean;
  ranges: { start: number; end: number }[]; durationMs: number; bytes: number;
}
export interface BufferStatus {
  enabled: boolean; channels: BufferChannelStatus[]; totalBytes: number;
  caps: { maxHoursPerChannel: number; maxBytes: number; maxPins: number | null };
}

/**
 * Scrub thumbnails of a movie or episode (PB-1). Each tile is the frame at `start` seconds (it
 * covers start .. start + interval), cut out of a sprite sheet: show `url` as a background at
 * -x/-y with size w x h. Only parts that were played somewhere have tiles; the list grows while
 * playing, and a sheet's `url` changes (?v=) when tiles are added to it.
 */
export interface ThumbTile { start: number; url: string; x: number; y: number; w: number; h: number }
export interface ThumbIndex {
  /** seconds between tiles */
  interval: number;
  /** tile size in px (height 0 while there are no tiles yet) */
  width: number;
  height: number;
  /** sorted by start */
  tiles: ThumbTile[];
}

/**
 * Server diagnostics for Settings (admin only). Contains no provider URL, hostname or credentials,
 * and no file system paths.
 */
export interface ServerDiagnostics {
  version: string;
  /** seconds since the server started */
  uptimeSeconds: number;
  node: string;
  platform: string;
  ffmpeg: { available: boolean; version: string | null };
  ffprobe: { available: boolean; version: string | null };
  /** H.264/HEVC hardware encoders this ffmpeg build lists (e.g. h264_nvenc, h264_vaapi). Detected only; AnyCast encodes with libx264. */
  hwEncoders: string[];
  connections: {
    /** provider connections AnyCast holds right now */
    active: number;
    /** the provider's limit, null when unknown or unlimited */
    max: number | null;
    /** what holds them, e.g. "live", "movie", "timeshift" */
    byKind: Record<string, number>;
  };
  /** HLS conversions (FFmpeg sessions) running now */
  hlsSessions: number;
  buffer: { enabled: boolean; bytes: number; maxBytes: number | null; recording: number };
  thumbnails: { bytes: number } | null;
}

export interface Page<T> { items: T[]; total: number; }

export interface LiveChannelWithNow extends Channel {
  now: EpgProgram | null;
  next: EpgProgram | null;
}

/** Items by id, in the order asked for; unknown and hidden ids are left out. */
export interface ItemsById {
  live: LiveChannelWithNow[];
  movies: Movie[];
  series: Series[];
}

export interface SearchResults {
  live: Channel[];
  movies: Movie[];
  series: Series[];
}

export interface TagSummary { country: string | null; language: string | null; count: number; }

/** Who is using the provider connection another client wants (409 on /api/play/*). */
export interface ConnectionHolder {
  profileName: string;
  /** channel, movie or episode name */
  channelName: string;
  /** the holder's x-anycast-device label, if it sent one */
  device?: string;
}

/**
 * 409 body when every provider connection is used by other clients watching something else.
 * POST /api/play/takeover stops that playback; then ask for the stream again.
 */
export interface ConnectionBusyError {
  error: 'connection_busy';
  message: string;
  holder: ConnectionHolder;
  canTakeOver: true;
}

export type SyncEvent =
  | { type: 'favorites'; profileId: string; favorites: Favorite[] }
  | { type: 'progress'; profileId: string; progress: Progress }
  | { type: 'preferences'; profileId: string; preferences: Preferences }
  | { type: 'hide-rules'; profileId: string; rules: HideRules }
  /** the profile's channel lists, all of them in order, after any change */
  | { type: 'lists'; profileId: string; lists: ChannelList[] }
  | { type: 'catalog-updated' }
  /** the profile's parental lock settings changed (mode, PIN, duration): refetch GET /api/adult and lists */
  | { type: 'parental'; profileId: string }
  /**
   * Sent to the profile whose playback was stopped by another client taking over the connection.
   * `clientId` is the stopped client's x-anycast-client id; other clients of the profile ignore it.
   */
  | { type: 'playback-stopped'; profileId: string; clientId: string; reason: 'taken-over'; by: { profileName: string; device?: string } };

/** Route table (method + path -> request/response). Documentation as code. */
export interface Api {
  'GET /api/health': { res: { ok: true; version: string } };
  /** Admin only (403 {error:'forbidden'} otherwise). */
  'GET /api/diagnostics': { res: ServerDiagnostics };
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

  /** hidden items already filtered out for the current profile; hasEpg=1: only channels with guide data */
  'GET /api/live': { query: { categoryId?: string; offset?: number; limit?: number; hasEpg?: '1' }; res: Page<LiveChannelWithNow> };
  /** hidden channels are left out, except channels in one of the profile's lists */
  'GET /api/epg': { query: { channelIds: string; from: number; to: number }; res: Record<string, EpgProgram[]> };
  'GET /api/movies': { query: { categoryId?: string; offset?: number; limit?: number }; res: Page<Movie> };
  'GET /api/series': { query: { categoryId?: string; offset?: number; limit?: number }; res: Page<Series> };
  'GET /api/series/:id': { res: SeriesDetail };
  /** Hydrate items by id (favorites, deep links): comma-separated ids per kind, at most 500 each. Hidden items are left out. */
  'GET /api/items': { query: { live?: string; movie?: string; series?: string }; res: ItemsById };
  'GET /api/search': { query: { q: string }; res: SearchResults };

  /**
   * Every /api/play/* route: 409 ConnectionBusyError when other clients hold every provider connection
   * (same channel or title = shared, no conflict); 429 {error:'connection_limit', message} when the
   * connections are in use and nobody can be named.
   */
  /**
   * Tracks (PB-3, PlaybackInfo.tracks): audio = the source audio track to play (default: the saved
   * choice for the item, else the preferred audio language, else the source's default track);
   * sub = a subtitle track index, or 'off'. A different audio track, or subtitles on a stream that
   * would otherwise be played directly, gives an HLS stream through FFmpeg mapping that track.
   * Their URLs name the track (.../{pipeline}/a{n}/index.m3u8), so the client just plays the new
   * URL from where it was. Movies and episodes with text subtitles get a master playlist
   * (.../master.m3u8) with them as WebVTT subtitle renditions.
   */
  'GET /api/play/live/:id': { query: { audio?: number }; res: PlaybackInfo };
  /**
   * at = epoch ms; returns a stream starting at that time (archive or buffer).
   * When nothing covers `at`: 422 {error:'gap', message, cause: GapCause}.
   */
  'GET /api/play/live/:id/at': { query: { at: number; audio?: number }; res: PlaybackInfo };
  'GET /api/timeline/:channelId': { res: TimelineInfo };
  'GET /api/play/movie/:id': { query: { audio?: number; sub?: number | 'off' }; res: PlaybackInfo };
  'GET /api/play/episode/:id': { query: { audio?: number; sub?: number | 'off' }; res: PlaybackInfo };
  /**
   * Saves the audio and subtitle track picked for a movie or episode (kind: movie | episode) for
   * this profile; the next play of the item starts with them. subtitle null = off. Fields left out
   * keep their saved value. kind live: the audio track of a channel (subtitle is ignored), used
   * for its live stream, archive and buffer alike.
   */
  'PUT /api/tracks/:kind/:id': { body: TrackChoice; res: { ok: true } };
  /**
   * Scrub thumbnails (kind: movie | episode). Built from what the server already streams for
   * playback (HLS sessions), so no extra provider connection: unplayed parts have no tiles yet.
   * Re-fetch while playing to pick up new ones. Sprites: GET /api/thumbs/:kind/:id/sheet/:n.jpg (image/jpeg).
   */
  'GET /api/thumbs/:kind/:id': { res: ThumbIndex };
  /**
   * Stops the playback that holds the connection this client was refused (the holder named in the
   * 409). The stopped client gets a 'playback-stopped' event. Streams of the stopped playback then
   * answer 409 {error:'taken_over'} until someone asks for them again through /api/play/*.
   */
  'POST /api/play/takeover': { res: { ok: true; stopped: boolean } };
  /** This client stopped watching (player closed): its provider connection is released now. */
  'POST /api/play/stop': { res: { ok: true } };

  /** Rolling buffer: pinned channels record continuously (TL-4) */
  'GET /api/buffer/pins': { res: BufferPins };
  /**
   * Admin only (403 {error:'forbidden'} otherwise). 409 {error:'pin_limit', message} when every
   * pinnable provider connection is taken; show the message as is.
   */
  'PUT /api/buffer/pins': { body: { channelId: string; pinned: boolean }; res: BufferPins };
  'GET /api/buffer/status': { res: BufferStatus };

  'GET /api/favorites': { res: Favorite[] };
  'PUT /api/favorites': { body: { kind: Favorite['kind']; id: string; favorite: boolean }; res: Favorite[] };
  'GET /api/progress': { res: Progress[] };
  'PUT /api/progress': { body: Omit<Progress, 'updatedAt' | 'finished'>; res: Progress };
  'GET /api/continue': { res: { movies: (Movie & { progress: Progress })[]; episodes: (Episode & { progress: Progress; series: Series })[] } };
  /** includes `setupDone`, the per-profile first-run flag */
  'GET /api/preferences': { res: Preferences };
  'PUT /api/preferences': { body: Partial<Preferences>; res: Preferences };
  /**
   * Channel lists (LB-3), per profile, in the user's order. Errors: 404 not_found, 400 bad_request,
   * 409 list_limit (more than CHANNEL_LIST_LIMITS). Every change sends a 'lists' SyncEvent.
   */
  'GET /api/lists': { res: ChannelList[] };
  'POST /api/lists': { body: { name: string; channelIds?: string[] }; res: ChannelList };
  'PATCH /api/lists/:id': { body: { name: string }; res: ChannelList };
  'DELETE /api/lists/:id': { res: { ok: true } };
  /** the whole new channel order (duplicates dropped); ids of unknown channels are kept, see GET channels */
  'PUT /api/lists/:id/channels': { body: { channelIds: string[] }; res: ChannelList };
  /** the new order of the lists; lists left out keep their relative order after the named ones */
  'PUT /api/lists/order': { body: { ids: string[] }; res: ChannelList[] };
  /** the list's channels with now/next, in list order; hide rules don't apply, channels gone from the catalog are left out */
  'GET /api/lists/:id/channels': { res: LiveChannelWithNow[] };
  'GET /api/hide-rules': { res: HideRules };

  /**
   * Parental lock (see parental.ts). Adult items of a profile that cannot open them answer 403
   * AdultLockedError on play, detail and art routes. PIN routes answer PinError on failure; wrong
   * PINs and passwords count towards PIN_MAX_ATTEMPTS per PIN_WINDOW_MS per profile.
   */
  'GET /api/adult': { res: AdultStatus };
  /** pin is needed to make the mode more permissive and, unless the mode is 'shown', to change unlockMinutes; a pin sent with no change is just verified */
  'PUT /api/adult/settings': { body: { mode?: AdultMode; unlockMinutes?: UnlockMinutes; pin?: string }; res: AdultStatus };
  /** Sets or changes the PIN: needs currentPin, or the account password (forgotten PIN, or the first PIN) */
  'PUT /api/adult/pin': { body: { pin: string; currentPin?: string; password?: string }; res: AdultStatus };
  /** Admin only: removes another (or any) profile's PIN and sets its mode back to 'hidden' */
  'POST /api/adult/reset': { body: { profileId: string }; res: { ok: true } };
  /** Unlocks this device for the profile for unlockMinutes (an httpOnly cookie that ends with the browser session) */
  'POST /api/adult/unlock': { body: { pin: string }; res: AdultStatus };
  'POST /api/adult/lock': { res: AdultStatus };
  'PUT /api/hide-rules': { body: HideRules; res: HideRules };
}

export type { ItemRef, Episode };

/** Over this fraction watched counts as finished (CT-2) */
export const FINISHED_THRESHOLD = 0.95;
