/** Pure helpers for the player's Stats panel: what to read off the <video> and how to label it. */
import type { Pipeline, PlaybackInfo, StreamSource } from '@anycast/shared';
import type { EngineKind } from '../engine';

/** Seconds buffered ahead of the playhead (in the range that contains it). */
export function bufferAhead(v: Pick<HTMLMediaElement, 'buffered' | 'currentTime'>): number {
  const t = v.currentTime;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.start(i) <= t + 0.25 && v.buffered.end(i) >= t) return Math.max(0, v.buffered.end(i) - t);
  }
  return 0;
}

export interface FrameCounts {
  dropped: number;
  total: number;
}

type QualityVideo = Pick<HTMLVideoElement, 'getVideoPlaybackQuality'> & { webkitDroppedFrameCount?: number; webkitDecodedFrameCount?: number };

export function frameCounts(v: QualityVideo): FrameCounts | null {
  if (typeof v.getVideoPlaybackQuality === 'function') {
    const q = v.getVideoPlaybackQuality();
    return { dropped: q.droppedVideoFrames, total: q.totalVideoFrames };
  }
  if (typeof v.webkitDecodedFrameCount === 'number') return { dropped: v.webkitDroppedFrameCount ?? 0, total: v.webkitDecodedFrameCount };
  return null;
}

/** Bytes a source has delivered so far, as a running counter. */
export interface ByteSample {
  t: number;
  bytes: number;
}

/**
 * Bitrate over a sliding window from a running byte counter. Counters that go backwards (a new
 * stream was loaded) start the window again.
 */
export class RateMeter {
  private samples: ByteSample[] = [];
  constructor(private readonly windowMs = 8_000) {}

  add(s: ByteSample): void {
    const last = this.samples.at(-1);
    if (last && s.bytes < last.bytes) this.samples = [];
    this.samples.push(s);
    while (this.samples.length > 2 && s.t - this.samples[0]!.t > this.windowMs) this.samples.shift();
  }

  /** bits per second, or null until there are two samples at least 1 s apart */
  bps(): number | null {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || last.t - first.t < 1000) return null;
    return ((last.bytes - first.bytes) * 8 * 1000) / (last.t - first.t);
  }

  reset(): void {
    this.samples = [];
  }
}

/** Chrome's decoded byte counters: the media bitrate, whatever the engine. */
export function decodedBytes(v: HTMLVideoElement): number | null {
  const x = v as HTMLVideoElement & { webkitVideoDecodedByteCount?: number; webkitAudioDecodedByteCount?: number };
  if (typeof x.webkitVideoDecodedByteCount !== 'number') return null;
  return x.webkitVideoDecodedByteCount + (x.webkitAudioDecodedByteCount ?? 0);
}

/** Bytes of stream responses finished so far (Resource Timing), for browsers without decoded counters. */
export function streamBytes(entries: Pick<PerformanceResourceTiming, 'name' | 'encodedBodySize' | 'transferSize'>[]): number {
  let n = 0;
  for (const e of entries) if (e.name.includes('/api/stream/')) n += e.encodedBodySize || e.transferSize || 0;
  return n;
}

