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
 *
 * VOD subtitles (PB-3): each run also writes the item's text subtitle tracks as WebVTT. Their cues
 * are gathered across runs and served as HLS subtitle renditions over the same slots
 * (master.m3u8 -> subs/{k}.m3u8 -> subs/{k}/{slot}.vtt). Cue times are source timestamps, like
 * the segments, so players place them on the same timeline (no X-TIMESTAMP-MAP: cue time 0 is
 * media time 0).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { buildHlsArgs, completedSegments, runInit, runPlaylist, runSegment, type HlsPipeline } from './ffmpeg';
import type { Lease } from './upstream';
import { cueKey, formatVtt, parseVtt, type Cue } from './webvtt';

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
  /** subtitle track index -> WebVTT file this run writes */
  subs: Map<number, string>;
}

/** A text subtitle track carried as an HLS rendition: its source index (0:s:N) and display attributes. */
export interface SubtitleRendition {
  index: number;
  name: string;
  language: string | null;
}

/** Slots on either side of a subtitle segment whose cues it also carries (cuts land on keyframes, so players' slot times are approximate). */
const SUB_MARGIN = 1;

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
    audioCodec: string | null = null,
    /** source audio track to map (PB-3) */
    audioIndex: number | null = null,
  ) {
    super(dir);
    const args = buildHlsArgs({
      input: 'stream' in input ? 'pipe:0' : input.url, pipeline, dir, run: 0,
      segmentSeconds: LIVE_SEGMENT_SECONDS, mode, audioCodec, audioIndex,
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
  /** gathered subtitle cues per track, across runs */
  private readonly cues = new Map<number, Map<string, Cue>>();
  /** slots whose subtitle cues (with SUB_MARGIN) are all gathered */
  private readonly subsReady = new Set<number>();
  /** a run with subtitle outputs failed before writing anything: play on without subtitles */
  private subsFailed = false;

  constructor(
    dir: string,
    private readonly url: () => string,
    private readonly pipeline: HlsPipeline,
    readonly duration: number,
    private readonly acquire: () => Lease,
    private readonly onError: (msg: string) => void,
    private readonly audioCodec: string | null = null,
    /** each newly completed segment (thumbnails read these local files; see thumbs.ts) */
    private readonly onSegment?: (seg: { init: string; file: string; start: number; end: number }) => void,
    /** source audio track to map, and text subtitle tracks to carry (PB-3) */
    private readonly tracks: { audio: number | null; subtitles: SubtitleRendition[] } = { audio: null, subtitles: [] },
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

  /** Master playlist: the media playlist plus the text subtitle tracks as WebVTT renditions. */
  masterPlaylist(): string {
    this.touch();
    const q = (v: string) => v.replace(/["\r\n]/g, "'");
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (const s of this.tracks.subtitles) {
      const lang = s.language ? `,LANGUAGE="${q(s.language)}"` : '';
      lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${q(s.name)}"${lang},DEFAULT=NO,AUTOSELECT=NO,URI="subs/${s.index}.m3u8"`);
    }
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=4000000${this.tracks.subtitles.length ? ',SUBTITLES="subs"' : ''}`, 'index.m3u8', '');
    return lines.join('\n');
  }

  private subtitle(k: number): SubtitleRendition {
    const s = this.tracks.subtitles.find((t) => t.index === k);
    if (!s) throw new HlsError(404, 'Subtitle track not available');
    return s;
  }

  /** A subtitle track's media playlist: the same slots as the video. */
  subtitlePlaylist(k: number): string {
    this.touch();
    this.subtitle(k);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
    for (let i = 0; i < this.count; i++) {
      const d = i === this.count - 1 ? this.duration - i * SEGMENT_SECONDS : SEGMENT_SECONDS;
      lines.push(`#EXTINF:${d.toFixed(3)},`, `${k}/${i}.vtt`);
    }
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
  }

  /**
   * WebVTT of subtitle track k around slot n. Waits until the run has read past the slot (video
   * requests start and move runs; this never does), or answers with what is known when no run is
   * going to get there.
   */
  async subtitleSegment(k: number, n: number): Promise<string> {
    this.touch();
    this.subtitle(k);
    if (!Number.isInteger(n) || n < 0 || n >= this.count) throw new HlsError(404, 'Segment not available');
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const run = this.run;
      if (run) await this.refresh(run);
      if (this.subsReady.has(n) || this.subsFailed || this.closed) break;
      // the current run started after this slot, or will not get there soon: answer with what is known
      if (run && (n < run.start || n > this.maxCompleted(run) + LOOKAHEAD + PAUSE_AHEAD)) break;
      if (run?.exited || Date.now() > deadline) break;
      await sleep(150);
    }
    const from = (n - SUB_MARGIN) * SEGMENT_SECONDS;
    const to = (n + 1 + SUB_MARGIN) * SEGMENT_SECONDS;
    return formatVtt([...(this.cues.get(k)?.values() ?? [])].filter((c) => c.end > from && c.start < to));
  }

  private startRun(start: number): Run {
    this.stopRun();
    const lease = this.acquire();
    const id = ++this.runCounter;
    const subs = new Map<number, string>(this.subsFailed ? [] : this.tracks.subtitles.map((s) => [s.index, path.join(this.dir, `subs_r${id}_${s.index}.vtt`)]));
    const args = buildHlsArgs({
      input: this.url(), pipeline: this.pipeline, dir: this.dir, run: id, segmentSeconds: SEGMENT_SECONDS,
      mode: 'vod', seek: start * SEGMENT_SECONDS, startNumber: start, audioCodec: this.audioCodec,
      audioIndex: this.tracks.audio, subtitles: [...subs].map(([index, file]) => ({ index, file })),
    });
    const proc = spawnFfmpeg(args, this.onError);
    const run: Run = { id, proc, start, exited: false, exitCode: null, paused: false, completed: new Map(), lease, subs };
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
    // its subtitle files stay until the session closes: gather what they hold now
    void this.gatherCues(run);
    const files = [runPlaylist(run.id), runInit(run.id), ...run.completed.values()];
    void Promise.all(files.map((f) => unlink(path.join(this.dir, f)).catch(() => undefined)));
  }

  /**
   * A run that carried subtitles failed before writing a segment (a subtitle track FFmpeg could
   * not convert, say): start it again without them, so the video still plays. The new run, or null.
   */
  private retryWithoutSubs(run: Run): Run | null {
    if (!run.exited || run.exitCode === 0 || run.completed.size || !run.subs.size || this.subsFailed || this.run !== run) return null;
    this.subsFailed = true;
    return this.startRun(run.start);
  }

  private async gatherCues(run: Run, complete = false): Promise<void> {
    for (const [k, file] of run.subs) {
      const text = await readFile(file, 'utf8').catch(() => '');
      if (!text) continue;
      let store = this.cues.get(k);
      if (!store) this.cues.set(k, (store = new Map()));
      for (const c of parseVtt(text, complete)) store.set(cueKey(c), c);
    }
  }

  private async refresh(run: Run): Promise<void> {
    const exited = run.exited;
    const text = await readFile(path.join(this.dir, runPlaylist(run.id)), 'utf8').catch(() => '');
    const done = completedSegments(text, run.id);
    if (run.subs.size) {
      // read after the playlist: the cues up to where the segments got are in the files by now
      await this.gatherCues(run, exited);
      // a slot's cues (with the margin) are all read once the run wrote segments past it, or finished
      const top = exited && run.exitCode === 0 ? this.count + SUB_MARGIN : Math.max(run.start - 1, ...done);
      for (let m = run.start; m < top - SUB_MARGIN && m < this.count; m++) this.subsReady.add(m);
    }
    for (const n of done) {
      if (run.completed.has(n)) continue;
      run.completed.set(n, runSegment(run.id, n));
      if (this.onSegment && this.run === run) {
        const files = { init: path.join(this.dir, runInit(run.id)), file: path.join(this.dir, runSegment(run.id, n)) };
        try {
          this.onSegment({ ...files, start: n * SEGMENT_SECONDS, end: Math.min(this.duration, (n + 1) * SEGMENT_SECONDS) });
        } catch {
          /* thumbnails never get in the way of playback */
        }
      }
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
    let run = this.run ?? this.startRun(this.lastRequested);
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      await this.refresh(run);
      const file = path.join(this.dir, runInit(run.id));
      if (run.completed.size && (await stat(file).catch(() => null))?.size) return [file];
      const retry = this.retryWithoutSubs(run);
      if (retry) {
        run = retry;
        continue;
      }
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
      const retry = this.retryWithoutSubs(run);
      if (retry) {
        run = retry;
        continue;
      }
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

  /** Closes every session whose key matches (e.g. all sessions of one provider connection). */
  closeWhere(match: (key: string) => boolean): void {
    for (const [key, s] of this.sessions) {
      if (!match(key)) continue;
      s.close();
      this.sessions.delete(key);
    }
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
