/**
 * Scrub thumbnails (PB-1) for movies and episodes.
 *
 * Source: the segments a VOD HLS session already writes for playback. When a segment completes,
 * its files are hard-linked (so the session can delete them as usual) and a serial, low-priority
 * FFmpeg job decodes that local copy and keeps one 160 px JPEG frame per `interval` seconds that
 * falls inside it. Nothing here ever opens a provider connection, so with one connection playback
 * keeps it to itself; parts of a title nobody played (yet) simply have no thumbnail.
 *
 * Disk: <dir>/<kind>/<id>/t<k>.jpg (frame at k * interval), sheet<i>.jpg (sprite of tiles
 * i*PER_SHEET .. +PER_SHEET, built on request), meta.json (tile size). Whole items are evicted
 * least recently used first once the total passes `maxBytes`; items still being filled are kept.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ThumbIndex } from '@anycast/shared';

export type ThumbKind = 'movie' | 'episode';

export interface ThumbConfig {
  /** total cap over all items, in bytes */
  maxBytes: number;
  /** seconds between thumbnails */
  interval: number;
  /** tile width in px (height follows the picture's aspect ratio) */
  width: number;
}

export const DEFAULT_THUMBS: ThumbConfig = { maxBytes: 2 * 1024 ** 3, interval: 10, width: 160 };

export const SHEET_COLS = 10;
export const SHEET_ROWS = 10;
const PER_SHEET = SHEET_COLS * SHEET_ROWS;
/** a frame up to this many seconds after a grid time still counts as that time's thumbnail */
const TOLERANCE = 2;
/** items that got a tile this recently are not evicted (they are being played) */
const ACTIVE_MS = 5 * 60_000;
const MAX_QUEUE = 200;
const ID_RE = /^[\w-]{1,64}$/;

interface Item {
  kind: ThumbKind;
  id: string;
  dir: string;
  tiles: Set<number>;
  w: number | null;
  h: number | null;
  bytes: number;
  lastUsed: number;
  lastFilled: number;
  /** sheet index -> tile count it was built with */
  built: Map<number, number>;
  building: Map<number, Promise<string | null>>;
  touchedDisk: number;
}

interface Job {
  item: Item;
  /** media time span the segment nominally covers, in seconds */
  from: number;
  to: number;
  init: string;
  seg: string;
}

/** A completed playback segment: its init and media file, and the span it nominally covers. */
export interface SegmentFiles {
  init: string;
  file: string;
  start: number;
  end: number;
}

export class Thumbnails {
  private readonly items = new Map<string, Item>();
  private readonly queue: Job[] = [];
  private running = false;
  private closed = false;
  private total = 0;
  private jobSeq = 0;
  private readonly ready: Promise<void>;
  /** actual media time of each stored frame (seconds), for diagnostics and tests */
  readonly frameTimes = new Map<string, number>();
  /** resolves when the job queue is empty (tests) */
  private idleWaiters: (() => void)[] = [];

  constructor(
    readonly dir: string,
    readonly config: ThumbConfig = DEFAULT_THUMBS,
    private readonly onError: (msg: string) => void = () => undefined,
  ) {
    this.ready = this.scan().catch((err) => this.onError(`thumbnail cache scan failed: ${(err as Error).message}`));
  }

  static validId(id: string): boolean {
    return ID_RE.test(id);
  }

  get totalBytes(): number {
    return this.total;
  }

  private key(kind: ThumbKind, id: string) {
    return `${kind}:${id}`;
  }

  private item(kind: ThumbKind, id: string, create: true): Item;
  private item(kind: ThumbKind, id: string, create?: false): Item | undefined;
  private item(kind: ThumbKind, id: string, create = false): Item | undefined {
    const k = this.key(kind, id);
    let it = this.items.get(k);
    if (!it && create) {
      it = {
        kind, id, dir: path.join(this.dir, kind, id), tiles: new Set(), w: null, h: null, bytes: 0,
        lastUsed: Date.now(), lastFilled: 0, built: new Map(), building: new Map(), touchedDisk: 0,
      };
      this.items.set(k, it);
    }
    return it;
  }

