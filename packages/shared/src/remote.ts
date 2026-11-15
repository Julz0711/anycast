/**
 * Remote control: a phone steers AnyCast playing on another device (a computer by the TV, a TV
 * browser, a Chromecast that a computer casts to). Every open AnyCast that allows it announces
 * itself to the server (POST /api/remote/presence) with what it plays. Phones of the same account
 * list those devices and send them commands, which reach the device over its realtime stream
 * (SyncEvent 'remote-command'). Nothing is stored: devices drop out when they stop announcing.
 */

export type RemoteForm = 'phone' | 'large' | 'tv';

/** What a device plays right now, as its player sees it. */
export interface RemoteNowPlaying {
  kind: 'live' | 'movie' | 'episode';
  id: string;
  /** episodes: the series, so the remote can show its episodes */
  seriesId?: string | null;
  /** programme (live), episode or movie title */
  title: string;
  /** channel name (live), "Series · S1 E2" (episodes), year (movies) */
  subtitle?: string | null;
  /** channel logo or poster (/api/art/... path) */
  image?: string | null;
  paused: boolean;
  /** starting or buffering */
  waiting: boolean;
  /** the browser won't play with sound until someone taps the device once */
  needsTap?: boolean;
  /** movies and episodes: seconds into the video. Live: epoch ms of the picture. */
  position: number;
  /** movies and episodes: length in seconds (0 = unknown) */
  duration: number;
  /** live: the programme on now (epoch ms), so the remote can show how far it is */
  program?: { start: number; end: number } | null;
  /** live: how far behind live the picture is, ms (0 = live) */
  behindMs?: number;
  /** 0..1 */
  volume: number;
  muted: boolean;
  /** a previous / next channel (live) or episode */
  canPrev: boolean;
  canNext: boolean;
  /** the device plays this on a Chromecast */
  casting?: boolean;
}

/** One device a remote can steer. */
export interface RemoteDevice {
  /** its x-anycast-client id */
  clientId: string;
  /** the name set on the device (Settings > Remote), else its browser and system, e.g. "Chrome on Linux" */
  name: string;
  /** "Chrome on Linux": shown under a name of its own */
  device: string | null;
  form: RemoteForm;
  profileId: string;
  profileName: string;
  /** null when nothing plays */
  playing: RemoteNowPlaying | null;
  /** ms since the device sent this (a playing position has moved on by this much) */
  ageMs: number;
}

export type RemoteCommand =
  | { type: 'toggle' }
  | { type: 'play' }
  | { type: 'pause' }
  /** back (negative) or forward, seconds */
  | { type: 'seekBy'; seconds: number }
  /** movies and episodes: to this second */
  | { type: 'seekTo'; position: number }
  /** live: back to live */
  | { type: 'live' }
  | { type: 'volume'; level: number }
  | { type: 'volumeBy'; delta: number }
  | { type: 'mute'; muted: boolean }
  /** next (1) or previous (-1) channel or episode */
  | { type: 'step'; dir: 1 | -1 }
  /** play this item on the device */
  | { type: 'open'; kind: 'live' | 'movie' | 'episode'; id: string; seriesId?: string }
  /** stop playing and close the player */
  | { type: 'stop' };

export interface RemotePresence {
  name?: string | null;
  form: RemoteForm;
  playing: RemoteNowPlaying | null;
}

/** Devices drop out of the list this long after their last announcement. */
export const REMOTE_TTL_MS = 150_000;
/** How often a device announces itself while nothing changes (hidden tabs may run it less often). */
export const REMOTE_HEARTBEAT_MS = 30_000;
