/**
 * Rolling live buffer (TL-3..TL-6).
 *
 * While a live channel is watched (or always, when pinned) a Recorder taps the channel's existing
 * fan-out (no second provider connection) and pipes the MPEG-TS into `ffmpeg -c copy -copyts
 * -f segment`, which cuts BUFFER_DIR/<channel>/<run>/<seq>.ts files on keyframes and appends each
 * finished segment to a CSV list with its start/end PTS. Each segment is indexed in SQLite
 * (`buffer_segments`) with its wall-clock span: wall = pts * 1000 + offset, where the offset is
 * anchored when the first segment completes (the stream is realtime, so the end of a segment that
 * just finished is "now") and re-anchored when PTS jump (wrap, upstream discontinuity).
 *
 * A run is one continuous recording. Runs end because nobody watches any more (after a grace
 * period), the channel was unpinned, the server stopped, or the upstream dropped; the reason is
 * stored and becomes the gap reason after the run's last segment. Caps (per channel duration,
 * total bytes) are enforced before a segment is indexed, evicting the oldest segments first (for the
 * disk cap, from the channel using the most space).
 */
import type { GapCode, TimelineRange } from '@anycast/shared';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, type PassThrough } from 'node:stream';
import { HttpError } from '../auth/users';
import { getChannel, type ChannelRow } from '../catalog/store';
import type { BufferConfig } from '../config';
import type { Db } from '../db';
import type { LiveFanouts } from './fanout';
import type { SourceRange, TimelineSource } from './timeline';

/** Why a run ended; stored in buffer_runs.end_reason as the GapCode. */
export const REASON_DROPPED = 'dropped' satisfies GapCode;
export const REASON_IDLE = 'idle' satisfies GapCode;
export const REASON_UNPINNED = 'unpinned' satisfies GapCode;
export const REASON_STOPPED = 'stopped' satisfies GapCode;
export const REASON_RESTARTED = 'restarted' satisfies GapCode;
export const REASON_INTERRUPTED = 'interrupted' satisfies GapCode;

const STORED_CODES = new Set<string>([REASON_DROPPED, REASON_IDLE, REASON_UNPINNED, REASON_STOPPED, REASON_RESTARTED, REASON_INTERRUPTED]);
/** Older databases stored the English text; map it back to a code. */
const LEGACY_TEXT: Record<string, GapCode> = {
  'Stream dropped': 'dropped',
  'Not recorded: nobody was watching': 'idle',
  'Not recorded: the channel was unpinned': 'unpinned',
  'Not recorded: the server was stopped': 'stopped',
  'Not recorded: the server restarted': 'restarted',
  'Stream interrupted': 'interrupted',
};
const toCode = (stored: string | null): GapCode =>
  stored && STORED_CODES.has(stored) ? (stored as GapCode) : ((stored ? LEGACY_TEXT[stored] : undefined) ?? REASON_DROPPED);

/** segments of one run closer than this are one range */
const JOIN_TOLERANCE_MS = 1000;
/** a wall-clock estimate further than this from "now" re-anchors the PTS mapping */
const REANCHOR_MS = 10_000;
const POLL_MS = 200;

export interface BufferDeps {
  db: Db;
  fanouts: LiveFanouts;
  liveUrl: (channelId: string) => string;
  maxConnections: () => number | null;
  onError: (msg: string) => void;
}

export interface SegmentRow {
  run_id: number;
  seq: number;
  channel_id: string;
  start_ms: number;
  end_ms: number;
  pts: number;
  bytes: number;
}
interface RunRow {
  id: number;
  channel_id: string;
  dir: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
}

export interface BufferChannelStatus {
  channelId: string;
  name: string | null;
  pinned: boolean;
  recording: boolean;
  ranges: { start: number; end: number }[];
  /** media milliseconds held (sum of segment durations) */
  durationMs: number;
  bytes: number;
}
export interface BufferStatus {
  enabled: boolean;
  channels: BufferChannelStatus[];
  totalBytes: number;
  caps: { maxHoursPerChannel: number; maxBytes: number; maxPins: number | null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safeName(id: string): string {
  return /^[\w-]{1,64}$/.test(id) ? id : createHash('sha1').update(id).digest('hex');
}

function probeStart(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', file], { timeout: 5000 }, (err, out) => {
      const n = Number(String(out).trim());
      resolve(err || !Number.isFinite(n) ? null : n);
    });
  });
}

