/** What the client can play, sent as header `x-anycast-caps` or query `caps` (JSON). */
import { z } from 'zod';

export interface ClientCaps {
  hls: boolean;
  mse: boolean;
  /**
   * codec families: avc1, hev1/hvc1, vp09, av01, mp4a, ac-3, ec-3, opus, mp3, flac; plus avc1-10 and
   * hvc1-10 when the device also plays 10-bit H.264 / HEVC (the plain names only promise 8-bit)
   */
  codecs: string[];
}

/** Assumed when a client sends nothing: plays H.264/AAC via HLS or MSE. */
export const DEFAULT_CAPS: ClientCaps = { hls: true, mse: true, codecs: ['avc1', 'mp4a'] };

const CapsSchema = z.object({
  hls: z.boolean().catch(false),
  mse: z.boolean().catch(false),
  codecs: z.array(z.string()).catch([]),
});

export function parseCaps(raw: string | string[] | undefined | null): ClientCaps {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return DEFAULT_CAPS;
  try {
    const parsed = CapsSchema.safeParse(JSON.parse(value));
    if (!parsed.success) return DEFAULT_CAPS;
    return { ...parsed.data, codecs: parsed.data.codecs.map((c) => c.trim().toLowerCase().split('.')[0]!).filter(Boolean) };
  } catch {
    return DEFAULT_CAPS;
  }
}

/** ffprobe codec_name -> codec family names a client may list */
const FAMILIES: Record<string, string[]> = {
  h264: ['avc1', 'avc3', 'h264'],
  hevc: ['hev1', 'hvc1', 'hevc'],
  vp9: ['vp09', 'vp9'],
  av1: ['av01', 'av1'],
  aac: ['mp4a', 'aac'],
  ac3: ['ac-3', 'ac3'],
  eac3: ['ec-3', 'eac3'],
  opus: ['opus'],
  mp3: ['mp3'],
  flac: ['flac', 'fla'],
};

export function supportsCodec(caps: ClientCaps, codec: string): boolean {
  const names = FAMILIES[codec] ?? [codec];
  return names.some((n) => caps.codecs.includes(n));
}

/** 10-bit (and deeper) video needs its own family: "plays HEVC" usually means 8-bit Main only. */
const DEEP_FAMILIES: Record<string, string[]> = {
  h264: ['avc1-10'],
  hevc: ['hvc1-10', 'hev1-10'],
};

/** Whether the client decodes this video, bit depth included (unknown depth counts as 8-bit). */
export function supportsVideo(caps: ClientCaps, video: { codec: string; bitDepth?: number | null }): boolean {
  if (!supportsCodec(caps, video.codec)) return false;
  const deep = DEEP_FAMILIES[video.codec];
  if (!deep || !video.bitDepth || video.bitDepth <= 8) return true;
  return deep.some((n) => caps.codecs.includes(n));
}
