/**
 * HLS sessions backed by FFmpeg writing into a temp dir. Sessions are shared by key and killed
 * after 60 s without requests.
 *
 * VOD seeking: the playlist is generated up front (fixed SEGMENT_SECONDS slots over the probed
 * duration) so players see the full timeline. Requesting a slot that the current FFmpeg run
 * will not reach soon restarts FFmpeg with input seeking at slot * SEGMENT_SECONDS and
 * -start_number slot. Source timestamps are kept (-copyts), so segments carry their true media
 * time and players place them correctly even though stream-copied cuts land on the nearest
 * keyframe. Runs ahead of playback are paused (SIGSTOP) to bound disk and upstream usage.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { buildHlsArgs, completedSegments, runInit, runPlaylist, runSegment, type HlsPipeline } from './ffmpeg';
import type { Lease } from './upstream';

const SEGMENT_SECONDS = 6;
const LIVE_SEGMENT_SECONDS = 4;
const IDLE_MS = 60_000;
const WAIT_MS = 45_000;
const LOOKAHEAD = 4;
const PAUSE_AHEAD = 12;
const RESUME_AHEAD = 6;
const KEEP_BEHIND = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HlsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface Run {
  id: number;
  proc: ChildProcess;
  start: number;
  exited: boolean;
  exitCode: number | null;
  paused: boolean;
  completed: Map<number, string>;
  lease: Lease;
}

abstract class Session {
  lastAccess = Date.now();
  closed = false;
  constructor(readonly dir: string) {}
  touch(): void {
    this.lastAccess = Date.now();
  }
  abstract close(): void;
}

function spawnFfmpeg(args: string[], onError: (msg: string) => void, stdin?: Readable): ChildProcess {
  const proc = spawn('ffmpeg', args, { stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr?.on('data', (d: Buffer) => {
    if (err.length < 4000) err += d;
  });
  proc.on('close', (code, signal) => {
    if (code && signal !== 'SIGKILL' && err.trim()) onError(err.trim());
  });
  proc.on('error', () => onError('ffmpeg could not be started'));
  if (stdin && proc.stdin) {
    proc.stdin.on('error', () => undefined);
    stdin.on('error', () => proc.stdin?.end());
    stdin.pipe(proc.stdin);
  }
  return proc;
}

/** Live/timeshift: ffmpeg reads MPEG-TS from a stream (fan-out or direct) or a URL, and owns the playlist. */
export class StreamHlsSession extends Session {
  private readonly proc: ChildProcess;
  private exited = false;

  constructor(
    dir: string,
    input: { stream: Readable } | { url: string },
    pipeline: HlsPipeline,
    mode: 'live' | 'event',
    private readonly lease: Lease | null,
    onError: (msg: string) => void,
  ) {
    super(dir);
    const args = buildHlsArgs({
      input: 'stream' in input ? 'pipe:0' : input.url, pipeline, dir, run: 0,
      segmentSeconds: LIVE_SEGMENT_SECONDS, mode,
    });
    this.proc = spawnFfmpeg(args, onError, 'stream' in input ? input.stream : undefined);
    this.proc.on('close', () => {
      this.exited = true;
      this.lease?.release();
      if ('stream' in input) input.stream.destroy();
    });
  }

  async playlist(): Promise<string> {
    const file = path.join(this.dir, runPlaylist(0));
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const text = await readFile(file, 'utf8').catch(() => '');
      if (text.includes('#EXTINF')) return text;
      if (this.exited || this.closed) throw new HlsError(502, 'The stream could not be started');
      if (Date.now() > deadline) throw new HlsError(504, 'The stream took too long to start');
      await sleep(200);
    }
  }

  async file(name: string): Promise<string[]> {
    const p = path.join(this.dir, name);
    if (!existsSync(p)) throw new HlsError(404, 'Segment not available');
    return [p];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.proc.kill('SIGKILL');
    this.lease?.release();
    void rm(this.dir, { recursive: true, force: true });
  }
}

export class VodHlsSession extends Session {
  private run: Run | null = null;
  private runCounter = 0;
  private lastRequested = 0;
  private readonly count: number;
  private readonly throttle: NodeJS.Timeout;

  constructor(
    dir: string,
    private readonly url: () => string,
    private readonly pipeline: HlsPipeline,
    readonly duration: number,
    private readonly acquire: () => Lease,
    private readonly onError: (msg: string) => void,
  ) {
    super(dir);
    this.count = Math.max(1, Math.ceil(duration / SEGMENT_SECONDS));
    this.throttle = setInterval(() => this.regulate(), 1000);
    this.throttle.unref();
  }

  playlist(): string {
    const lines = [
      '#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS * 2}`, '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="init.mp4"',
    ];
    for (let i = 0; i < this.count; i++) {
      const d = i === this.count - 1 ? this.duration - i * SEGMENT_SECONDS : SEGMENT_SECONDS;
      lines.push(`#EXTINF:${d.toFixed(3)},`, `seg/${i}.m4s`);
    }
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
  }

  private startRun(start: number): Run {
    this.stopRun();
    const lease = this.acquire();
    const id = ++this.runCounter;
    const args = buildHlsArgs({
      input: this.url(), pipeline: this.pipeline, dir: this.dir, run: id, segmentSeconds: SEGMENT_SECONDS,
      mode: 'vod', seek: start * SEGMENT_SECONDS, startNumber: start,
    });
    const proc = spawnFfmpeg(args, this.onError);
    const run: Run = { id, proc, start, exited: false, exitCode: null, paused: false, completed: new Map(), lease };
    proc.on('close', (code) => {
      run.exited = true;
      run.exitCode = code;
      lease.release();
    });
    this.run = run;
    return run;
  }

