/** FFmpeg argument builders (pure) for HLS output. */
import type { Pipeline } from '@anycast/shared';

export type HlsPipeline = Exclude<Pipeline, 'passthrough'>;

export interface HlsArgs {
  /** URL, or "pipe:0" for an MPEG-TS byte stream on stdin */
  input: string;
  pipeline: HlsPipeline;
  /** output directory; files are named r{run}_{n}.m4s, init_r{run}.mp4, r{run}.m3u8 */
  dir: string;
  run: number;
  segmentSeconds: number;
  /** vod: whole file, seekable via `seek` + `startNumber`; live: sliding window; event: growing */
  mode: 'vod' | 'live' | 'event';
  seek?: number;
  startNumber?: number;
  /** source audio codec (ffprobe name), if known; remuxed AAC from MPEG-TS needs ADTS -> ASC for MP4 */
  audioCodec?: string | null;
  /** which source audio track to map (0:a:N, PB-3); default the first */
  audioIndex?: number | null;
  /** text subtitle tracks (0:s:N) also written, as WebVTT files beside the HLS output (VOD) */
  subtitles?: { index: number; file: string }[];
}

export const runPlaylist = (run: number) => `r${run}.m3u8`;
export const runInit = (run: number) => `init_r${run}.mp4`;
export const runSegment = (run: number, n: number) => `r${run}_${n}.m4s`;

export function buildHlsArgs(o: HlsArgs): string[] {
  const seek = o.seek ?? 0;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats'];
  if (o.input !== 'pipe:0') args.push('-nostdin', '-user_agent', 'AnyCast/0.1', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  if (o.mode === 'vod' && seek > 0) args.push('-ss', seek.toFixed(3));
  if (o.input === 'pipe:0') args.push('-f', 'mpegts');
  args.push('-i', o.input, '-map', '0:v:0?', '-map', `0:a:${o.audioIndex ?? 0}?`, '-sn', '-dn');

  if (o.pipeline === 'transcode') {
    // keyframes on segment boundaries; with -copyts, t is the source timestamp
    const kf = o.mode === 'vod' ? `expr:gte(t,${seek.toFixed(3)}+n_forced*${o.segmentSeconds})` : `expr:gte(t,n_forced*${o.segmentSeconds})`;
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '8M', '-bufsize', '16M',
      '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2", '-force_key_frames', kf,
    );
  } else {
    args.push('-c:v', 'copy');
  }
  if (o.pipeline === 'remux') {
    args.push('-c:a', 'copy');
    // ADTS AAC (MPEG-TS) cannot go into fMP4 as is; the filter passes AAC that is already in ASC form
    if (o.audioCodec === 'aac') args.push('-bsf:a', 'aac_adtstoasc');
  }
  else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');

  // keep source timestamps so segments from a restarted (seeked) run line up on the same timeline;
  // frag_discont makes each fragment's tfdt absolute instead of relative to the run's start
  if (o.mode === 'vod') args.push('-copyts', '-start_at_zero', '-hls_segment_options', 'movflags=+frag_discont');

  args.push(
    '-f', 'hls', '-hls_time', String(o.segmentSeconds), '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', runInit(o.run), '-start_number', String(o.startNumber ?? 0),
    '-hls_segment_filename', `${o.dir}/r${o.run}_%d.m4s`,
  );
  if (o.mode === 'live') args.push('-hls_list_size', '8', '-hls_flags', 'delete_segments+independent_segments');
  else args.push('-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments');
  args.push(`${o.dir}/${runPlaylist(o.run)}`);
  // more outputs of the same run (one input, so no extra provider connection): each text subtitle
  // track as WebVTT, flushed per cue so it can be read while the run goes on; source timestamps
  // like the segments (-copyts is global)
  for (const s of o.subtitles ?? []) args.push('-map', `0:s:${s.index}`, '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', s.file);
  return args;
}

/** Segment numbers listed (i.e. completely written) in an ffmpeg run playlist. */
export function completedSegments(playlist: string, run: number): number[] {
  const re = new RegExp(`^r${run}_(\\d+)\\.m4s$`, 'gm');
  return [...playlist.matchAll(re)].map((m) => Number(m[1]));
}
