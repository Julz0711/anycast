import type { LiveStreamMode } from '@anycast/shared';
import { airPlayApi } from './cast/airplay';
import { readJson, writeLocal } from '../lib/storage';
import { isAppleWebKit } from './engine';

/**
 * Playback capabilities, sent to the server as `x-anycast-caps: {"hls":bool,"mse":bool,"codecs":[...]}`
 * so it can choose passthrough / remux / transcode.
 */
export interface Caps {
  hls: boolean;
  mse: boolean;
  codecs: string[];
  /** live TV as HLS even with MSE (see liveHls) */
  liveHls?: boolean;
}

/** Codec names reported to the server, each with the MIME strings we probe. */
export const CODEC_PROBES: Record<string, string[]> = {
  avc1: ['video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.42E01E"'],
  hvc1: ['video/mp4; codecs="hvc1.1.6.L120.90"'],
  hev1: ['video/mp4; codecs="hev1.1.6.L120.90"'],
  /** 10-bit: HEVC Main 10 and H.264 High 10 (the names above only promise 8-bit) */
  'hvc1-10': ['video/mp4; codecs="hvc1.2.4.L120.90"', 'video/mp4; codecs="hev1.2.4.L120.90"'],
  'avc1-10': ['video/mp4; codecs="avc1.6E0028"'],
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
  /** Firefox and its forks (Zen, LibreWolf...) */
  gecko?: boolean;
}

/**
 * Families never claimed on Firefox and its forks: they answer yes to HEVC (Windows, through the
 * GPU's decoder), but the picture can come out grey and washed out with colored specks, while the
 * same file plays fine in Chrome or Edge. The server converts HEVC to H.264 for them instead.
 */
const GECKO_SKIP = new Set(['hvc1', 'hev1', 'hvc1-10']);

export function detectCaps(env: CapsEnv): Caps {
  const ms = env.MediaSource ?? env.ManagedMediaSource;
  const mse = !!ms && typeof ms.isTypeSupported === 'function';
  const hls = env.canPlayType('application/vnd.apple.mpegurl') !== '';
  const codecs: string[] = [];
  for (const [name, types] of Object.entries(CODEC_PROBES)) {
    if (env.gecko && GECKO_SKIP.has(name)) continue;
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

/**
 * Video codecs (ffprobe names: hevc, h264, ...) this device should never play directly, because
 * the picture came out wrong here: the server converts them instead. Set from the player's Stats
 * panel, undone in Settings > About.
 */
const CONVERT_KEY = 'anycast.convertVideo';
export const CODEC_FAMILIES: Record<string, string[]> = {
  h264: ['avc1', 'avc1-10'],
  hevc: ['hvc1', 'hev1', 'hvc1-10'],
};

export function convertedCodecs(): string[] {
  const v = readJson<unknown>(CONVERT_KEY);
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
}

export function setConvertCodec(codec: string, on: boolean): void {
  const now = new Set(convertedCodecs());
  if (on) now.add(codec);
  else now.delete(codec);
  writeLocal(CONVERT_KEY, now.size ? JSON.stringify([...now]) : null);
  memo = null;
}

/** Leaves out the families of codecs this device converts. */
export function withoutConverted(caps: Caps, converted: string[]): Caps {
  if (!converted.length) return caps;
  const drop = new Set(converted.flatMap((c) => CODEC_FAMILIES[c] ?? [c]));
  return { ...caps, codecs: caps.codecs.filter((c) => !drop.has(c)) };
}

/** Phones and tablets (Android, iPhone, iPad): touch-first devices with a mobile browser. */
export function isMobileDevice(nav: { userAgent: string; maxTouchPoints?: number; userAgentData?: { mobile?: boolean } } = navigator): boolean {
  if (nav.userAgentData?.mobile) return true;
  if (/Android|iPhone|iPad|iPod|Mobi/i.test(nav.userAgent)) return true;
  // iPadOS asks for desktop sites: a "Macintosh" that has a touch screen
  return /Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1;
}

/**
 * Settings > Player > Live stream. Raw MPEG-TS through mpegts.js keeps live TV closest to live,
 * but phones play the provider's audio timestamp holes as silence and drift out of sync, and hold
 * only the few seconds of the Live buffer. HLS from the server re-times the audio and buffers whole
 * segments, so phones (auto) and anyone who picks Steady get that instead.
 */
export function liveHls(mode: LiveStreamMode, mobile: boolean): boolean {
  return mode === 'steady' || (mode === 'auto' && mobile);
}

/** The caps header with the Live stream choice added. */
export function withLiveStream(header: string | null, mode: LiveStreamMode, mobile = isMobileDevice()): string | null {
  if (!header || !liveHls(mode, mobile)) return header;
  try {
    return JSON.stringify({ ...(JSON.parse(header) as Caps), liveHls: true });
  } catch {
    return header;
  }
}

let memo: string | null = null;
export function capsHeader(): string | null {
  if (memo) return memo;
  if (typeof document === 'undefined') return null;
  const v = document.createElement('video');
  const w = window as unknown as { MediaSource?: CapsEnv['MediaSource']; ManagedMediaSource?: CapsEnv['ManagedMediaSource'] };
  const gecko = typeof navigator !== 'undefined' && /\bGecko\/\d/.test(navigator.userAgent) && /\bFirefox\//.test(navigator.userAgent);
  const caps = detectCaps({ MediaSource: w.MediaSource, ManagedMediaSource: w.ManagedMediaSource, canPlayType: (t) => v.canPlayType(t), gecko });
  memo = JSON.stringify(withoutConverted(preferNativeHls(caps, { appleWebKit: isAppleWebKit(), airPlay: airPlayApi() }), convertedCodecs()));
  return memo;
}
