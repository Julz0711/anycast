/** Catalog types shared by server and web. All ids are AnyCast ids (strings), never provider URLs. */
import type { PlaybackTracks } from './tracks';

export type MediaKind = 'live' | 'movie' | 'series';

export interface Category {
  id: string;
  kind: MediaKind;
  name: string;
  /** ISO 3166-1 alpha-2, lower-case (e.g. "de", "gb"), derived from the name; null if unknown */
  country: string | null;
  /** ISO 639-1, lower-case (e.g. "de", "en"); null if unknown */
  language: string | null;
  /** XXX / adult / 18+ categories (parental lock, see parental.ts) */
  adult: boolean;
  /** adult category of a profile in 'locked' mode that this device has not unlocked */
  locked?: boolean;
}

export interface Channel {
  id: string;
  /** Display name with the country prefix stripped ("DE | ARD HD" -> "ARD HD") */
  name: string;
  rawName: string;
  number: number;
  categoryId: string;
  logo: string | null;
  country: string | null;
  language: string | null;
  /** Days of provider catchup; 0 = no archive */
  archiveDays: number;
  epgChannelId: string | null;
  /** The guide has programmes for this channel (many panels have guide data for few channels) */
  hasEpg: boolean;
  /** Quality from the name ("FHD", "HD", "4K", "SD", "HQ", "LOW", "RAW"), null when the name has none */
  quality?: string | null;
  /** How many other versions of this channel the provider has ("BBC One FHD" and "BBC One RAW" for "BBC One HD") */
  variants?: number;
  /** in a locked adult category: name is LOCKED_NAME and artwork, plot and guide are withheld */
  locked?: boolean;
}

export interface EpgProgram {
  channelId: string;
  title: string;
  description: string | null;
  /** epoch ms */
  start: number;
  /** epoch ms */
  end: number;
}

export interface Movie {
  id: string;
  name: string;
  rawName: string;
  categoryId: string;
  poster: string | null;
  year: number | null;
  rating: number | null;
  plot: string | null;
  /** seconds, if known */
  duration: number | null;
  container: string | null;
  country: string | null;
  language: string | null;
  /** when the provider added it (ms), if it says */
  added?: number | null;
  /** in a locked adult category: name is LOCKED_NAME and artwork, plot and guide are withheld */
  locked?: boolean;
}

/** GET /api/movies/:id: a movie with the provider's details (each may be null). */
export interface MovieDetail extends Movie {
  genre: string | null;
  cast: string | null;
  director: string | null;
  releaseDate: string | null;
  country: string | null;
  /** /api/art/backdrop/:id, a wide image, when the provider has one */
  backdrop: string | null;
  /** YouTube video id */
  trailer: string | null;
}

/** Sort orders of the Movies and Series grids. */
export type VodSort = 'added' | 'name' | 'year' | 'rating';

export interface Series {
  id: string;
  name: string;
  rawName: string;
  categoryId: string;
  poster: string | null;
  year: number | null;
  rating: number | null;
  plot: string | null;
  country: string | null;
  language: string | null;
  /** when the provider last changed it (ms), if it says */
  added?: number | null;
  /** in a locked adult category: name is LOCKED_NAME and artwork, plot and guide are withheld */
  locked?: boolean;
}

/** A followed series (favorite, in a list, or being watched) with episodes the profile has not seen yet. */
export interface NewEpisodes {
  series: Series;
  /** the new episodes, oldest first */
  episodes: Episode[];
}

export interface Episode {
  id: string;
  seriesId: string;
  season: number;
  episode: number;
  title: string;
  plot: string | null;
  duration: number | null;
  container: string | null;
  /** new since the profile last opened the series */
  isNew?: boolean;
  /** in a locked adult category: name is LOCKED_NAME and artwork, plot and guide are withheld */
  locked?: boolean;
}

export interface SeriesDetail extends Series {
  seasons: { season: number; episodes: Episode[] }[];
}

/** A playable item reference */
export interface ItemRef {
  kind: MediaKind | 'episode';
  id: string;
}

export interface Progress {
  kind: 'movie' | 'episode';
  id: string;
  /** seconds */
  position: number;
  /** seconds */
  duration: number;
  finished: boolean;
  updatedAt: number;
  /** for episodes, the parent series */
  seriesId?: string;
}

export interface Favorite {
  kind: MediaKind;
  id: string;
  addedAt: number;
}

export interface HideRules {
  countries: string[];
  languages: string[];
  categoryIds: string[];
}

/** Time ranges on a live channel timeline, epoch ms */
export interface TimelineRange {
  start: number;
  end: number;
  source: 'archive' | 'buffer' | 'live';
}

/**
 * Why a stretch of the timeline cannot be played. Clients format `at` (epoch ms) in the viewer's
 * time zone with `describeGap`; `TimelineGap.reason` is the same text formatted on the server.
 */
