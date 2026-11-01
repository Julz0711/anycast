/**
 * FFmpeg command building and process helpers. All video is synthetic: a coloured background,
 * a moving box, the item name and a large clock of the content time, plus a beeping sine tone.
 */
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { PROFILES, type ProfileId } from './formats.js';
import { hashString } from './random.js';

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const DEFAULT_CACHE_DIR = join(tmpdir(), 'anycast-mock-cache');

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 10;

export interface FfmpegCapabilities {
  drawtext: boolean;
  fontFile: string | null;
  dca: boolean;
  x265: boolean;
}

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
  'C:/Windows/Fonts/arial.ttf',
];

let caps: FfmpegCapabilities | null = null;

/** Probes the local ffmpeg once: drawtext (needs libfreetype), a font, the DTS and HEVC encoders. */
export function capabilities(): FfmpegCapabilities {
  if (caps) return caps;
  const filters = spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  const encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (filters.error) throw new Error(`ffmpeg not found (${FFMPEG}): ${filters.error.message}`);
  const fontFile = process.env.MOCK_FONT_FILE ?? FONT_CANDIDATES.find((f) => existsSync(f)) ?? null;
  caps = {
    drawtext: /\bdrawtext\b/.test(filters.stdout) && fontFile !== null,
    fontFile,
    dca: /\bdca\b/.test(encoders.stdout),
    x265: /\blibx265\b/.test(encoders.stdout),
  };
  return caps;
}

/** Escapes a value for use inside a single-quoted filtergraph option. */
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');

