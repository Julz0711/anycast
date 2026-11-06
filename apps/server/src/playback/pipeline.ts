import type { Pipeline, PlaybackInfo } from '@anycast/shared';
import { supportsCodec, type ClientCaps } from './caps';
import type { ProbeResult } from './probe';

export interface PipelineChoice {
  pipeline: Pipeline;
  type: PlaybackInfo['type'];
}

/**
 * Picks the cheapest way to get a stream playing on this client:
 * - passthrough: MP4 H.264/AAC VOD as a progressive file; live TS H.264/AAC as raw TS when the client has MSE (mpegts.js)
 * - remux: everything else whose codecs the client decodes -> HLS (fMP4) with stream copy
 * - transcode-audio: video playable, audio not -> copy video, AAC audio
 * - transcode: video not playable -> H.264 + AAC
 *
 * `tracks.audio` is the source audio track to play (PB-3). Played directly, browsers play the
 * source's first track and cannot switch, so another track of a multi-track source, or subtitles
 * (which come out of the FFmpeg run), need at least a remux.
 */
export function choosePipeline(
  probe: ProbeResult,
  caps: ClientCaps,
  mode: 'vod' | 'live',
  tracks: { audio?: number | null; subtitles?: boolean } = {},
): PipelineChoice {
  const audioIndex = tracks.audio ?? 0;
  const video = probe.video?.codec ?? null;
  const audio = probe.audio[audioIndex]?.codec ?? probe.audio[0]?.codec ?? null;
  const videoOk = video === null || supportsCodec(caps, video);
  const audioOk = audio === null || supportsCodec(caps, audio);
  if (!videoOk) return { pipeline: 'transcode', type: 'hls' };
  const direct = (audioIndex === 0 || probe.audio.length <= 1) && !tracks.subtitles;
  const plainAvc = direct && video === 'h264' && (audio === null || audio === 'aac') && audioOk;
  if (plainAvc && mode === 'vod' && probe.container === 'mp4') return { pipeline: 'passthrough', type: 'file' };
  if (plainAvc && mode === 'live' && probe.container === 'ts' && caps.mse) return { pipeline: 'passthrough', type: 'mpegts' };
  if (!audioOk) return { pipeline: 'transcode-audio', type: 'hls' };
  return { pipeline: 'remux', type: 'hls' };
}
