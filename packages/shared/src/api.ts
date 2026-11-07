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
  Category, Channel, EpgProgram, Episode, Favorite, HideRules, ItemRef, Movie, MovieDetail, NewEpisodes, PlaybackInfo, VodSort,
  Progress, Series, SeriesDetail, TimelineInfo, HwAccelMethod, HwAccelSetting, VideoEncoderInfo,
} from './catalog';
import type { AdultMode, AdultStatus, UnlockMinutes } from './parental';
import type { Preferences } from './settings';
import type { TrackChoice } from './tracks';
import type { AutoBackups, BackupFile, RestoreMode, RestoreResult } from './backup';
import type { Profile, ProfileImageType } from './profiles';
import type { CastPlayRequest, CastPlayResponse, CastSettings } from './cast';


/**
 * A profile's own named, ordered list of live channels ("News", "Sport", "Kids"), LB-3.
 * `channelIds` is in the user's order. Lists ignore hide rules: a channel the user put in a list
 * stays in it (and visible there) even when its country, language or group is hidden.
 */
export interface ChannelList { id: string; name: string; channelIds: string[] }
export const CHANNEL_LIST_LIMITS = { lists: 100, channels: 2000, name: 60 } as const;

/** A movie or series in a media list; `addedAt` is epoch ms. */
export interface MediaListItem { kind: 'movie' | 'series'; id: string; addedAt: number }
/**
 * A profile's own list of movies and series. Every profile has the built-in Watch Later list
 * (`builtin: 'watch-later'`, always first, can't be renamed or deleted); the rest are the user's own,
 * in their order. `items` are in the user's order, newest added last unless they reordered.
 */
export interface MediaList { id: string; name: string; builtin: 'watch-later' | null; items: MediaListItem[] }
export const MEDIA_LIST_LIMITS = { lists: 100, items: 5000, name: 60 } as const;

/** A live channel the profile watched lately (Home › Jump back in); `watchedAt` is epoch ms. */
export interface RecentChannel { id: string; watchedAt: number }
/** How many recent channels a profile keeps; older ones drop off. */
export const RECENT_CHANNELS_MAX = 30;

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
  /** H.264/HEVC hardware encoders this ffmpeg build lists (e.g. h264_nvenc, h264_vaapi); listed is not the same as usable, see videoEncoder */
  hwEncoders: string[];
  /** the encoder full transcodes use now, and why */
  videoEncoder: VideoEncoderStatus;
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

/** One hardware encoder test (a one second test encode through the same filter chain playback uses). */
export interface HwAccelProbe {
  method: HwAccelMethod;
  ok: boolean;
  /** why it failed: the first FFmpeg error line, without file system paths */
  error: string | null;
}

