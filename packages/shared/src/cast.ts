/**
 * Casting to a TV (Chromecast, AirPlay). The TV plays the same stream the server already makes for
 * this app, through a cast link (a stream URL with a token in its path), so it never needs a
 * second provider connection.
 */
import type { PlaybackInfo } from './catalog';

/** What a cast link opens: a channel (its live, archive and buffer streams), a movie or an episode. */
export interface CastScope {
  kind: 'live' | 'movie' | 'episode';
  id: string;
}

/**
 * chromecast: the stream is chosen for a Chromecast (H.264/AAC over HLS or MP4).
 * airplay: chosen for this device (the request's caps), which AirPlay hands to the TV.
 */
export type CastTarget = 'chromecast' | 'airplay';

/** What a Chromecast is asked to play: H.264 + AAC, HLS or MP4, no raw MPEG-TS. */
export const CHROMECAST_CAPS = { hls: true, mse: false, codecs: ['avc1', 'mp4a'] } as const;

export interface CastPlayRequest {
  kind: 'live' | 'movie' | 'episode';
  id: string;
  target: CastTarget;
  /** live: epoch ms to play from (archive or buffer); left out = live */
  at?: number;
  audio?: number;
  sub?: number | 'off';
}

export interface CastPlayResponse {
  /** the stream, as for the player (url is the plain /api/stream/... path) */
  info: PlaybackInfo;
  /** the cast link: /cast/<token>/api/stream/..., relative to `baseUrl` (or this page's origin) */
  castPath: string;
  /** the server address set for TVs in Settings > Casting, or null (use the page's origin) */
  baseUrl: string | null;
}

export interface CastSettings {
  /** e.g. http://192.168.1.20:8787; null = the address the app is opened at */
  baseUrl: string | null;
}