/** One run: ffmpeg segmenting a fan-out tap into a directory. */
class Recorder {
  private readonly proc: ChildProcess;
  private readonly poll: NodeJS.Timeout;
  private lastSeq = -1;
  private offset: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private killTimer: NodeJS.Timeout | null = null;
  stopReason: GapCode | null = null;
  readonly done: Promise<void>;

  constructor(
    private readonly mgr: BufferManager,
    readonly channelId: string,
    readonly runId: number,
    readonly dir: string,
    private readonly input: PassThrough,
    segmentSeconds: number,
    onError: (msg: string) => void,
  ) {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostats', '-analyzeduration', '2000000', '-probesize', '1000000',
      '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0?', '-map', '0:a?', '-c', 'copy', '-copyts',
      '-muxdelay', '0', '-muxpreload', '0',
      '-f', 'segment', '-segment_time', String(segmentSeconds), '-segment_format', 'mpegts',
      '-segment_list', path.join(dir, 'segments.csv'), '-segment_list_type', 'csv', '-segment_list_flags', '+live',
      path.join(dir, '%d.ts'),
    ];
    this.proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    this.proc.stderr?.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d;
    });
    this.proc.on('error', () => onError('ffmpeg could not be started'));
    this.proc.stdin?.on('error', () => undefined);
    input.on('error', () => undefined);
    input.pipe(this.proc.stdin!);
    input.on('close', () => this.proc.stdin?.end());
    this.poll = setInterval(() => this.enqueue(), POLL_MS);
    this.poll.unref();
    this.done = new Promise<void>((resolve) => {
      this.proc.on('close', (code, signal) => {
        clearInterval(this.poll);
        if (this.killTimer) clearTimeout(this.killTimer);
        if (code && signal !== 'SIGKILL' && err.trim() && !this.stopReason) onError(err.trim());
        this.enqueue();
        void this.queue.then(() => resolve());
      });
    });
  }

  private enqueue(): void {
    this.queue = this.queue.then(() => this.scan()).catch(() => undefined);
  }

  /** Indexes segments ffmpeg has finished since the last scan. */
  private async scan(): Promise<void> {
    const text = await readFile(path.join(this.dir, 'segments.csv'), 'utf8').catch(() => '');
    const now = Date.now();
    const entries = text
      .split('\n')
      .map((l) => /^(\d+)\.ts,([\d.]+),([\d.]+)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ seq: Number(m[1]), start: Number(m[2]), end: Number(m[3]) }))
      .filter((e) => e.seq > this.lastSeq);
    if (!entries.length) return;
    const last = entries[entries.length - 1]!;
    // The newest finished segment's end has just arrived (the stream is realtime), so
    // now - end is the PTS -> wall offset. We only ever notice a segment late (ffmpeg probing,
    // polling), never early, so the smallest offset seen is the best one. A large jump means
    // the PTS jumped (wrap, upstream discontinuity): anchor afresh.
    const candidate = now - last.end * 1000;
    if (this.offset === null || Math.abs(candidate - this.offset) > REANCHOR_MS) this.offset = candidate;
    else this.offset = Math.min(this.offset, candidate);
    for (const e of entries) {
      this.lastSeq = e.seq;
      const file = path.join(this.dir, `${e.seq}.ts`);
      let startPts = e.start;
      if (e.seq === 0 || startPts <= 0) startPts = (await probeStart(file)) ?? e.end;
      if (startPts > e.end) startPts = e.end; // PTS wrapped inside the segment
      const start = Math.round(startPts * 1000 + this.offset);
      const end = Math.round(e.end * 1000 + this.offset);
      let bytes = 0;
      try {
        bytes = statSync(file).size;
      } catch {
        continue;
      }
      if (end <= start || !bytes) {
        await unlink(file).catch(() => undefined);
        continue;
      }
      this.mgr.addSegment({ run_id: this.runId, seq: e.seq, channel_id: this.channelId, start_ms: start, end_ms: end, pts: startPts, bytes });
    }
  }

  stop(reason: GapCode): void {
    this.stopReason ??= reason;
    this.input.destroy();
    this.proc.stdin?.end();
    this.killTimer ??= setTimeout(() => this.proc.kill('SIGKILL'), 5000);
    this.killTimer.unref();
  }
}

