/**
 * Hardware H.264 encoding for full transcodes (VAAPI, QSV, NVENC), with libx264 as the fallback.
 *
 * The setting comes from ANYCAST_HWACCEL (auto | off | vaapi | qsv | nvenc, default auto), and an
 * admin can override it in Settings (stored in kv). A listed encoder is not a usable one (Debian's
 * FFmpeg lists NVENC on every machine), so each candidate is checked with a real one second test
 * encode through the same device setup and filter chain playback uses; the first that works is
 * cached. `auto` tries NVENC, then VAAPI, then QSV, skipping the render device methods when the
 * device is missing, so a box without a GPU settles on libx264 in well under a second.
 *
 * Playback never fails because of hardware: a session whose hardware run fails before writing
 * anything restarts on libx264 (see hls.ts), and markFailed() keeps every new session on libx264
 * for a cool-down, after which the hardware is checked again.
 */
import type { HwAccelMethod, HwAccelProbe, HwAccelSetting, VideoEncoderInfo, VideoEncoderStatus } from '@anycast/shared';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Db } from '../db';
import { kvGet, kvSet } from '../db';
import { ENCODER_NAME, hwTestArgs, SOFTWARE, type VideoEncoder } from './ffmpeg';

export const HW_SETTINGS: readonly HwAccelSetting[] = ['auto', 'off', 'vaapi', 'qsv', 'nvenc'];
/** the order `auto` tries */
export const AUTO_ORDER: readonly HwAccelMethod[] = ['nvenc', 'vaapi', 'qsv'];
export const DEFAULT_VAAPI_DEVICE = '/dev/dri/renderD128';
const KV_KEY = 'hwaccel';

export const METHOD_LABEL: Record<VideoEncoder['method'], string> = {
  software: 'Software',
  vaapi: 'VAAPI',
  qsv: 'Intel Quick Sync',
  nvenc: 'NVIDIA NVENC',
};

/** Runs ffmpeg with these arguments; ok when it exits 0, else the start of its error output. */
export type EncodeRunner = (args: string[]) => Promise<{ ok: boolean; error: string }>;

export const runFfmpegTest: EncodeRunner = (args) =>
  new Promise((resolve) => {
    let err = '';
    let proc;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      return resolve({ ok: false, error: 'ffmpeg could not be started' });
    }
    const timer = setTimeout(() => {
      err ||= 'the test encode took too long';
      proc.kill('SIGKILL');
    }, 15_000);
    proc.stderr.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d;
    });
    proc.on('error', () => (clearTimeout(timer), resolve({ ok: false, error: 'ffmpeg could not be started' })));
    proc.on('close', (code) => (clearTimeout(timer), resolve({ ok: code === 0, error: err })));
  });

export function parseHwSetting(v: string | undefined | null): HwAccelSetting | null {
  const s = v?.trim().toLowerCase();
  if (!s) return null;
  if (/^(0|false|no|none|software|libx264)$/.test(s)) return 'off';
  return (HW_SETTINGS as readonly string[]).includes(s) ? (s as HwAccelSetting) : null;
}

/** One short line from FFmpeg's error output, without file system paths (diagnostics never show paths). */
export function summarizeError(err: string): string {
  const lines = err.split('\n').map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean);
  // the most telling line: one naming the device or encoder problem, else the first
  const line = lines.find((l) => /device|vaapi|qsv|mfx|cuda|nvenc|driver|hw|encoder|not (?:found|supported)|unknown/i.test(l)) ?? lines[0] ?? 'failed';
  return line.replace(/(?:\/[\w.@+-]+)+/g, '<path>').slice(0, 200);
}

export function encoderFor(method: VideoEncoder['method'], device: string): VideoEncoder {
  return method === 'vaapi' || method === 'qsv' ? { method, device } : method === 'nvenc' ? { method } : SOFTWARE;
}

export function encoderInfo(enc: VideoEncoder): VideoEncoderInfo {
  return { active: ENCODER_NAME[enc.method], method: enc.method, label: METHOD_LABEL[enc.method] };
}

export interface HwAccelOptions {
  /** ANYCAST_HWACCEL; default off here (tests), auto from the environment (config.ts) */
  setting?: HwAccelSetting;
  /** ANYCAST_VAAPI_DEVICE, also used by QSV */
  device?: string;
  /** stores an admin's override */
  db?: Db;
  run?: EncodeRunner;
  deviceExists?: (path: string) => boolean;
  /** hardware stays off this long after it failed during playback */
  cooldownMs?: number;
  now?: () => number;
  log?: (level: 'info' | 'warn', obj: Record<string, unknown>, msg: string) => void;
}

interface Resolved {
  encoder: VideoEncoder;
  reason: string;
  probes: HwAccelProbe[];
  at: number;
  /** the setting it was resolved for */
  setting: HwAccelSetting;
}

export class HwAccel {
  private readonly env: HwAccelSetting;
  readonly device: string;
  private readonly run: EncodeRunner;
  private readonly deviceExists: (path: string) => boolean;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private resolved: Resolved | null = null;
  private pending: Promise<Resolved> | null = null;
  private unhealthy: { method: HwAccelMethod; until: number; error: string } | null = null;

  constructor(private readonly o: HwAccelOptions = {}) {
    this.env = o.setting ?? 'off';
    this.device = o.device?.trim() || DEFAULT_VAAPI_DEVICE;
    this.run = o.run ?? runFfmpegTest;
    this.deviceExists = o.deviceExists ?? existsSync;
    this.cooldownMs = o.cooldownMs ?? 15 * 60_000;
    this.now = o.now ?? Date.now;
  }

