/** ffprobe each upstream stream once and cache the result in SQLite. */
import { spawn } from 'node:child_process';
import type { Db } from '../db';

export interface ProbeResult {
  /** normalized: mp4 | mkv | ts | webm | avi | hls | ... */
  container: string | null;
  duration: number | null;
  video: { codec: string; width: number | null; height: number | null } | null;
  audio: { codec: string; language: string | null; channels: number | null }[];
  subtitles: { codec: string; language: string | null }[];
}

interface FfprobeStream {
  codec_type?: string; codec_name?: string; width?: number; height?: number; channels?: number;
  tags?: Record<string, string>; disposition?: { attached_pic?: number };
}
interface FfprobeOutput { format?: { format_name?: string; duration?: string }; streams?: FfprobeStream[] }

function normalizeContainer(formatName: string | undefined): string | null {
  if (!formatName) return null;
  if (formatName.includes('mp4') || formatName.includes('mov')) return 'mp4';
  if (formatName.includes('matroska')) return 'mkv';
  if (formatName === 'mpegts') return 'ts';
  return formatName.split(',')[0] ?? null;
}

export function parseFfprobe(json: FfprobeOutput): ProbeResult {
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const duration = Number(json.format?.duration);
  return {
    container: normalizeContainer(json.format?.format_name),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    video: v?.codec_name ? { codec: v.codec_name, width: v.width ?? null, height: v.height ?? null } : null,
    audio: streams
      .filter((s) => s.codec_type === 'audio' && s.codec_name)
      .map((s) => ({ codec: s.codec_name!, language: s.tags?.language ?? null, channels: s.channels ?? null })),
    subtitles: streams
      .filter((s) => s.codec_type === 'subtitle' && s.codec_name)
      .map((s) => ({ codec: s.codec_name!, language: s.tags?.language ?? null })),
  };
}

/** Runs ffprobe with a hard timeout. Rejects with a message that never contains the URL. */
export function runFfprobe(url: string, timeoutMs = 15_000): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
      '-analyzeduration', '3000000', '-probesize', '2000000', '-rw_timeout', String(timeoutMs * 1000),
      '-user_agent', 'AnyCast/0.1', url,
    ];
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (d: Buffer) => (out += d));
    proc.stderr.on('data', (d: Buffer) => (err += d));
    proc.on('error', () => {
      clearTimeout(timer);
      reject(new Error('ffprobe is not available'));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as FfprobeOutput;
        if (code === 0 && parsed.streams?.length) return resolve(parseFfprobe(parsed));
      } catch {
        // fall through
      }
      const reason = err.includes('Server returned') ? /Server returned ([^\n]+)/.exec(err)?.[1] : null;
      reject(new Error(code === null ? 'probe timed out' : `probe failed${reason ? ` (${reason.trim()})` : ''}`));
    });
  });
}

const LIVE_TTL_MS = 7 * 86400_000;

export class ProbeCache {
  private readonly inflight = new Map<string, Promise<ProbeResult>>();

  constructor(
    private readonly db: Db,
    private readonly probe: (url: string) => Promise<ProbeResult> = runFfprobe,
  ) {}

  cached(key: string): ProbeResult | null {
    const row = this.db.prepare('SELECT data, probed_at FROM probe_cache WHERE key = ?').get(key) as { data: string; probed_at: number } | undefined;
    if (!row) return null;
    if (key.startsWith('live:') && Date.now() - row.probed_at > LIVE_TTL_MS) return null;
    return JSON.parse(row.data) as ProbeResult;
  }

  async get(key: string, url: () => string): Promise<ProbeResult> {
    const hit = this.cached(key);
    if (hit) return hit;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.probe(url())
        .then((result) => {
          this.db
            .prepare('INSERT INTO probe_cache (key, data, probed_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, probed_at = excluded.probed_at')
            .run(key, JSON.stringify(result), Date.now());
          return result;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }
}
