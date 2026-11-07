/**
 * What a TV is asked to play for a cast stream (pure, so it can be tested without the Cast SDK).
 */
import type { CastPlayResponse } from '@anycast/shared';

export interface CastMedia {
  /** absolute URL the TV opens (a cast link) */
  url: string;
  contentType: string;
  live: boolean;
  /** HLS segment container: buffer passthrough serves the recorded TS, FFmpeg sessions write fMP4 */
  segments: 'ts' | 'fmp4' | null;
  /** seconds into the stream to start at */
  startTime: number;
  title: string;
  subtitle: string | null;
  /** absolute http(s) artwork; app paths (/api/art/...) need the session cookie, so they are left out */
  image: string | null;
}

/** The cast link as an absolute URL: the server address set for TVs, else this page's origin. */
export function castUrl(r: Pick<CastPlayResponse, 'castPath' | 'baseUrl'>, origin: string): string {
  return (r.baseUrl ?? origin).replace(/\/+$/, '') + r.castPath;
}

export function castMediaFor(
  r: CastPlayResponse,
  meta: { live: boolean; startTime?: number; title: string; subtitle?: string | null; image?: string | null },
  origin: string,
): CastMedia {
  const { info } = r;
  const hls = info.type === 'hls';
  const tsSegments = hls && info.pipeline === 'passthrough' && info.url.startsWith('/api/stream/buffer/');
  return {
    url: castUrl(r, origin),
    contentType: hls ? 'application/x-mpegURL' : info.type === 'file' ? 'video/mp4' : 'video/mp2t',
    live: meta.live,
    segments: hls ? (tsSegments ? 'ts' : 'fmp4') : null,
    startTime: Math.max(0, meta.startTime ?? 0),
    title: meta.title,
    subtitle: meta.subtitle ?? null,
    image: meta.image && /^https?:\/\//.test(meta.image) ? meta.image : null,
  };
}

/** Addresses a TV on the home network can't open: this device itself, or a Tailscale name. */
export function unreachableFromTv(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h.startsWith('127.') || h === '[::1]' || h.endsWith('.ts.net');
  } catch {
    return false;
  }
}