  /** Loads what earlier runs left on disk. */
  private async scan(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const kind of ['movie', 'episode'] as const) {
      const kindDir = path.join(this.dir, kind);
      const ids = await readdir(kindDir).catch(() => [] as string[]);
      for (const id of ids) {
        if (!ID_RE.test(id)) continue;
        const dir = path.join(kindDir, id);
        const meta = await readFile(path.join(dir, 'meta.json'), 'utf8').then((t) => JSON.parse(t) as { w: number; h: number; interval: number }).catch(() => null);
        if (!meta || meta.interval !== this.config.interval) {
          await rm(dir, { recursive: true, force: true });
          continue;
        }
        const it = this.item(kind, id, true);
        it.w = meta.w;
        it.h = meta.h;
        it.lastUsed = (await stat(dir)).mtimeMs;
        for (const f of await readdir(dir)) {
          const size = (await stat(path.join(dir, f)).catch(() => null))?.size ?? 0;
          it.bytes += size;
          const m = /^t(\d+)\.jpg$/.exec(f);
          if (m) it.tiles.add(Number(m[1]));
          else if (/^sheet\d+\.jpg$/.test(f) || f.startsWith('job')) await unlink(path.join(dir, f)).catch(() => undefined);
        }
        this.total += it.bytes;
      }
    }
    await this.evict();
  }

  /** Grid indexes (k, at k * interval s) inside [from, to). */
  private grid(from: number, to: number): number[] {
    const out: number[] = [];
    for (let k = Math.max(0, Math.ceil(from / this.config.interval)); k * this.config.interval < to; k++) out.push(k);
    return out;
  }

  /**
   * A playback segment completed. Cheap when every thumbnail it could hold already exists (a
   * replay): nothing is linked or decoded. Otherwise the files are linked and a job is queued.
   */
  ingest(kind: ThumbKind, id: string, seg: SegmentFiles): void {
    if (this.closed || !ID_RE.test(id)) return;
    const it = this.item(kind, id, true);
    // keyframe cuts move segment edges: look a bit beyond the nominal span on both sides
    const span = seg.end - seg.start;
    const from = Math.max(0, seg.start - span);
    const to = seg.end + span;
    if (this.grid(from, to).every((k) => it.tiles.has(k))) return;
    if (this.queue.length >= MAX_QUEUE) return;
    const n = ++this.jobSeq;
    const own = async (src: string, tag: string) => {
      const dst = `${src}.thumb${n}${tag}`;
      await link(src, dst).catch(() => copyFile(src, dst));
      return dst;
    };
    void (async () => {
      const [init, file] = await Promise.all([own(seg.init, 'i'), own(seg.file, 's')]);
      this.queue.push({ item: it, from, to, init, seg: file });
      this.pump();
    })().catch(() => undefined);
  }

  private pump(): void {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) {
      for (const w of this.idleWaiters.splice(0)) w();
      return;
    }
    this.running = true;
    void this.run(job)
      .catch((err) => this.onError(`thumbnail job failed: ${(err as Error).message}`))
      .finally(() => {
        void unlink(job.init).catch(() => undefined);
        void unlink(job.seg).catch(() => undefined);
        this.running = false;
        if (!this.closed) this.pump();
        else for (const w of this.idleWaiters.splice(0)) w();
      });
  }

  /** Waits until every queued job has run (tests). */
  async idle(): Promise<void> {
    await this.ready;
    if (!this.running && !this.queue.length) return;
    await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  private async run(job: Job): Promise<void> {
    await this.ready;
    const it = job.item;
    const wanted = this.grid(job.from, job.to).filter((k) => !it.tiles.has(k));
    if (!wanted.length || this.closed) return;
    if (!existsSync(job.init) || !existsSync(job.seg)) return;
    await mkdir(it.dir, { recursive: true });
    const iv = this.config.interval;
    // first frame at or after each grid time (within the tolerance), one per grid time
    const select = wanted
      .map((k) => `gte(t\\,${k * iv})*lt(t\\,${k * iv + TOLERANCE})*not(gte(prev_selected_t\\,${k * iv}))`)
      .join('+');
    const scale = it.w && it.h ? `scale=${it.w}:${it.h}` : `scale=${this.config.width}:trunc(ow/dar/2)*2`;
    const prefix = `job${this.jobSeq}_${Date.now()}_`;
    const args = [
      '-hide_banner', '-nostats', '-nostdin', '-loglevel', 'info', '-threads', '1',
      // keep the segment's own (playback) timestamps
      '-copyts', '-i', `concat:${job.init}|${job.seg}`,
      '-an', '-sn', '-dn', '-vf', `select='${select}',${scale},setsar=1,showinfo`,
      '-fps_mode', 'passthrough', '-q:v', '6', '-f', 'image2', path.join(it.dir, `${prefix}%d.jpg`),
    ];
    const stderr = await runFfmpeg(args);
    const frames = [...stderr.matchAll(/\bpts_time:\s*([\d.]+).*?\bs:(\d+)x(\d+)/g)].map((m) => ({ t: Number(m[1]), w: Number(m[2]), h: Number(m[3]) }));
    let added = 0;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      const tmp = path.join(it.dir, `${prefix}${i + 1}.jpg`);
      const k = Math.floor(f.t / iv + 1e-6);
      if (this.closed || !wanted.includes(k) || it.tiles.has(k) || f.t - k * iv >= TOLERANCE) {
        await unlink(tmp).catch(() => undefined);
        continue;
      }
      const size = (await stat(tmp).catch(() => null))?.size;
      if (!size) continue;
      if (!it.w || !it.h) {
        it.w = f.w;
        it.h = f.h;
        await writeFile(path.join(it.dir, 'meta.json'), JSON.stringify({ w: f.w, h: f.h, interval: iv }));
      }
      await rename(tmp, path.join(it.dir, `t${k}.jpg`));
      it.tiles.add(k);
      it.bytes += size;
      this.total += size;
      this.frameTimes.set(`${this.key(it.kind, it.id)}:${k}`, f.t);
      added++;
    }
    // leftovers of a failed run
    for (const f of await readdir(it.dir).catch(() => [] as string[])) {
      if (f.startsWith(prefix)) await unlink(path.join(it.dir, f)).catch(() => undefined);
    }
    if (added) {
      it.lastFilled = Date.now();
      this.touch(it);
      await this.evict();
    }
  }

  private touch(it: Item): void {
    const now = Date.now();
    it.lastUsed = now;
    // the directory's mtime carries "last used" across restarts; write it at most once a minute
    if (now - it.touchedDisk > 60_000 && existsSync(it.dir)) {
      it.touchedDisk = now;
      const d = new Date(now);
      void utimes(it.dir, d, d).catch(() => undefined);
    }
  }

  /** Removes least recently used items until the total fits the cap. */
  private async evict(): Promise<void> {
    if (this.total <= this.config.maxBytes) return;
    const now = Date.now();
    const victims = [...this.items.values()]
      .filter((it) => now - it.lastFilled > ACTIVE_MS && !this.queue.some((j) => j.item === it))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const it of victims) {
      if (this.total <= this.config.maxBytes) break;
      this.items.delete(this.key(it.kind, it.id));
      this.total -= it.bytes;
      await rm(it.dir, { recursive: true, force: true });
    }
  }

  /** Whether an item has anything cached (tests, diagnostics). */
  has(kind: ThumbKind, id: string): boolean {
    return (this.item(kind, id)?.tiles.size ?? 0) > 0;
  }

  async index(kind: ThumbKind, id: string): Promise<ThumbIndex> {
    await this.ready;
    const it = this.item(kind, id);
    const iv = this.config.interval;
    if (!it || !it.w || !it.h || !it.tiles.size) return { interval: iv, width: this.config.width, height: 0, tiles: [] };
    this.touch(it);
    const counts = new Map<number, number>();
    for (const k of it.tiles) counts.set(Math.floor(k / PER_SHEET), (counts.get(Math.floor(k / PER_SHEET)) ?? 0) + 1);
    const base = `/api/thumbs/${kind}/${encodeURIComponent(id)}/sheet`;
    const tiles = [...it.tiles].sort((a, b) => a - b).map((k) => {
      const sheet = Math.floor(k / PER_SHEET);
      const pos = k % PER_SHEET;
      return {
        start: k * iv,
        url: `${base}/${sheet}.jpg?v=${counts.get(sheet)}`,
        x: (pos % SHEET_COLS) * it.w!,
        y: Math.floor(pos / SHEET_COLS) * it.h!,
        w: it.w!,
        h: it.h!,
      };
    });
    return { interval: iv, width: it.w, height: it.h, tiles };
  }

  /** The sprite sheet file (built or rebuilt when tiles were added since), or null when it has no tiles. */
  async sheet(kind: ThumbKind, id: string, n: number): Promise<string | null> {
    await this.ready;
    const it = this.item(kind, id);
    if (!it || !it.w || !it.h || !Number.isInteger(n) || n < 0) return null;
    const ks = [...it.tiles].filter((k) => Math.floor(k / PER_SHEET) === n).sort((a, b) => a - b);
    if (!ks.length) return null;
    this.touch(it);
    const file = path.join(it.dir, `sheet${n}.jpg`);
    if (it.built.get(n) === ks.length && existsSync(file)) return file;
    const pending = it.building.get(n);
    if (pending) return pending;
    const build = this.buildSheet(it, n, ks, file).finally(() => it.building.delete(n));
    it.building.set(n, build);
    return build;
  }

  private async buildSheet(it: Item, n: number, ks: number[], file: string): Promise<string | null> {
    const blank = path.join(it.dir, 'blank.jpg');
    if (!existsSync(blank)) {
      await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', `color=c=black:s=${it.w}x${it.h}`, '-frames:v', '1', '-y', blank]);
    }
    const have = new Set(ks);
    const last = ks[ks.length - 1]! % PER_SHEET;
    const lines: string[] = [];
    for (let pos = 0; pos <= last; pos++) {
      const k = n * PER_SHEET + pos;
      lines.push(`file '${have.has(k) ? `t${k}.jpg` : 'blank.jpg'}'`);
    }
    const list = path.join(it.dir, `sheet${n}.txt`);
    const tmp = path.join(it.dir, `sheet${n}.tmp.jpg`);
    await writeFile(list, lines.join('\n') + '\n');
    try {
      await runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'concat', '-safe', '0', '-i', list,
        '-vf', `tile=${SHEET_COLS}x${SHEET_ROWS}:color=black`, '-frames:v', '1', '-q:v', '6', '-y', tmp,
      ]);
      const before = (await stat(file).catch(() => null))?.size ?? 0;
      const size = (await stat(tmp).catch(() => null))?.size ?? 0;
      if (!size) return null;
      await rename(tmp, file);
      it.bytes += size - before;
      this.total += size - before;
      it.built.set(n, ks.length);
      return file;
    } finally {
      await unlink(list).catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
    }
  }

  close(): void {
    this.closed = true;
    this.queue.splice(0);
  }
}

/** Runs ffmpeg at the lowest CPU priority; resolves with its stderr (rejects on failure). */
function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    if (proc.pid) {
      try {
        os.setPriority(proc.pid, 19);
      } catch {
        /* not permitted: run at normal priority */
      }
    }
    let err = '';
    proc.stderr.on('data', (d: Buffer) => {
      if (err.length < 200_000) err += d;
    });
    proc.on('error', () => reject(new Error('ffmpeg could not be started')));
    proc.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited ${code}`))));
  });
}