export function fmtBitrate(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return '—';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbit/s`;
  return `${Math.round(bps / 1e3)} kbit/s`;
}

export const SOURCE_LABEL: Record<StreamSource, string> = {
  live: 'Live',
  timeshift: 'Timeshift (provider archive)',
  buffer: 'Rewind buffer (this server)',
  movie: 'Movie',
  episode: 'Episode',
};

export const PIPELINE_LABEL: Record<Pipeline, string> = {
  passthrough: 'Passthrough',
  remux: 'Remux (no re-encoding)',
  'transcode-audio': 'Audio transcode (to AAC)',
  transcode: 'Full transcode (to H.264 + AAC)',
};

/** The Pipeline row: a full transcode also names the H.264 encoder the server picked ("… · VAAPI encoder"). */
export function pipelineLine(info: Pick<PlaybackInfo, 'pipeline' | 'diagnostics'>): string {
  const enc = info.pipeline === 'transcode' ? info.diagnostics?.videoEncoder : undefined;
  return enc ? `${PIPELINE_LABEL.transcode} · ${enc.label} encoder` : PIPELINE_LABEL[info.pipeline];
}

export const ENGINE_LABEL: Record<EngineKind, string> = {
  'hls.js': 'hls.js (MSE)',
  'native-hls': 'Native HLS',
  mpegts: 'mpegts.js (MSE)',
  native: 'Native (progressive)',
};

const CODECS: Record<string, string> = {
  h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4',
  aac: 'AAC', ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', truehd: 'TrueHD', mp3: 'MP3', mp2: 'MP2', opus: 'Opus', flac: 'FLAC', vorbis: 'Vorbis',
};
export const codecLabel = (c: string) => CODECS[c] ?? c.toUpperCase();

export function channelsLabel(n: number | null): string | null {
  if (!n) return null;
  return n === 1 ? 'mono' : n === 2 ? 'stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : `${n} ch`;
}

/** Source kind from PlaybackInfo, falling back to the route for servers that send no diagnostics. */
export function sourceOf(info: PlaybackInfo, routeKind: string): StreamSource {
  if (info.diagnostics) return info.diagnostics.source;
  if (routeKind === 'movie' || routeKind === 'episode') return routeKind;
  if (info.url.includes('/timeshift/')) return 'timeshift';
  if (info.url.includes('/buffer/')) return 'buffer';
  return 'live';
}

/** "HEVC · 3840×2160 · 23.98 fps" */
export function videoLine(v: { codec: string; width: number | null; height: number | null; fps: number | null; bitDepth?: number | null } | null): string {
  if (!v) return 'None';
  return [codecLabel(v.codec), v.bitDepth && v.bitDepth > 8 ? `${v.bitDepth}-bit` : null, v.width && v.height ? `${v.width}×${v.height}` : null, v.fps ? `${v.fps} fps` : null].filter(Boolean).join(' · ');
}

/** "AC-3 · 5.1 · deu" (+ "· 2 more") */
export function audioLine(a: { codec: string; channels: number | null; language: string | null }[]): string {
  const first = a[0];
  if (!first) return 'None';
  return [codecLabel(first.codec), channelsLabel(first.channels), first.language, a.length > 1 ? `${a.length - 1} more` : null].filter(Boolean).join(' · ');
}

export function fmtSeconds(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return '—';
  return `${s.toFixed(1)} s`;
}

/**
 * What the Stats panel offers when the picture looks wrong (grey, washed out, colored specks):
 * - the device plays the source video itself: convert that codec on this device from now on
 * - the server converts on the GPU: hardware encoding can be turned off (admins, Settings)
 */
export type PictureFix = { kind: 'convert'; codec: string; label: string } | { kind: 'hardware'; label: string } | null;

export function pictureFix(info: Pick<PlaybackInfo, 'pipeline' | 'diagnostics'>): PictureFix {
  const d = info.diagnostics;
  if (info.pipeline === 'transcode') {
    const enc = d?.videoEncoder;
    return enc && enc.method !== 'software' ? { kind: 'hardware', label: enc.label } : null;
  }
  const codec = d?.probe.video?.codec;
  // only codecs the server can leave out of this device's list (see player/caps.ts)
  return codec === 'hevc' || codec === 'h264' ? { kind: 'convert', codec, label: codecLabel(codec) } : null;
}

/**
 * The server converts this video only because this device was set to (the Stats panel's "Convert
 * … on this device", kept in convertedCodecs): the codec to offer playing directly again. The
 * server can't tell, so its reason then reads as if the device couldn't play the codec at all.
 */
export function convertedByChoice(info: Pick<PlaybackInfo, 'pipeline' | 'diagnostics'>, converted: string[]): { codec: string; label: string } | null {
  if (info.pipeline !== 'transcode') return null;
  const codec = info.diagnostics?.probe.video?.codec;
  return codec && converted.includes(codec) ? { codec, label: codecLabel(codec) } : null;
}
