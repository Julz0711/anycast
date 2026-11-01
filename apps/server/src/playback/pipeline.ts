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
 */
export function choosePipeline(probe: ProbeResult, caps: ClientCaps, mode: 'vod' | 'live'): PipelineChoice {
  const video = probe.video?.codec ?? null;
  const audio = probe.audio[0]?.codec ?? null;
  const videoOk = video === null || supportsCodec(caps, video);
  const audioOk = audio === null || supportsCodec(caps, audio);
  if (!videoOk) return { pipeline: 'transcode', type: 'hls' };
  const plainAvc = video === 'h264' && (audio === null || audio === 'aac') && audioOk;
  if (plainAvc && mode === 'vod' && probe.container === 'mp4') return { pipeline: 'passthrough', type: 'file' };
  if (plainAvc && mode === 'live' && probe.container === 'ts' && caps.mse) return { pipeline: 'passthrough', type: 'mpegts' };
  if (!audioOk) return { pipeline: 'transcode-audio', type: 'hls' };
  return { pipeline: 'remux', type: 'hls' };
}
