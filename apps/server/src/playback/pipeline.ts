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

const CODEC_NAMES: Record<string, string> = {
  h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4',
  aac: 'AAC', ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', truehd: 'TrueHD', mp3: 'MP3', mp2: 'MP2', opus: 'Opus', flac: 'FLAC', vorbis: 'Vorbis',
};
export const codecName = (c: string) => CODEC_NAMES[c] ?? c.toUpperCase();

/**
 * One sentence on why `choice` was made for this probe and client (player Stats panel).
 * Only codec facts and the decision: never a URL.
 */
export function explainPipeline(probe: ProbeResult, caps: ClientCaps, mode: 'vod' | 'live', choice: PipelineChoice, assumed = false): string {
  const v = probe.video?.codec ?? null;
  const a = probe.audio[0]?.codec ?? null;
  const vn = v ? codecName(v) : null;
  const an = a ? codecName(a) : null;
  const codecs = [vn, an].filter(Boolean).join('/') || 'The stream';
  const audioOk = a === null || supportsCodec(caps, a);
  let reason: string;
  switch (choice.pipeline) {
    case 'transcode':
      reason = `This device can't decode ${vn ?? 'this'} video, so the server converts it to H.264${audioOk ? '' : ` and the ${an} audio to AAC`}.`;
      break;
    case 'transcode-audio':
      reason = `${vn ? `${vn} video plays here but ` : ''}${an ?? 'the'} audio doesn't, so the video is copied and the audio converted to AAC.`;
      break;
    case 'passthrough':
      reason =
        choice.type === 'file'
          ? `${codecs} in MP4 plays directly, so the file is sent as it is.`
          : choice.type === 'mpegts'
            ? `${codecs} in MPEG-TS plays through Media Source Extensions, so the stream is sent as it is.`
            : `${codecs} plays here, so the recorded segments are sent as they are.`;
      break;
    default:
      if (mode === 'live' && !caps.mse) reason = `${codecs} plays here; without Media Source Extensions it is repackaged as HLS (nothing is re-encoded).`;
      else if (mode === 'vod' && probe.container && probe.container !== 'mp4') {
        reason = `${codecs} plays here but the ${probe.container.toUpperCase()} container doesn't, so it is repackaged as HLS (nothing is re-encoded).`;
      } else reason = `${codecs} plays here; it is repackaged as HLS (nothing is re-encoded).`;
  }
  return assumed ? `${reason} The source couldn't be probed, so typical codecs were assumed.` : reason;
}