export class BufferManager {
  private readonly db: Db;
  private readonly root: string;
  private readonly recorders = new Map<string, Recorder>();
  private readonly starting = new Set<string>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private closing = false;
  private readonly unlisten: () => void;

  readonly source: TimelineSource = {
    kind: 'buffer',
    ranges: (channel: ChannelRow) => this.ranges(channel.id),
  };

  constructor(
    root: string,
    readonly cfg: BufferConfig,
    private readonly deps: BufferDeps,
  ) {
    this.db = deps.db;
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.reconcile();
    this.unlisten = deps.fanouts.onViewers((key, n) => this.onViewers(key, n));
    for (const id of this.pins()) void this.startRecorder(id, 'pin');
  }

  // ----- index -----

  private runDir(run: Pick<RunRow, 'dir'>): string {
    return path.join(this.root, run.dir);
  }

  segmentPath(row: Pick<SegmentRow, 'run_id' | 'seq'>): string | null {
    const run = this.db.prepare('SELECT dir FROM buffer_runs WHERE id = ?').get(row.run_id) as Pick<RunRow, 'dir'> | undefined;
    return run ? path.join(this.runDir(run), `${row.seq}.ts`) : null;
  }

  /** On start: close runs left open, drop index rows whose files are gone, delete files nobody indexes. */
  private reconcile(): void {
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE buffer_runs SET end_reason = ?, ended_at = COALESCE((SELECT MAX(end_ms) FROM buffer_segments WHERE run_id = buffer_runs.id), started_at)
             WHERE ended_at IS NULL`,
          )
          .run(REASON_RESTARTED);
        const runs = this.db.prepare('SELECT * FROM buffer_runs').all() as RunRow[];
        const del = this.db.prepare('DELETE FROM buffer_segments WHERE run_id = ? AND seq = ?');
        for (const run of runs) {
          const dir = this.runDir(run);
          if (path.relative(this.root, dir).startsWith('..')) throw new Error('run dir outside the buffer');
          const segs = this.db.prepare('SELECT seq, bytes FROM buffer_segments WHERE run_id = ?').all(run.id) as SegmentRow[];
          for (const s of segs) {
            const size = existsSync(path.join(dir, `${s.seq}.ts`)) ? statSync(path.join(dir, `${s.seq}.ts`)).size : -1;
            if (size !== s.bytes) del.run(run.id, s.seq);
          }
        }
        this.db.prepare('DELETE FROM buffer_runs WHERE id NOT IN (SELECT DISTINCT run_id FROM buffer_segments)').run();
      })();
      // remove everything on disk the index does not know (partial segments, csv lists, dead runs)
      const runs = this.db.prepare('SELECT * FROM buffer_runs').all() as RunRow[];
      const keep = new Map(runs.map((r) => [path.normalize(r.dir), r]));
      for (const ch of readdirSync(this.root, { withFileTypes: true })) {
        const chDir = path.join(this.root, ch.name);
        if (!ch.isDirectory()) {
          rmSync(chDir, { force: true });
          continue;
        }
        for (const runEnt of readdirSync(chDir, { withFileTypes: true })) {
          const rel = path.join(ch.name, runEnt.name);
          const run = keep.get(rel);
          if (!run || !runEnt.isDirectory()) {
            rmSync(path.join(chDir, runEnt.name), { recursive: true, force: true });
            continue;
          }
          const indexed = new Set(
            (this.db.prepare('SELECT seq FROM buffer_segments WHERE run_id = ?').all(run.id) as { seq: number }[]).map((s) => `${s.seq}.ts`),
          );
          for (const f of readdirSync(path.join(chDir, runEnt.name))) {
            if (!indexed.has(f)) rmSync(path.join(chDir, runEnt.name, f), { recursive: true, force: true });
          }
        }
        if (!readdirSync(chDir).length) rmSync(chDir, { recursive: true, force: true });
      }
    } catch (err) {
      // a corrupt index: start over rather than serve wrong times
      this.deps.onError(`buffer index was unusable and has been cleared: ${(err as Error).message}`);
      this.db.exec('DELETE FROM buffer_segments; DELETE FROM buffer_runs;');
      for (const e of readdirSync(this.root)) rmSync(path.join(this.root, e), { recursive: true, force: true });
    }
  }

  private totalBytes(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM buffer_segments').get() as { n: number }).n;
  }

  private channelMs(channelId: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(end_ms - start_ms), 0) AS n FROM buffer_segments WHERE channel_id = ?').get(channelId) as { n: number }).n;
  }

  private evict(row: SegmentRow): void {
    const file = this.segmentPath(row);
    this.db.prepare('DELETE FROM buffer_segments WHERE run_id = ? AND seq = ?').run(row.run_id, row.seq);
    if (file) rmSync(file, { force: true });
    const run = this.db.prepare('SELECT * FROM buffer_runs WHERE id = ?').get(row.run_id) as RunRow | undefined;
    const left = (this.db.prepare('SELECT COUNT(*) AS n FROM buffer_segments WHERE run_id = ?').get(row.run_id) as { n: number }).n;
    if (run && run.ended_at !== null && !left) {
      this.db.prepare('DELETE FROM buffer_runs WHERE id = ?').run(run.id);
      rmSync(this.runDir(run), { recursive: true, force: true });
    }
  }

  /** Indexes a finished segment, evicting the oldest data first so the caps are never exceeded. */
  addSegment(seg: SegmentRow): boolean {
    const dur = seg.end_ms - seg.start_ms;
    const file = this.segmentPath(seg);
    if (dur > this.cfg.maxMsPerChannel || seg.bytes > this.cfg.maxBytes) {
      if (file) rmSync(file, { force: true });
      return false;
    }
    this.db.transaction(() => {
      const oldestOf = this.db.prepare('SELECT * FROM buffer_segments WHERE channel_id = ? ORDER BY start_ms LIMIT 1');
      // Over the disk cap, take from the channel using the most space, so one busy channel can't
      // starve another (e.g. a channel someone just tuned to) of its only segments.
      const oldest = this.db.prepare(
        `SELECT * FROM buffer_segments WHERE channel_id = (
           SELECT channel_id FROM buffer_segments GROUP BY channel_id ORDER BY SUM(bytes) DESC, MIN(start_ms) LIMIT 1
         ) ORDER BY start_ms LIMIT 1`,
      );
      while (this.channelMs(seg.channel_id) + dur > this.cfg.maxMsPerChannel) this.evict(oldestOf.get(seg.channel_id) as SegmentRow);
      while (this.totalBytes() + seg.bytes > this.cfg.maxBytes) this.evict(oldest.get() as SegmentRow);
      this.db
        .prepare('INSERT OR REPLACE INTO buffer_segments (run_id, seq, channel_id, start_ms, end_ms, pts, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(seg.run_id, seg.seq, seg.channel_id, seg.start_ms, seg.end_ms, seg.pts, seg.bytes);
    })();
    return true;
  }

  /** Recorded ranges of a channel, with the reason coverage stops after each. */
  ranges(channelId: string): SourceRange[] {
    const rows = this.db
      .prepare(
        `SELECT s.run_id, s.start_ms, s.end_ms, r.ended_at, r.end_reason FROM buffer_segments s JOIN buffer_runs r ON r.id = s.run_id
         WHERE s.channel_id = ? ORDER BY s.start_ms`,
      )
      .all(channelId) as { run_id: number; start_ms: number; end_ms: number; ended_at: number | null; end_reason: string | null }[];
    const out: (SourceRange & { run: number })[] = [];
    for (const r of rows) {
      const prev = out[out.length - 1];
      if (prev && prev.run === r.run_id && r.start_ms - prev.end <= JOIN_TOLERANCE_MS) {
        prev.end = Math.max(prev.end, r.end_ms);
        continue;
      }
      if (prev) prev.endReason = prev.run === r.run_id ? REASON_INTERRUPTED : prev.endReason;
      out.push({
        start: r.start_ms, end: r.end_ms, source: 'buffer', run: r.run_id,
        endReason: r.ended_at !== null ? toCode(r.end_reason) : undefined,
      });
    }
    return out.map(({ run: _run, ...r }) => r);
  }

  /** The segment that holds `at`, or the first one after it within a range. */
  segmentAt(channelId: string, at: number): SegmentRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM buffer_segments WHERE channel_id = ? AND start_ms <= ? AND end_ms > ? ORDER BY start_ms DESC LIMIT 1')
        .get(channelId, at, at) as SegmentRow | undefined) ??
      (this.db
        .prepare('SELECT * FROM buffer_segments WHERE channel_id = ? AND end_ms >= ? ORDER BY start_ms LIMIT 1')
        .get(channelId, at) as SegmentRow | undefined) ??
      null
    );
  }

  private run(runId: number): RunRow | undefined {
    return this.db.prepare('SELECT * FROM buffer_runs WHERE id = ?').get(runId) as RunRow | undefined;
  }

  segment(channelId: string, runId: number, seq: number): string | null {
    const row = this.db.prepare('SELECT * FROM buffer_segments WHERE run_id = ? AND seq = ? AND channel_id = ?').get(runId, seq, channelId) as SegmentRow | undefined;
    return row ? this.segmentPath(row) : null;
  }

  /** EVENT playlist of a run's segments from `fromSeq`; it grows while the run records. */
  playlist(channelId: string, runId: number, fromSeq: number): string | null {
    const run = this.run(runId);
    if (!run || run.channel_id !== channelId) return null;
    const segs = this.db.prepare('SELECT * FROM buffer_segments WHERE run_id = ? AND seq >= ? ORDER BY seq').all(runId, fromSeq) as SegmentRow[];
    if (!segs.length) return null;
    const target = Math.ceil(Math.max(...segs.map((s) => (s.end_ms - s.start_ms) / 1000)));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${segs[0]!.seq - fromSeq}`];
    // EVENT playlists only grow; once eviction has removed the start it is a plain sliding playlist
    if (segs[0]!.seq === fromSeq) lines.push('#EXT-X-PLAYLIST-TYPE:EVENT');
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(segs[0]!.start_ms).toISOString()}`);
    let prev: SegmentRow | null = null;
    for (const s of segs) {
      if (prev && (s.seq !== prev.seq + 1 || s.start_ms - prev.end_ms > JOIN_TOLERANCE_MS)) {
        lines.push('#EXT-X-DISCONTINUITY', `#EXT-X-PROGRAM-DATE-TIME:${new Date(s.start_ms).toISOString()}`);
      }
      lines.push(`#EXTINF:${((s.end_ms - s.start_ms) / 1000).toFixed(3)},`, `seg/${s.seq}.ts`);
      prev = s;
    }
    if (run.ended_at !== null) lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }

  /** The run's segments from `fromSeq` as one MPEG-TS byte stream that follows the recording. */
  reader(channelId: string, runId: number, fromSeq: number): Readable {
    const self = this;
    async function* gen() {
      let next = fromSeq;
      for (;;) {
        const row = self.db
          .prepare('SELECT * FROM buffer_segments WHERE run_id = ? AND channel_id = ? AND seq >= ? ORDER BY seq LIMIT 1')
          .get(runId, channelId, next) as SegmentRow | undefined;
        if (row) {
          const file = self.segmentPath(row);
          const data = file ? await readFile(file).catch(() => null) : null;
          if (data) yield data;
          next = row.seq + 1;
          continue;
        }
        const run = self.run(runId);
        if (!run || run.ended_at !== null) return;
        await sleep(500);
      }
    }
    return Readable.from(gen(), { objectMode: false });
  }

  // ----- recording -----

  isRecording(channelId: string): boolean {
    return this.recorders.has(channelId);
  }

  private onViewers(key: string, viewers: number): void {
    if (!key.startsWith('live:') || this.closing || !this.cfg.enabled) return;
    const id = key.slice(5);
    if (viewers > 0) {
      this.clearGrace(id);
      if (!this.recorders.has(id)) void this.startRecorder(id, 'viewer');
    } else if (this.recorders.has(id) && !this.isPinned(id)) {
      this.scheduleGrace(id);
    }
  }

  /** Channels recorded only for the grace period: nobody watches them and they are not pinned. */
  idleRecordings(): string[] {
    return [...this.recorders.keys()].filter((id) => !this.isPinned(id) && this.deps.fanouts.viewersNow(`live:${id}`) === 0);
  }

  /**
   * Stops a channel's recording now instead of after the grace period, because its provider
   * connection is needed elsewhere. Pinned channels keep recording. Returns whether it stopped.
   */
  stopNow(id: string, reason: GapCode = REASON_IDLE): boolean {
    const rec = this.recorders.get(id);
    if (!rec || this.isPinned(id)) return false;
    this.clearGrace(id);
    rec.stop(reason);
    return true;
  }

  private clearGrace(id: string): void {
    const t = this.graceTimers.get(id);
    if (t) clearTimeout(t);
    this.graceTimers.delete(id);
  }

  private scheduleGrace(id: string): void {
    if (this.graceTimers.has(id)) return;
    const t = setTimeout(() => {
      this.graceTimers.delete(id);
      void this.deps.fanouts.viewers(`live:${id}`).then((n) => {
        if (n === 0 && !this.isPinned(id)) this.recorders.get(id)?.stop(REASON_IDLE);
      });
    }, this.cfg.graceMs);
    t.unref();
    this.graceTimers.set(id, t);
  }

  private async startRecorder(id: string, why: 'viewer' | 'pin'): Promise<void> {
    if (this.recorders.has(id) || this.starting.has(id) || this.closing || !this.cfg.enabled) return;
    this.starting.add(id);
    const key = `live:${id}`;
    try {
      // a viewer's recorder only joins the viewer's upstream; a pinned one may open it
      const input = await this.deps.fanouts.subscribe(key, () => this.deps.liveUrl(id), { tap: true, onlyIfOpen: why === 'viewer' });
      if (this.closing) {
        input.destroy();
        return;
      }
      const now = Date.now();
      const info = this.db.prepare('INSERT INTO buffer_runs (channel_id, dir, started_at) VALUES (?, ?, ?)').run(id, '', now);
      const runId = Number(info.lastInsertRowid);
      const rel = path.join(safeName(id), String(runId));
      this.db.prepare('UPDATE buffer_runs SET dir = ? WHERE id = ?').run(rel, runId);
      const dir = path.join(this.root, rel);
      mkdirSync(dir, { recursive: true });
      const rec = new Recorder(this, id, runId, dir, input, this.cfg.segmentSeconds, this.deps.onError);
      this.recorders.set(id, rec);
      void rec.done.then(() => this.onEnded(rec));
      if (!this.isPinned(id) && (await this.deps.fanouts.viewers(key)) === 0) this.scheduleGrace(id);
    } catch {
      if (why === 'pin') this.scheduleRetry(id);
    } finally {
      this.starting.delete(id);
    }
  }

  private scheduleRetry(id: string): void {
    if (this.closing || this.retryTimers.has(id) || !this.isPinned(id)) return;
    const t = setTimeout(() => {
      this.retryTimers.delete(id);
      if (this.isPinned(id)) void this.startRecorder(id, 'pin');
    }, this.cfg.retryMs);
    t.unref();
    this.retryTimers.set(id, t);
  }

  private onEnded(rec: Recorder): void {
    const reason = rec.stopReason ?? REASON_DROPPED;
    const last = this.db.prepare('SELECT MAX(end_ms) AS t FROM buffer_segments WHERE run_id = ?').get(rec.runId) as { t: number | null };
    this.db.prepare('UPDATE buffer_runs SET ended_at = ?, end_reason = ? WHERE id = ?').run(last.t ?? Date.now(), reason, rec.runId);
    const left = (this.db.prepare('SELECT COUNT(*) AS n FROM buffer_segments WHERE run_id = ?').get(rec.runId) as { n: number }).n;
    if (!left) {
      this.db.prepare('DELETE FROM buffer_runs WHERE id = ?').run(rec.runId);
      rmSync(rec.dir, { recursive: true, force: true });
    } else {
      rmSync(path.join(rec.dir, 'segments.csv'), { force: true });
    }
    if (this.recorders.get(rec.channelId) === rec) this.recorders.delete(rec.channelId);
    this.clearGrace(rec.channelId);
    if (this.isPinned(rec.channelId) && !this.closing) this.scheduleRetry(rec.channelId);
  }

  // ----- pins -----

  pins(): string[] {
    return (this.db.prepare('SELECT channel_id FROM pinned_channels ORDER BY pinned_at').all() as { channel_id: string }[]).map((r) => r.channel_id);
  }

  isPinned(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM pinned_channels WHERE channel_id = ?').get(id);
  }

  /** Pinned recorders hold a provider connection each; one connection always stays free for watching. */
  maxPins(): number | null {
    const max = this.deps.maxConnections();
    return max === null ? null : Math.max(0, max - 1);
  }

  async setPin(id: string, pinned: boolean): Promise<string[]> {
    if (!getChannel(this.db, id)) throw new HttpError(404, 'not_found', 'Channel not found');
    if (pinned && !this.isPinned(id)) {
      const max = this.deps.maxConnections();
      const allowed = this.maxPins();
      if (allowed !== null && this.pins().length >= allowed) {
        throw new HttpError(
          409,
          'pin_limit',
          allowed === 0
            ? `Your subscription allows ${max} provider connection, and it has to stay free for watching, so no channel can be pinned.`
            : `You can pin at most ${allowed} channel${allowed === 1 ? '' : 's'}: your subscription allows ${max} provider connections and one stays free for watching. Unpin a channel first.`,
        );
      }
      this.db.prepare('INSERT OR IGNORE INTO pinned_channels (channel_id, pinned_at) VALUES (?, ?)').run(id, Date.now());
      this.clearGrace(id);
      await this.startRecorder(id, 'pin');
    } else if (!pinned && this.isPinned(id)) {
      this.db.prepare('DELETE FROM pinned_channels WHERE channel_id = ?').run(id);
      const t = this.retryTimers.get(id);
      if (t) clearTimeout(t);
      this.retryTimers.delete(id);
      if (this.recorders.has(id) && (await this.deps.fanouts.viewers(`live:${id}`)) === 0) this.recorders.get(id)?.stop(REASON_UNPINNED);
    }
    return this.pins();
  }

  status(): BufferStatus {
    const ids = new Set<string>([
      ...this.pins(),
      ...this.recorders.keys(),
      ...(this.db.prepare('SELECT DISTINCT channel_id FROM buffer_segments').all() as { channel_id: string }[]).map((r) => r.channel_id),
    ]);
    const channels = [...ids].sort().map((id): BufferChannelStatus => {
      const agg = this.db
        .prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(end_ms - start_ms), 0) AS ms FROM buffer_segments WHERE channel_id = ?')
        .get(id) as { bytes: number; ms: number };
      return {
        channelId: id,
        name: getChannel(this.db, id)?.name ?? null,
        pinned: this.isPinned(id),
        recording: this.recorders.has(id),
        ranges: this.ranges(id).map(({ start, end }): Pick<TimelineRange, 'start' | 'end'> => ({ start, end })),
        durationMs: agg.ms,
        bytes: agg.bytes,
      };
    });
    return {
      enabled: this.cfg.enabled,
      channels,
      totalBytes: this.totalBytes(),
      caps: { maxHoursPerChannel: this.cfg.maxMsPerChannel / 3600_000, maxBytes: this.cfg.maxBytes, maxPins: this.maxPins() },
    };
  }

  /** Stops every recorder (their last segments are indexed) and waits for them. */
  async close(): Promise<void> {
    this.closing = true;
    this.unlisten();
    for (const t of [...this.graceTimers.values(), ...this.retryTimers.values()]) clearTimeout(t);
    const recs = [...this.recorders.values()];
    for (const r of recs) r.stop(REASON_STOPPED);
    await Promise.race([Promise.all(recs.map((r) => r.done)), sleep(6000)]);
  }
}
