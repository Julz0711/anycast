/**
 * Server diagnostics for Settings (GET /api/diagnostics, admin only): version, uptime, FFmpeg
 * tools, provider connections, disk use. Nothing here may carry a provider URL, hostname,
 * credential or file system path: only counts, versions and codec/encoder names.
 */
import type { ServerDiagnostics } from '@anycast/shared';
import { spawn } from 'node:child_process';
import { VERSION } from './config';
import type { Services } from './context';

export interface ToolInfo {
  ffmpeg: { available: boolean; version: string | null };
  ffprobe: { available: boolean; version: string | null };
  hwEncoders: string[];
}

/** Runs a command and resolves its stdout, or null when it can't run, fails or times out. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<string | null>;

export const runCommand: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
    proc.stdout.on('data', (d: Buffer) => {
      if (out.length < 512 * 1024) out += d;
    });
    proc.on('error', () => (clearTimeout(timer), resolve(null)));
    proc.on('close', (code) => (clearTimeout(timer), resolve(code === 0 ? out : null)));
  });

/** "ffmpeg version 6.1.1-3ubuntu5 Copyright ..." -> "6.1.1-3ubuntu5" (only a short, plain token). */
export function parseToolVersion(out: string | null): string | null {
  const m = out ? /\bversion\s+([\w.+~-]{1,40})/.exec(out.split('\n')[0] ?? '') : null;
  return m?.[1] ?? null;
}

const HW = /^\s*V\S*\s+((?:h264|hevc|av1)_(?:nvenc|vaapi|qsv|videotoolbox|amf|v4l2m2m|mf|omx|rkmpp))\b/gm;

/** Hardware video encoders in `ffmpeg -encoders` output. */
export function parseHwEncoders(out: string | null): string[] {
  if (!out) return [];
  return [...new Set([...out.matchAll(HW)].map((m) => m[1]!))].sort();
}

export async function detectTools(run: CommandRunner = runCommand): Promise<ToolInfo> {
  const [ffmpeg, ffprobe, encoders] = await Promise.all([
    run('ffmpeg', ['-hide_banner', '-version']).then((o) => o ?? run('ffmpeg', ['-version'])),
    run('ffprobe', ['-version']),
    run('ffmpeg', ['-hide_banner', '-encoders']),
  ]);
  return {
    ffmpeg: { available: ffmpeg !== null, version: parseToolVersion(ffmpeg) },
    ffprobe: { available: ffprobe !== null, version: parseToolVersion(ffprobe) },
    hwEncoders: parseHwEncoders(encoders),
  };
}

const KIND_NAMES: Record<string, string> = { ts: 'timeshift' };

export class Diagnostics {
  private tools: { at: number; info: Promise<ToolInfo> } | null = null;
  private readonly startedAt = Date.now();

  constructor(
    private readonly s: Pick<Services, 'playback' | 'source'>,
    private readonly run: CommandRunner = runCommand,
    /** tools are looked up again after this long (an admin may install FFmpeg while the server runs) */
    private readonly toolsTtlMs = 10 * 60_000,
  ) {}

  private toolInfo(): Promise<ToolInfo> {
    if (!this.tools || Date.now() - this.tools.at > this.toolsTtlMs) this.tools = { at: Date.now(), info: detectTools(this.run) };
    return this.tools.info;
  }

  async report(): Promise<ServerDiagnostics> {
    const p = this.s.playback;
    const byKind: Record<string, number> = {};
    for (const key of p.pool.keys()) {
      const kind = key.split(':')[0]!;
      const name = KIND_NAMES[kind] ?? kind;
      byKind[name] = (byKind[name] ?? 0) + 1;
    }
    const usage = p.buffer?.usage();
    await p.hw.settled();
    return {
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      ...(await this.toolInfo()),
      videoEncoder: p.hw.status(),
      connections: { active: p.pool.active, max: this.s.source.maxConnections(), byKind },
      hlsSessions: p.sessions.size,
      buffer: usage ? { enabled: true, ...usage } : { enabled: false, bytes: 0, maxBytes: null, recording: 0 },
      thumbnails: p.thumbs ? { bytes: p.thumbs.totalBytes } : null,
    };
  }
}