  private override(): HwAccelSetting | null {
    return this.o.db ? parseHwSetting(kvGet(this.o.db, KV_KEY)) : null;
  }

  /** The setting in effect and where it comes from. */
  setting(): { setting: HwAccelSetting; source: 'env' | 'admin' } {
    const o = this.override();
    return o ? { setting: o, source: 'admin' } : { setting: this.env, source: 'env' };
  }

  /** An admin's override (null: follow ANYCAST_HWACCEL); checks the hardware again. */
  async setOverride(setting: HwAccelSetting | null): Promise<VideoEncoderStatus> {
    if (!this.o.db) throw new Error('no database to store the hardware encoding setting');
    kvSet(this.o.db, KV_KEY, setting ?? '');
    return this.check();
  }

  /** Checks the hardware again (Settings "Check again", or after a setting change). */
  async check(): Promise<VideoEncoderStatus> {
    this.resolved = null;
    this.unhealthy = null;
    await this.resolve();
    return this.status();
  }

  private resolve(): Promise<Resolved> {
    const { setting } = this.setting();
    if (this.resolved && this.resolved.setting === setting) return Promise.resolve(this.resolved);
    this.pending ??= this.probe(setting).then(
      (r) => {
        this.pending = null;
        // a setting changed while it ran: the next call resolves again
        if (r.setting === this.setting().setting) this.resolved = r;
        return r;
      },
      (err: unknown) => {
        this.pending = null;
        throw err;
      },
    );
    return this.pending;
  }

  private async probe(setting: HwAccelSetting): Promise<Resolved> {
    const at = this.now();
    if (setting === 'off') return { encoder: SOFTWARE, reason: 'Hardware encoding is turned off.', probes: [], at, setting };
    const candidates = setting === 'auto' ? AUTO_ORDER : [setting];
    const probes: HwAccelProbe[] = [];
    for (const method of candidates) {
      const enc = encoderFor(method, this.device);
      if ((method === 'vaapi' || method === 'qsv') && !this.deviceExists(this.device)) {
        probes.push({ method, ok: false, error: 'no render device in the container (pass /dev/dri to it)' });
        continue;
      }
      let res: { ok: boolean; error: string };
      try {
        res = await this.run(hwTestArgs(enc));
      } catch (err) {
        res = { ok: false, error: String((err as Error)?.message ?? err) };
      }
      probes.push({ method, ok: res.ok, error: res.ok ? null : summarizeError(res.error) });
      if (res.ok) {
        const reason = setting === 'auto' ? `${METHOD_LABEL[method]} passed a test encode, so conversions use it.` : `${METHOD_LABEL[method]} is selected and passed a test encode.`;
        this.o.log?.('info', { encoder: ENCODER_NAME[method], probes }, 'hardware encoder ready');
        return { encoder: enc, reason, probes, at, setting };
      }
    }
    const reason =
      setting === 'auto'
        ? 'No hardware encoder passed a test encode, so conversions use the software encoder.'
        : `${METHOD_LABEL[setting]} is selected but failed a test encode (${probes[0]?.error ?? 'failed'}), so conversions use the software encoder.`;
    if (setting !== 'auto') this.o.log?.('warn', { probes }, 'hardware encoder unavailable');
    return { encoder: SOFTWARE, reason, probes, at, setting };
  }

  private cooling(): boolean {
    if (!this.unhealthy) return false;
    if (this.now() < this.unhealthy.until) return true;
    // cool-down over: check the hardware again on the next use
    this.unhealthy = null;
    this.resolved = null;
    return false;
  }

  /** The encoder a new full transcode should use (checks the hardware the first time). */
  async encoder(): Promise<VideoEncoder> {
    if (this.cooling()) return SOFTWARE;
    return (await this.resolve()).encoder;
  }

  /** The encoder new transcodes get right now, without waiting for a check (player Stats panel). */
  current(): VideoEncoder {
    if (this.cooling()) return SOFTWARE;
    const { setting } = this.setting();
    return this.resolved && this.resolved.setting === setting ? this.resolved.encoder : SOFTWARE;
  }

  /** A hardware run failed during playback: software for a while, and say so in the log. */
  markFailed(enc: VideoEncoder, error: string): void {
    if (enc.method === 'software') return;
    const summary = summarizeError(error);
    this.unhealthy = { method: enc.method, until: this.now() + this.cooldownMs, error: summary };
    this.o.log?.('warn', { encoder: ENCODER_NAME[enc.method], error: summary, retryInMinutes: Math.round(this.cooldownMs / 60_000) }, 'hardware encoder failed, using the software encoder for a while');
  }

  status(): VideoEncoderStatus {
    const { setting, source } = this.setting();
    const r = this.resolved && this.resolved.setting === setting ? this.resolved : null;
    const cooling = this.cooling() ? this.unhealthy : null;
    const enc = cooling ? SOFTWARE : (r?.encoder ?? SOFTWARE);
    let reason: string;
    if (cooling) {
      reason = `${METHOD_LABEL[cooling.method]} failed during playback (${cooling.error}), so conversions use the software encoder for now.`;
    } else if (r) reason = r.reason;
    else reason = setting === 'off' ? 'Hardware encoding is turned off.' : 'Hardware encoders have not been checked yet.';
    return {
      ...encoderInfo(enc),
      reason,
      setting,
      source,
      envSetting: this.env,
      probes: r?.probes ?? [],
      checkedAt: r?.at ?? null,
      unhealthyUntil: cooling?.until ?? null,
    };
  }

  /** Waits for a check that is running (diagnostics show its result rather than "not checked yet"). */
  async settled(): Promise<void> {
    await this.pending?.catch(() => undefined);
  }
}