async function textFile(cacheDir: string, text: string): Promise<string> {
  const dir = join(cacheDir, 'text');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${hashString(text).toString(16)}.txt`);
  if (!existsSync(file)) await writeFile(file, text, 'utf8');
  return file;
}

export type ClockMode =
  /** Wall-clock content time: shows `epoch + pts` in the process TZ (set to the panel timezone). */
  | { kind: 'wall'; epoch: number }
  /** Media position from 00:00:00. */
  | { kind: 'position' };

async function videoFilter(cacheDir: string, label: string, clock: ClockMode): Promise<string> {
  const c = capabilities();
  const box = `drawbox=x='mod(t*80,${WIDTH - 40})':y=${HEIGHT - 30}:w=40:h=20:c=white:t=fill`;
  if (!c.drawtext || !c.fontFile) return `[0:v]${box}[v]`;
  const font = `fontfile='${esc(c.fontFile)}'`;
  const nameFile = await textFile(cacheDir, label);
  const fmt = (strftime: string, offset: number, fn: 'localtime' | 'gmtime'): string =>
    `%{pts\\:${fn}\\:${offset}\\:${strftime.replace(/:/g, '\\\\\\:')}}`;
  const [clockText, dateText] =
    clock.kind === 'wall'
      ? [fmt('%H:%M:%S', clock.epoch, 'localtime'), fmt('%Y-%m-%d %Z', clock.epoch, 'localtime')]
      : [fmt('%H:%M:%S', 0, 'gmtime'), 'VOD position'];
  return [
    `[0:v]${box}`,
    `drawtext=${font}:textfile='${esc(nameFile)}':expansion=none:x=20:y=20:fontsize=26:fontcolor=white`,
    `drawtext=${font}:text='${clockText}':x=(w-tw)/2:y=(h-th)/2-10:fontsize=104:fontcolor=white:box=1:boxcolor=black@0.4:boxborderw=8`,
    `drawtext=${font}:text='${dateText}':x=(w-tw)/2:y=(h/2)+70:fontsize=24:fontcolor=white@0.85[v]`,
  ].join(',');
}

function colorFor(label: string): string {
  const h = hashString(label);
  const ch = (shift: number): string => (0x20 + ((h >>> shift) & 0x5f)).toString(16).padStart(2, '0');
  return `0x${ch(0)}${ch(8)}${ch(16)}`;
}

function videoCodecArgs(video: 'h264' | 'hevc'): string[] {
  const common = ['-pix_fmt', 'yuv420p', '-b:v', '250k', '-maxrate', '350k', '-bufsize', '700k'];
  if (video === 'hevc' && capabilities().x265) {
    return ['-c:v', 'libx265', '-preset', 'ultrafast', '-tune', 'zerolatency', '-x265-params', `log-level=error:keyint=${FPS * 2}:min-keyint=${FPS * 2}`, ...common];
  }
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', String(FPS * 2), ...common];
}

function audioCodecArgs(codec: string, index?: number): string[] {
  const sel = index === undefined ? '' : `:${index}`;
  switch (codec) {
    case 'ac3':
      return [`-c:a${sel}`, 'ac3', `-b:a${sel}`, '96k'];
    case 'eac3':
      return [`-c:a${sel}`, 'eac3', `-b:a${sel}`, '96k'];
    case 'dts':
      return capabilities().dca
        ? [`-c:a${sel}`, 'dca', '-strict', '-2', `-b:a${sel}`, '384k']
        : [`-c:a${sel}`, 'ac3', `-b:a${sel}`, '96k'];
    default:
      return [`-c:a${sel}`, 'aac', `-b:a${sel}`, '64k'];
  }
}

export interface LiveArgsInput {
  cacheDir: string;
  label: string;
  profile: ProfileId;
  /** Unix seconds of the content time at the first frame. */
  epoch: number;
  /** First PTS in seconds (PTS-of-day convention). */
  ptsOffset: number;
  realtime: boolean;
  /** Stop after this many seconds (timeshift); endless when omitted. */
  durationSec?: number;
  serviceName: string;
  output: { kind: 'pipe' } | { kind: 'hls'; dir: string };
}

export async function liveArgs(input: LiveArgsInput): Promise<string[]> {
  const profile = PROFILES[input.profile];
  const re = input.realtime ? ['-re'] : [];
  const vf = await videoFilter(input.cacheDir, input.label, { kind: 'wall', epoch: input.epoch });
  const audio = profile.audio[0]?.codec ?? 'aac';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...re, '-f', 'lavfi', '-i', `color=c=${colorFor(input.label)}:s=${WIDTH}x${HEIGHT}:r=${FPS}`,
    ...re, '-f', 'lavfi', '-i', 'sine=f=440:beep_factor=4:sample_rate=48000',
    '-filter_complex', vf, '-map', '[v]', '-map', '1:a',
    ...videoCodecArgs(profile.video),
    ...audioCodecArgs(audio), '-ac', '2',
    ...(input.durationSec !== undefined ? ['-t', String(input.durationSec)] : []),
    '-output_ts_offset', input.ptsOffset.toFixed(3),
  ];
  if (input.output.kind === 'pipe') {
    args.push(
      '-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0',
      '-metadata', `service_name=${input.serviceName}`, '-metadata', 'service_provider=AnyCast Mock',
      'pipe:1',
    );
  } else {
    args.push(
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+independent_segments',
      '-hls_segment_filename', join(input.output.dir, 'seg_%06d.ts'),
      join(input.output.dir, 'index.m3u8'),
    );
  }
  return args;
}

export type FfmpegProcess = ChildProcessByStdio<null, Readable, Readable>;

export function spawnFfmpeg(args: string[], tz: string): FfmpegProcess {
  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ: tz } });
  let errTail = '';
  proc.stderr.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });
  proc.on('exit', (code, signal) => {
    if (code && !signal && process.env.MOCK_DEBUG) console.error(`[mock-xtream] ffmpeg exited ${code}: ${errTail}`);
  });
  proc.on('error', (e) => {
    if (process.env.MOCK_DEBUG) console.error('[mock-xtream] ffmpeg spawn error', e);
  });
  return proc;
}

export function killProcess(proc: FfmpegProcess): void {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
}

// ---------------------------------------------------------------------------------------------
// VOD fixtures
// ---------------------------------------------------------------------------------------------

export interface VodFixtureInput {
  cacheDir: string;
  kind: 'movie' | 'episode';
  id: number;
  label: string;
  profile: ProfileId;
  durationSecs: number;
}

/** Bump when fixture encoding changes so stale cache files are not reused. */
const FIXTURE_VERSION = 2;

const pending = new Map<string, Promise<string>>();
let running = 0;
const queue: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

function srt(durationSecs: number, text: string): string {
  const ts = (s: number): string =>
    `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
  const cues: string[] = [];
  for (let s = 0, n = 1; s + 4 <= durationSecs; s += 10, n++) {
    cues.push(`${n}\n${ts(s)} --> ${ts(s + 4)}\n${text} ${ts(s).slice(0, 8)}\n`);
  }
  return cues.join('\n');
}

