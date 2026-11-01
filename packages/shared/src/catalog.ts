/** Catalog types shared by server and web. All ids are AnyCast ids (strings), never provider URLs. */

export type MediaKind = 'live' | 'movie' | 'series';

export interface Category {
  id: string;
  kind: MediaKind;
  name: string;
  /** ISO 3166-1 alpha-2, lower-case (e.g. "de", "gb"), derived from the name; null if unknown */
  country: string | null;
  /** ISO 639-1, lower-case (e.g. "de", "en"); null if unknown */
  language: string | null;
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
}

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

export interface TimelineInfo {
  channelId: string;
  now: number;
  /** ranges that can be played, sorted ascending, non-overlapping */
  ranges: TimelineRange[];
  /** gaps that cannot be played, with a human reason */
  gaps: { start: number; end: number; reason: string }[];
  programs: EpgProgram[];
}

export type Pipeline = 'passthrough' | 'remux' | 'transcode-audio' | 'transcode';

export interface PlaybackInfo {
  /** URL relative to the server origin, e.g. /api/stream/live/123/index.m3u8 */
  url: string;
  /** 'hls' for .m3u8, 'mpegts' for raw TS, 'file' for progressive mp4 */
  type: 'hls' | 'mpegts' | 'file';
  pipeline: Pipeline;
  /** For live/timeshift: the epoch ms the stream starts at */
  startsAt?: number;
  /** For VOD: resume position in seconds */
  resumeAt?: number;
}