/** Hardware encoding state (GET /api/diagnostics videoEncoder, GET/PUT /api/hwaccel). */
export interface VideoEncoderStatus extends VideoEncoderInfo {
  /** one sentence: why this encoder */
  reason: string;
  /** the setting in effect, and where it comes from (the ANYCAST_HWACCEL environment variable, or an admin's choice in Settings) */
  setting: HwAccelSetting;
  source: 'env' | 'admin';
  /** ANYCAST_HWACCEL (default auto) */
  envSetting: HwAccelSetting;
  /** the test encodes of the last check, in the order tried */
  probes: HwAccelProbe[];
  /** epoch ms of the last check; null before the first */
  checkedAt: number | null;
  /** the hardware encoder failed during playback: software is used until then (epoch ms) */
  unhealthyUntil: number | null;
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
  /** the profile's movie and series lists (Watch Later first), all of them in order, after any change */
  | { type: 'media-lists'; profileId: string; lists: MediaList[] }
  /** the profile's recently watched channels, newest first, after any change */
  | { type: 'recent-channels'; profileId: string; recent: RecentChannel[] }
  | { type: 'catalog-updated' }
  /** the profile's parental lock settings changed (mode, PIN, duration): refetch GET /api/adult and lists */
  | { type: 'parental'; profileId: string }
  /** an admin restored a backup: refetch everything of the profile (progress, favorites, lists, settings, parental) */
  | { type: 'restored'; profileId: string }
  /**
   * Sent to the profile whose playback was stopped by another client taking over the connection.
   * `clientId` is the stopped client's x-anycast-client id; other clients of the profile ignore it.
   */
  | { type: 'playback-stopped'; profileId: string; clientId: string; reason: 'taken-over'; by: { profileName: string; device?: string } };

/**
 * Swipe: a deck of random movies and series to sort through. Swiping right puts a title in Watch
 * Later, swiping left passes on it, and passed titles never come up again for that profile (until
 * the profile brings them back). The deck leaves out what is already in one of the profile's lists,
 * what the profile started watching, titles without a poster and locked adult titles.
 */
export type SwipeCard = { kind: 'movie'; item: Movie } | { kind: 'series'; item: Series };
export type SwipeKind = 'all' | 'movie' | 'series';
export interface SwipeQuery {
  kind?: SwipeKind;
  /** only with kind movie or series */
  categoryId?: string;
  minRating?: number;
  /** cards to return, default 20, at most 50 */
  limit?: number;
  /** "kind:id,kind:id": cards the client already holds, so the answer has none of them */
  skip?: string;
}
export interface SwipeDeck {
  cards: SwipeCard[];
  /** how many titles the deck still has with these filters, the returned cards included */
  left: number;
}
export const SWIPE_LIMITS = { deck: 50, skip: 300 } as const;

/** Route table (method + path -> request/response). Documentation as code. */
export interface VodQuery {
  categoryId?: string;
  offset?: number;
  limit?: number;
  sort?: VodSort;
  yearFrom?: number;
  yearTo?: number;
  minRating?: number;
}

export interface Api {
  'GET /api/health': { res: { ok: true; version: string } };
  /** Admin only (403 {error:'forbidden'} otherwise). */
  'GET /api/diagnostics': { res: ServerDiagnostics };
  /** Admin only. Hardware encoding status; PUT sets an override (null = follow ANYCAST_HWACCEL) and checks again; POST /check only checks again. */
  'GET /api/hwaccel': { res: VideoEncoderStatus };
  'PUT /api/hwaccel': { body: { setting: HwAccelSetting | null }; res: VideoEncoderStatus };
  'POST /api/hwaccel/check': { res: VideoEncoderStatus };
  /**
   * Backup and restore (backup.ts). Admin only (403 {error:'forbidden'} otherwise).
   * GET /api/admin/backup answers the file as an attachment named anycast-backup-YYYY-MM-DD.json.
   */
  'GET /api/admin/backup': { res: BackupFile };
  /** the automatic daily backups in DATA_DIR/backups, newest first */
  'GET /api/admin/backups': { res: AutoBackups };
  'GET /api/admin/backups/:name': { res: BackupFile };
  /**
   * Restores a backup in one transaction (mode defaults to 'replace'). `password` is the signed-in
   * admin's own password. Errors: 400 bad_backup (not a valid backup), 400 backup_version (made by
   * a newer AnyCast), 403 wrong_password, 413 too large, 429 rate_limited. Sends a 'restored'
   * SyncEvent (and the usual per-kind events) to every profile it changed.
   */
  'POST /api/admin/restore': { body: { backup: BackupFile; mode?: RestoreMode; password: string }; res: RestoreResult };
  'POST /api/auth/login': { body: { username: string; password: string }; res: Me };
  'POST /api/auth/logout': { res: { ok: true } };
  'GET /api/me': { res: Me };

  /** Profiles share the user's login and the one Xtream source; each has its own favorites, progress, preferences and hide rules */
  'GET /api/profiles': { res: Profile[] };
  /** `avatar` defaults to a built-in picture; 409 too_many past PROFILES_MAX */
  'POST /api/profiles': { body: { name: string; avatar?: string | null }; res: Profile };
  /**
   * Changes of a locked profile need it entered on this session (403 profile_locked otherwise).
   * Picking a built-in `avatar` removes an uploaded picture; null shows the first letter.
   */
  'PATCH /api/profiles/:id': { body: { name?: string; avatar?: string | null }; res: Profile };
  /** cannot delete the last profile */
  'DELETE /api/profiles/:id': { res: { ok: true } };
  /** an uploaded picture, base64 (PROFILE_IMAGE: webp, jpeg or png, at most 256 KB); 413 too large */
  'PUT /api/profiles/:id/image': { body: { type: ProfileImageType; data: string }; res: Profile };
  'DELETE /api/profiles/:id/image': { res: Profile };
  /**
   * Sets, changes (pin) or removes (pin null) the profile lock. When a lock exists it needs
   * `currentPin`, or the account `password` (forgot the PIN). Errors are PinErrors. Other devices
   * have to enter the new PIN.
   */
  'PUT /api/profiles/:id/lock': { body: { pin: string | null; currentPin?: string; password?: string }; res: Profile };
  /**
   * Opens a locked profile on this sign-in session. A sent PIN is always checked (PinError when
   * wrong); without one it answers 409 pin_required unless the session already entered it.
   */
  'POST /api/profiles/:id/enter': { body: { pin?: string }; res: Profile };
  /** Switching profiles: every locked profile but `keep` needs its PIN again on this session. */
  'POST /api/profiles/leave': { body: { keep?: string }; res: { ok: true } };