export function vodFixturePath(input: VodFixtureInput): string {
  const profile = PROFILES[input.profile];
  const key = `v${FIXTURE_VERSION}-${input.kind}-${input.id}-${input.profile}-${input.durationSecs}-${hashString(input.label).toString(16)}`;
  return join(input.cacheDir, 'vod', `${key}.${profile.container}`);
}

/** Returns the fixture file for a VOD item, generating it on first use (deduplicated, max 2 at once). */
export function ensureVodFixture(input: VodFixtureInput): Promise<string> {
  const file = vodFixturePath(input);
  const existing = pending.get(file);
  if (existing) return existing;
  const p = (async () => {
    try {
      if ((await stat(file)).size > 0) return file;
    } catch {
      /* not generated yet */
    }
    await mkdir(join(input.cacheDir, 'vod'), { recursive: true });
    const args = await vodArgs(input, `${file}.part`);
    await withSlot(() => runToCompletion(args));
    await rename(`${file}.part`, file);
    return file;
  })();
  pending.set(file, p);
  p.catch(() => undefined).finally(() => pending.delete(file));
  return p;
}

async function vodArgs(input: VodFixtureInput, out: string): Promise<string[]> {
  const profile = PROFILES[input.profile];
  const d = input.durationSecs;
  const vf = await videoFilter(input.cacheDir, input.label, { kind: 'position' });
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `color=c=${colorFor(input.label)}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${d}`,
  ];
  const audioInputs = profile.audio.length;
  profile.audio.forEach((_, i) => {
    args.push('-f', 'lavfi', '-i', `sine=f=${440 + i * 220}:beep_factor=4:sample_rate=48000:d=${d}`);
  });
  const subFiles: string[] = [];
  for (const sub of profile.subtitles) {
    const text = sub.language === 'deu' ? 'Untertitel' : 'Subtitle';
    const f = join(input.cacheDir, 'text', `sub-${input.id}-${sub.language ?? 'und'}.srt`);
    await writeFile(f, srt(d, text), 'utf8');
    subFiles.push(f);
    args.push('-i', f);
  }
  args.push('-filter_complex', vf, '-map', '[v]');
  for (let i = 0; i < audioInputs; i++) args.push('-map', `${i + 1}:a`);
  for (let i = 0; i < subFiles.length; i++) args.push('-map', `${1 + audioInputs + i}:s`);
  args.push(...videoCodecArgs(profile.video));
  profile.audio.forEach((a, i) => {
    args.push(...audioCodecArgs(a.codec, i), `-ac:a:${i}`, '2');
    if (a.language) args.push(`-metadata:s:a:${i}`, `language=${a.language}`);
  });
  profile.subtitles.forEach((s, i) => {
    args.push(`-c:s:${i}`, 'srt');
    if (s.language) args.push(`-metadata:s:s:${i}`, `language=${s.language}`);
  });
  if (profile.audio.length > 1) args.push('-disposition:a:0', 'default', '-disposition:a:1', '0');
  args.push('-metadata', `title=${input.label}`);
  if (profile.container === 'mp4') args.push('-movflags', '+faststart', '-f', 'mp4');
  else if (profile.container === 'mkv') args.push('-f', 'matroska');
  else args.push('-f', 'mpegts');
  args.push(out);
  return args;
}

function runToCompletion(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err}`))));
  });
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