  private stopRun(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    run.proc.kill('SIGKILL');
    run.lease.release();
    const files = [runPlaylist(run.id), runInit(run.id), ...run.completed.values()];
    void Promise.all(files.map((f) => unlink(path.join(this.dir, f)).catch(() => undefined)));
  }

  private async refresh(run: Run): Promise<void> {
    const text = await readFile(path.join(this.dir, runPlaylist(run.id)), 'utf8').catch(() => '');
    for (const n of completedSegments(text, run.id)) {
      if (!run.completed.has(n)) run.completed.set(n, runSegment(run.id, n));
    }
  }

  private maxCompleted(run: Run): number {
    let max = run.start - 1;
    for (const n of run.completed.keys()) max = Math.max(max, n);
    return max;
  }

  private setPaused(run: Run, paused: boolean): void {
    if (run.exited || run.paused === paused) return;
    run.proc.kill(paused ? 'SIGSTOP' : 'SIGCONT');
    run.paused = paused;
  }

  private regulate(): void {
    const run = this.run;
    if (!run || run.exited) return;
    void this.refresh(run).then(() => {
      const ahead = this.maxCompleted(run) - this.lastRequested;
      if (ahead > PAUSE_AHEAD) this.setPaused(run, true);
      else if (ahead < RESUME_AHEAD) this.setPaused(run, false);
      for (const [n, file] of run.completed) {
        if (n < this.lastRequested - KEEP_BEHIND) {
          run.completed.delete(n);
          void unlink(path.join(this.dir, file)).catch(() => undefined);
        }
      }
    });
  }

  async init(): Promise<string[]> {
    this.touch();
    const run = this.run ?? this.startRun(this.lastRequested);
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      await this.refresh(run);
      const file = path.join(this.dir, runInit(run.id));
      if (run.completed.size && (await stat(file).catch(() => null))?.size) return [file];
      if (run.exited) throw new HlsError(502, 'The video could not be prepared');
      if (Date.now() > deadline) throw new HlsError(504, 'The video took too long to prepare');
      await sleep(150);
    }
  }

  /** Files that make up virtual segment n (the last slot also carries any trailing remainder). */
  async segment(n: number): Promise<string[]> {
    this.touch();
    if (!Number.isInteger(n) || n < 0 || n >= this.count) throw new HlsError(404, 'Segment not available');
    this.lastRequested = n;
    const last = n === this.count - 1;
    let run = this.run;
    if (run) await this.refresh(run);
    const reachable = run && !run.exited && n >= run.start && n <= this.maxCompleted(run) + 1 + LOOKAHEAD;
    if (!run || (!run.completed.has(n) && !reachable)) run = this.startRun(n);
    this.setPaused(run, false);
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      if (this.run !== run) throw new HlsError(409, 'Playback moved elsewhere');
      await this.refresh(run);
      if (!last && run.completed.has(n)) return [path.join(this.dir, run.completed.get(n)!)];
      if (last && run.exited) {
        const tail = [...run.completed.entries()].filter(([k]) => k >= n).sort((a, b) => a[0] - b[0]);
        if (!tail.length) throw new HlsError(404, 'Segment not available');
        return tail.map(([, f]) => path.join(this.dir, f));
      }
      if (run.exited && !run.completed.has(n)) {
        throw new HlsError(run.exitCode === 0 ? 404 : 502, run.exitCode === 0 ? 'Segment not available' : 'The video could not be prepared');
      }
      if (Date.now() > deadline) throw new HlsError(504, 'The video took too long to prepare');
      await sleep(150);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.throttle);
    this.stopRun();
    void rm(this.dir, { recursive: true, force: true });
  }
}

/** Keyed registry with idle reaping. */
export class HlsSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Promise<Session>>();
  private readonly reaper: NodeJS.Timeout;
  private readonly root: Promise<string>;

  constructor(baseDir: string = path.join(os.tmpdir(), 'anycast-hls')) {
    this.root = mkdir(baseDir, { recursive: true }).then(() => baseDir);
    this.reaper = setInterval(() => this.reap(), 5000);
    this.reaper.unref();
  }

  get<T extends Session>(key: string): T | undefined {
    const s = this.sessions.get(key);
    if (s?.closed) {
      this.sessions.delete(key);
      return undefined;
    }
    s?.touch();
    return s as T | undefined;
  }

  /** Returns the live session for `key`, creating it once even under concurrent requests. */
  async getOrCreate<T extends Session>(key: string, make: (dir: string) => Promise<T> | T): Promise<T> {
    const existing = this.get<T>(key);
    if (existing) return existing;
    let pending = this.pending.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = (async () => {
        const dir = await mkdtemp(path.join(await this.root, 'session-'));
        try {
          const s = await make(dir);
          this.sessions.set(key, s);
          return s;
        } catch (err) {
          void rm(dir, { recursive: true, force: true });
          throw err;
        }
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }

  private reap(): void {
    const now = Date.now();
    for (const [key, s] of this.sessions) {
      if (s.closed || now - s.lastAccess > IDLE_MS) {
        s.close();
        this.sessions.delete(key);
      }
    }
  }

  closeAll(): void {
    clearInterval(this.reaper);
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