  'GET /api/source': { res: SourceStatus };
  'POST /api/source/sync': { res: { ok: true } };

  /** all=1 includes categories hidden by the profile's rules (for Settings) */
  'GET /api/categories': { query: { kind: 'live' | 'movie' | 'series'; all?: '1' }; res: Category[] };
  'GET /api/tags': { res: { countries: TagSummary[]; languages: TagSummary[] } };

  /** hidden items already filtered out for the current profile; hasEpg=1: only channels with guide data */
  'GET /api/live': { query: { categoryId?: string; offset?: number; limit?: number; hasEpg?: '1' }; res: Page<LiveChannelWithNow> };
  /** hidden channels are left out, except channels in one of the profile's lists */
  /** The other versions of a channel (same name, other quality), best first; the channel itself included. */
  'GET /api/channels/:id/variants': { res: Channel[] };
  'GET /api/epg': { query: { channelIds: string; from: number; to: number }; res: Record<string, EpgProgram[]> };
  /** sort: default 'added' (newest first); yearFrom/yearTo inclusive; minRating 0-10 */
  'GET /api/movies': { query: VodQuery; res: Page<Movie> };
  'GET /api/movies/:id': { res: MovieDetail };
  'GET /api/series': { query: VodQuery; res: Page<Series> };
  /** Followed series with episodes added since the profile last opened them, newest first. */
  'GET /api/new-episodes': { res: NewEpisodes[] };
  /** random cards for Swipe (see SwipeCard), never the same title twice in one answer */
  'GET /api/swipe': { query: SwipeQuery; res: SwipeDeck };
  /** passes on a title: it leaves the deck for good (POST) or comes back (DELETE, the undo) */
  'POST /api/swipe/passed': { body: { kind: 'movie' | 'series'; id: string }; res: { passed: number } };
  'DELETE /api/swipe/passed/:kind/:id': { res: { passed: number } };
  /** how many titles the profile passed on; DELETE brings them all back */
  'GET /api/swipe/passed': { res: { passed: number } };
  'DELETE /api/swipe/passed': { res: { passed: number } };
  /** Episodes new since the profile last opened the series carry isNew (see PUT …/seen). */
  'GET /api/series/:id': { res: SeriesDetail };
  /** The series page was opened: its new episodes stop being new. */
  'PUT /api/series/:id/seen': { res: { ok: true } };
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

  /**
   * Casting (cast.ts): the stream of an item for a TV, and a cast link to it the TV can open
   * without the session cookie. Like /api/play/*, it is this client's claim on the provider
   * connection, so the phone's own stream and the TV's are never two connections. Errors as /api/play/*.
   */
  'POST /api/cast/play': { body: CastPlayRequest; res: CastPlayResponse };
  'GET /api/cast/settings': { res: CastSettings };
  /** Admin only. 400 for an address that is not http(s)://host[:port] */
  'PUT /api/cast/settings': { body: CastSettings; res: CastSettings };

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
  /**
   * Recently watched live channels (Home › Jump back in), newest first, at most RECENT_CHANNELS_MAX.
   * The web app records a channel once it has played for a few seconds. Ids only: hydrate them with
   * GET /api/items (hidden channels drop out there). Every change sends a 'recent-channels' SyncEvent.
   */
  'GET /api/recent-channels': { res: RecentChannel[] };
  'PUT /api/recent-channels': { body: { channelId: string }; res: RecentChannel[] };
  /** forgets one channel */
  'DELETE /api/recent-channels/:id': { res: RecentChannel[] };
  /** forgets them all */
  'DELETE /api/recent-channels': { res: RecentChannel[] };
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
  /**
   * Movie and series lists, per profile: Watch Later first, then the user's own lists in their order.
   * Errors: 404 not_found, 400 bad_request, 409 list_limit (MEDIA_LIST_LIMITS), 409 builtin (Watch
   * Later can't be renamed or deleted). Every change sends a 'media-lists' SyncEvent.
   */
  'GET /api/media-lists': { res: MediaList[] };
  'POST /api/media-lists': { body: { name: string; items?: { kind: 'movie' | 'series'; id: string }[] }; res: MediaList };
  'PATCH /api/media-lists/:id': { body: { name: string }; res: MediaList };
  'DELETE /api/media-lists/:id': { res: { ok: true } };
  /** the whole new item order (duplicates dropped); items already in the list keep their addedAt */
  'PUT /api/media-lists/:id/items': { body: { items: { kind: 'movie' | 'series'; id: string }[] }; res: MediaList };
  /** the new order of the user's own lists; Watch Later always stays first */
  'PUT /api/media-lists/order': { body: { ids: string[] }; res: MediaList[] };
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