export type GapCode =
  /** the channel has no provider archive (with `at`: and the rolling buffer starts at `at`) */
  | 'no_archive'
  /** nothing covers this time */
  | 'not_recorded'
  /** the buffer stopped: nobody was watching */
  | 'idle'
  /** the buffer stopped: the channel was unpinned */
  | 'unpinned'
  /** the buffer stopped: the server was stopped */
  | 'stopped'
  /** the buffer stopped: the server restarted */
  | 'restarted'
  /** the upstream stream dropped */
  | 'dropped'
  /** the recording has a hole (upstream hiccup) */
  | 'interrupted';

export interface GapCause {
  code: GapCode;
  /** epoch ms, for codes that mention a time */
  at?: number;
}

export interface TimelineGap {
  start: number;
  end: number;
  /** human text (server time zone); prefer `describeGap(cause, fmt)` on clients */
  reason: string;
  cause: GapCause;
}

const GAP_TEXT: Record<GapCode, string> = {
  no_archive: 'This channel has no archive',
  not_recorded: 'Not recorded',
  idle: 'Not recorded: nobody was watching',
  unpinned: 'Not recorded: the channel was unpinned',
  stopped: 'Not recorded: the server was stopped',
  restarted: 'Not recorded: the server restarted',
  dropped: 'Stream dropped',
  interrupted: 'Stream interrupted',
};

/** Human text for a gap cause; `clock` formats an epoch ms as a time of day (e.g. "21:03"). */
export function describeGap(cause: GapCause, clock: (ms: number) => string): string {
  const base = GAP_TEXT[cause.code] ?? GAP_TEXT.not_recorded;
  return cause.at !== undefined && cause.code === 'no_archive' ? `${base} before ${clock(cause.at)}` : base;
}

export interface TimelineInfo {
  channelId: string;
  now: number;
  /** ranges that can be played, sorted ascending, non-overlapping */
  ranges: TimelineRange[];
  /** gaps that cannot be played, with a reason */
  gaps: TimelineGap[];
  programs: EpgProgram[];
}

export type Pipeline = 'passthrough' | 'remux' | 'transcode-audio' | 'transcode';

/** Hardware video encoding methods the server can use for a full transcode. */
export type HwAccelMethod = 'vaapi' | 'qsv' | 'nvenc';
/** How the server picks its H.264 encoder: probe for hardware (auto), software only (off), or one method. */
export type HwAccelSetting = 'auto' | 'off' | HwAccelMethod;
export type VideoEncoderName = 'libx264' | 'h264_vaapi' | 'h264_qsv' | 'h264_nvenc';

/** The H.264 encoder a full transcode uses (player Stats panel). */
export interface VideoEncoderInfo {
  active: VideoEncoderName;
  method: 'software' | HwAccelMethod;
  /** e.g. "Intel VAAPI", "Software" */
  label: string;
}

/** Where a stream comes from: the live channel, the provider archive, the server's rolling buffer, or VOD. */
export type StreamSource = 'live' | 'timeshift' | 'buffer' | 'movie' | 'episode';

/** What the server's ffprobe saw in the source (codec names as ffprobe reports them: h264, hevc, aac, ac3, ...). */
export interface StreamProbe {
  /** normalized: mp4 | mkv | ts | webm | avi | ... */
  container: string | null;
  /** seconds, VOD only */
  duration: number | null;
  video: { codec: string; width: number | null; height: number | null; fps: number | null } | null;
  audio: { codec: string; channels: number | null; language: string | null }[];
  subtitles: { codec: string; language: string | null }[];
}

/**
 * Why a stream is served the way it is (player "Stats" panel). Never contains provider URLs,
 * hostnames or credentials: only codec facts and AnyCast's own decision.
 */
export interface PlaybackDiagnostics {
  source: StreamSource;
  /** one sentence: why this pipeline was chosen */
  reason: string;
  /** what ffprobe saw; when `assumed`, the typical codecs (or catalog facts) used instead */
  probe: StreamProbe;
  /** true when the probe failed (or was skipped) and the server assumed typical codecs */
  assumed: boolean;
  /** full transcode only: the H.264 encoder the server picked when the stream was requested */
  videoEncoder?: VideoEncoderInfo;
}

export interface PlaybackInfo {
  /** URL relative to the server origin, e.g. /api/stream/live/123/index.m3u8 */
  url: string;
  /** 'hls' for .m3u8, 'mpegts' for raw TS, 'file' for progressive mp4 */
  type: 'hls' | 'mpegts' | 'file';
  pipeline: Pipeline;
  /**
   * Live, archive and buffer streams: the wall-clock time (epoch ms) at media time 0, so
   * wall time = startsAt + currentTime * 1000 (for streams whose media time starts at 0).
   */
  startsAt?: number;
  /** For VOD: resume position in seconds */
  resumeAt?: number;
  /** For episodes: the parent series */
  seriesId?: string;
  /** How the server reached this decision (source, probe, reason), for the player's Stats panel */
  diagnostics?: PlaybackDiagnostics;
  /** Audio and subtitle tracks of the source and which ones this stream uses (PB-3) */
  tracks?: PlaybackTracks;
}
