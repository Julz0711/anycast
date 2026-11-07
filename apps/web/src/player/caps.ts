import { airPlayApi } from './cast/airplay';
import { isAppleWebKit } from './engine';

/**
 * Playback capabilities, sent to the server as `x-anycast-caps: {"hls":bool,"mse":bool,"codecs":[...]}`
 * so it can choose passthrough / remux / transcode.
 */
export interface Caps {
  hls: boolean;
  mse: boolean;
  codecs: string[];
}

/** Codec names reported to the server, each with the MIME strings we probe. */
export const CODEC_PROBES: Record<string, string[]> = {
  avc1: ['video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.42E01E"'],
  hvc1: ['video/mp4; codecs="hvc1.1.6.L120.90"'],
  hev1: ['video/mp4; codecs="hev1.1.6.L120.90"'],
  mp4a: ['audio/mp4; codecs="mp4a.40.2"'],
  'ac-3': ['audio/mp4; codecs="ac-3"'],
  'ec-3': ['audio/mp4; codecs="ec-3"'],
  opus: ['audio/mp4; codecs="opus"', 'audio/webm; codecs="opus"'],
};

export interface CapsEnv {
  MediaSource?: { isTypeSupported(t: string): boolean } | undefined;
  /** iOS 17+ ManagedMediaSource */
  ManagedMediaSource?: { isTypeSupported(t: string): boolean } | undefined;
  canPlayType: (t: string) => string;
}

export function detectCaps(env: CapsEnv): Caps {
  const ms = env.MediaSource ?? env.ManagedMediaSource;
  const mse = !!ms && typeof ms.isTypeSupported === 'function';
  const hls = env.canPlayType('application/vnd.apple.mpegurl') !== '';
  const codecs: string[] = [];
  for (const [name, types] of Object.entries(CODEC_PROBES)) {
    const ok = types.some((t) => {
      try {
        return (mse && ms!.isTypeSupported(t)) || env.canPlayType(t) === 'probably';
      } catch {
        return false;
      }
    });
    if (ok) codecs.push(name);
  }
  return { hls, mse, codecs };
}

/**
 * Safari with AirPlay: ask for HLS played by Safari itself, never MSE (mpegts.js), because only
 * Safari's own player can hand the video to an Apple TV. The server then remuxes live channels to
 * HLS instead of passing the raw TS through, which costs it little (no re-encoding).
 */
export function preferNativeHls(caps: Caps, env: { appleWebKit: boolean; airPlay: boolean }): Caps {
  return env.appleWebKit && env.airPlay && caps.hls ? { ...caps, mse: false } : caps;
}

let memo: string | null = null;
export function capsHeader(): string | null {
  if (memo) return memo;
  if (typeof document === 'undefined') return null;
  const v = document.createElement('video');
  const w = window as unknown as { MediaSource?: CapsEnv['MediaSource']; ManagedMediaSource?: CapsEnv['ManagedMediaSource'] };
  const caps = detectCaps({ MediaSource: w.MediaSource, ManagedMediaSource: w.ManagedMediaSource, canPlayType: (t) => v.canPlayType(t) });
  memo = JSON.stringify(preferNativeHls(caps, { appleWebKit: isAppleWebKit(), airPlay: airPlayApi() }));
  return memo;
}
