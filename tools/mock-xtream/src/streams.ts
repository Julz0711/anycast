/**
 * Stream endpoints: live TS, live HLS, timeshift and VOD (movie/series) with HTTP Range.
 *
 * Error behaviour (like real panels, empty bodies):
 *   - wrong credentials or expired account: 403
 *   - connection limit reached: 509 (configurable via faults.connectionLimitStatus)
 *   - unknown id / no archive / time outside the archive window: 404 (+ X-Mock-Error header)
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { LiveChannel } from './catalog.js';
import type { ConnectionKind } from './connections.js';
import { checkCredentials, nowSec, type MockContext } from './context.js';
import { sleep } from './faults.js';
import {
  ensureVodFixture,
  killProcess,
  liveArgs,
  removeDir,
  spawnFfmpeg,
  type FfmpegProcess,
} from './ffmpeg.js';
import { PROFILES, type VodProfileId } from './formats.js';
import { formatLocal, parseTimeshiftStart, secondsOfDay } from './tz.js';

const DAY = 86400;
const HLS_IDLE_MS = 30_000;

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  ts: 'video/mp2t',
};

interface Rejection {
  status: number;
  error?: string;
}

interface HlsSession {
  dir: string;
  proc: FfmpegProcess;
  epoch: number;
  lastAccess: number;
}

export class StreamService {
  private readonly active = new Set<() => void>();
  private readonly hls = new Map<number, Promise<HlsSession>>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly ctx: MockContext) {
    this.sweeper = setInterval(() => void this.sweepHls(), 5000);
    this.sweeper.unref();
  }

  // -------------------------------------------------------------------------------------------
  // Shared gatekeeping
  // -------------------------------------------------------------------------------------------

  private reject(reply: FastifyReply, r: Rejection): FastifyReply {
    if (r.error) reply.header('X-Mock-Error', r.error);
    return reply.code(r.status).send('');
  }

  /** Credentials and account status. */
  private gate(u: unknown, p: unknown): Rejection | null {
    if (!checkCredentials(this.ctx, u, p)) return { status: 403, error: 'invalid credentials' };
    if (this.ctx.faults.get().expired) return { status: 403, error: 'account expired' };
    return null;
  }

  private limitRejection(): Rejection {
    return { status: this.ctx.faults.get().connectionLimitStatus, error: 'max connections reached' };
  }

  /** Load-balanced panels answer the first request with a 302 to a tokenised URL. */
  private maybeRedirect(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!this.ctx.faults.get().redirectStreams) return false;
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.has('token')) return false;
    url.searchParams.set('token', randomBytes(8).toString('hex'));
    void reply.redirect(`${url.pathname}${url.search}`, 302);
    return true;
  }

  /**
   * Opens a counted stream response: acquires a connection slot, applies slowStart/drop faults,
   * and calls `start` to write the body. Cleanup runs once when the response closes.
   */
  private async serve(
    req: FastifyRequest,
    reply: FastifyReply,
    meta: { kind: ConnectionKind; streamId: number },
    start: (res: FastifyReply['raw'], onCleanup: (fn: () => void) => void) => Promise<void> | void,
  ): Promise<FastifyReply | void> {
    const faults = this.ctx.faults.get();
    if (faults.connectionLimitReached) return this.reject(reply, this.limitRejection());
    const connId = this.ctx.connections.acquire(
      { username: this.ctx.username, kind: meta.kind, streamId: meta.streamId, ip: req.ip },
      this.ctx.maxConnections,
    );
    if (connId === null) return this.reject(reply, this.limitRejection());

    reply.hijack();
    const res = reply.raw;
    const cleanups: (() => void)[] = [() => this.ctx.connections.release(connId)];
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      this.active.delete(abort);
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    };
    const abort = (): void => {
      cleanup();
      res.destroy();
    };
    this.active.add(abort);
    res.on('close', cleanup);
    if (faults.dropAfterSeconds > 0) {
      const t = setTimeout(abort, faults.dropAfterSeconds * 1000);
      cleanups.push(() => clearTimeout(t));
    }
    try {
      if (faults.slowStartMs > 0) await sleep(faults.slowStartMs);
      if (closed) return;
      await start(res, (fn) => (closed ? fn() : cleanups.push(fn)));
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'X-Mock-Error': String((e as Error).message).slice(0, 200).replace(/[\r\n]/g, ' ') });
      }
      res.end();
      cleanup();
    }
  }

  /** Pipes an ffmpeg MPEG-TS process into the response. */
  private pipeFfmpeg(
    res: FastifyReply['raw'],
    onCleanup: (fn: () => void) => void,
    args: string[],
    headers: Record<string, string>,
  ): void {
    const proc = spawnFfmpeg(args, this.ctx.timezone);
    onCleanup(() => killProcess(proc));
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-cache', ...headers });
    proc.stdout.pipe(res);
  }

  private contentHeaders(c: LiveChannel, epoch: number, ptsOffset: number): Record<string, string> {
    return {
      'X-Mock-Stream-Id': String(c.id),
      'X-Mock-Content-Start': String(epoch),
      'X-Mock-Content-Start-Local': formatLocal(epoch, this.ctx.timezone),
      'X-Mock-Pts-Offset': ptsOffset.toFixed(3),
      'X-Mock-Profile': c.profile,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Live
  // -------------------------------------------------------------------------------------------

  async live(req: FastifyRequest, reply: FastifyReply, u: string, p: string, file: string) {
    const m = /^(\d+)(?:\.(ts|m3u8|m3u))?$/.exec(file);
    if (!m) return this.reject(reply, { status: 404, error: 'bad stream path' });
    if (m[2] === 'm3u8' || m[2] === 'm3u') return this.hlsPlaylist(req, reply, u, p, Number(m[1]));
    const denied = this.gate(u, p);
    if (denied) return this.reject(reply, denied);
    const channel = this.ctx.catalog.liveById.get(Number(m[1]));
    if (!channel) return this.reject(reply, { status: 404, error: 'unknown stream' });
    if (this.maybeRedirect(req, reply)) return reply;
    if (req.method === 'HEAD') return reply.code(200).header('Content-Type', 'video/mp2t').send('');

    return this.serve(req, reply, { kind: 'live', streamId: channel.id }, async (res, onCleanup) => {
      const epoch = nowSec(this.ctx);
      const ptsOffset = secondsOfDay(epoch, this.ctx.timezone);
      const args = await liveArgs({
        cacheDir: this.ctx.cacheDir,
        label: channel.name,
        profile: channel.profile,
        epoch,
        ptsOffset,
        realtime: true,
        serviceName: channel.name,
        output: { kind: 'pipe' },
      });
      this.pipeFfmpeg(res, onCleanup, args, this.contentHeaders(channel, epoch, ptsOffset));
    });
  }

  // -------------------------------------------------------------------------------------------
  // Timeshift
  // -------------------------------------------------------------------------------------------

  async timeshift(
    req: FastifyRequest,
    reply: FastifyReply,
    q: { u: unknown; p: unknown; duration: unknown; start: unknown; stream: unknown },
  ) {
    const denied = this.gate(q.u, q.p);
    if (denied) return this.reject(reply, denied);
    const channel = this.ctx.catalog.liveById.get(Number(String(q.stream).replace(/\.(ts|m3u8)$/, '')));
    if (!channel) return this.reject(reply, { status: 404, error: 'unknown stream' });
    if (!channel.archive) return this.reject(reply, { status: 404, error: 'channel has no archive' });
    const start = typeof q.start === 'string' ? parseTimeshiftStart(q.start, this.ctx.timezone) : null;
    const minutes = Number(q.duration);
    if (start === null || !Number.isFinite(minutes) || minutes <= 0) {
      return this.reject(reply, { status: 404, error: 'bad start or duration' });
    }
    const now = nowSec(this.ctx);
    if (start >= now || start < now - channel.archiveDays * DAY) {
      return this.reject(reply, { status: 404, error: 'time outside archive window' });
    }
    if (this.maybeRedirect(req, reply)) return reply;
    if (req.method === 'HEAD') return reply.code(200).header('Content-Type', 'video/mp2t').send('');
    const durationSec = Math.min(minutes * 60, now - start);

    return this.serve(req, reply, { kind: 'timeshift', streamId: channel.id }, async (res, onCleanup) => {
      const ptsOffset = secondsOfDay(start, this.ctx.timezone);
      const args = await liveArgs({
        cacheDir: this.ctx.cacheDir,
        label: `${channel.name} [ARCHIVE]`,
        profile: channel.profile,
        epoch: start,
        ptsOffset,
        realtime: false,
        durationSec,
        serviceName: channel.name,
        output: { kind: 'pipe' },
      });
      this.pipeFfmpeg(res, onCleanup, args, {
        ...this.contentHeaders(channel, start, ptsOffset),
        'X-Mock-Duration': String(durationSec),
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // HLS live
  // -------------------------------------------------------------------------------------------

  private hlsSession(channel: LiveChannel): Promise<HlsSession> {
    const existing = this.hls.get(channel.id);
    if (existing) return existing;
    const created = (async () => {
      const dir = await mkdtemp(join(this.ctx.cacheDir, `hls-${channel.id}-`));
      const epoch = nowSec(this.ctx);
      const args = await liveArgs({
        cacheDir: this.ctx.cacheDir,
        label: channel.name,
        profile: channel.profile,
        epoch,
        ptsOffset: secondsOfDay(epoch, this.ctx.timezone),
        realtime: true,
        serviceName: channel.name,
        output: { kind: 'hls', dir },
      });
      const proc = spawnFfmpeg(args, this.ctx.timezone);
      proc.stdout.resume();
      const session: HlsSession = { dir, proc, epoch, lastAccess: Date.now() };
      proc.on('exit', () => {
        if (this.hls.get(channel.id) === created) this.hls.delete(channel.id);
        void removeDir(dir);
      });
      return session;
    })();
    this.hls.set(channel.id, created);
    created.catch(() => this.hls.delete(channel.id));
    return created;
  }

  private async sweepHls(): Promise<void> {
    for (const [id, p] of this.hls) {
      const s = await p.catch(() => null);
      if (s && Date.now() - s.lastAccess > HLS_IDLE_MS) {
        this.hls.delete(id);
        killProcess(s.proc);
        await removeDir(s.dir);
      }
    }
  }

  async hlsPlaylist(req: FastifyRequest, reply: FastifyReply, u: string, p: string, id: number) {
    const denied = this.gate(u, p);
    if (denied) return this.reject(reply, denied);
    const channel = this.ctx.catalog.liveById.get(id);
    if (!channel) return this.reject(reply, { status: 404, error: 'unknown stream' });
    const faults = this.ctx.faults.get();
    if (faults.connectionLimitReached) return this.reject(reply, this.limitRejection());
    if (!this.ctx.connections.touchHls({ username: this.ctx.username, streamId: id, ip: req.ip }, this.ctx.maxConnections)) {
      return this.reject(reply, this.limitRejection());
    }
    if (faults.slowStartMs > 0) await sleep(faults.slowStartMs);
    const session = await this.hlsSession(channel);
    session.lastAccess = Date.now();
    const playlistFile = join(session.dir, 'index.m3u8');
    const deadline = Date.now() + 20_000;
    while (!existsSync(playlistFile)) {
      if (Date.now() > deadline || session.proc.exitCode !== null) {
        return this.reject(reply, { status: 503, error: 'hls not ready' });
      }
      await sleep(200);
    }
    const playlist = await readFile(playlistFile, 'utf8');
    const rewritten = playlist.replace(/^(seg_\d+\.ts)$/gm, `/hls/${encodeURIComponent(u)}/${encodeURIComponent(p)}/${id}/$1`);
    return reply
      .code(200)
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .header('Cache-Control', 'no-cache')
      .header('X-Mock-Content-Start', String(session.epoch))
      .send(rewritten);
  }

  async hlsSegment(req: FastifyRequest, reply: FastifyReply, u: string, p: string, id: number, seg: string) {
    const denied = this.gate(u, p);
    if (denied) return this.reject(reply, denied);
    if (!/^seg_\d+\.ts$/.test(seg)) return this.reject(reply, { status: 404 });
    const session = await this.hls.get(id)?.catch(() => null);
    if (!session) return this.reject(reply, { status: 404, error: 'no hls session' });
    session.lastAccess = Date.now();
    this.ctx.connections.touchHls({ username: this.ctx.username, streamId: id, ip: req.ip }, Infinity);
    try {
      const data = await readFile(join(session.dir, seg));
      return reply.code(200).header('Content-Type', 'video/mp2t').send(data);
    } catch {
      return this.reject(reply, { status: 404, error: 'segment expired' });
    }
  }

  // -------------------------------------------------------------------------------------------
  // VOD
  // -------------------------------------------------------------------------------------------

  async vod(req: FastifyRequest, reply: FastifyReply, kind: 'movie' | 'series', u: string, p: string, file: string) {
    const denied = this.gate(u, p);
    if (denied) return this.reject(reply, denied);
    const id = Number(/^(\d+)/.exec(file)?.[1]);
    const { catalog } = this.ctx;
    let item: { id: number; label: string; profile: VodProfileId; durationSecs: number } | undefined;
    if (kind === 'movie') {
      const m = catalog.movieById.get(id);
      if (m) item = { id: m.id, label: m.name, profile: m.profile, durationSecs: m.durationSecs };
    } else {
      const e = catalog.episodeById.get(id);
      if (e) item = { id: e.id, label: e.title, profile: e.profile, durationSecs: e.durationSecs };
    }
    if (!item) return this.reject(reply, { status: 404, error: 'unknown item' });
    if (this.maybeRedirect(req, reply)) return reply;
    const found = item;

    return this.serve(req, reply, { kind, streamId: found.id }, async (res, onCleanup) => {
      const path = await ensureVodFixture({
        cacheDir: this.ctx.cacheDir,
        kind: kind === 'movie' ? 'movie' : 'episode',
        id: found.id,
        label: found.label,
        profile: found.profile,
        durationSecs: found.durationSecs,
      });
      if (res.destroyed) return;
      const size = (await stat(path)).size;
      const headers: Record<string, string | number> = {
        'Content-Type': CONTENT_TYPES[PROFILES[found.profile].container] ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'X-Mock-Profile': found.profile,
        'X-Mock-Duration': String(found.durationSecs),
      };
      const range = parseRange(req.headers.range, size);
      if (range === 'invalid') {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
        res.end();
        return;
      }
      const [startByte, endByte] = range ?? [0, size - 1];
      headers['Content-Length'] = endByte - startByte + 1;
      if (range) headers['Content-Range'] = `bytes ${startByte}-${endByte}/${size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(path, { start: startByte, end: endByte });
      onCleanup(() => stream.destroy());
      stream.pipe(res);
    });
  }

  /** Aborts every open stream and stops HLS generators. */
  async closeAll(): Promise<void> {
    for (const abort of [...this.active]) abort();
    const sessions = [...this.hls.values()];
    this.hls.clear();
    for (const p of sessions) {
      const s = await p.catch(() => null);
      if (s) {
        killProcess(s.proc);
        await removeDir(s.dir);
      }
    }
  }

  async dispose(): Promise<void> {
    clearInterval(this.sweeper);
    await this.closeAll();
  }

  activeHlsChannels(): number[] {
    return [...this.hls.keys()];
  }
}

/** Parses a single-range "bytes=" header. null = no/unsupported range (serve whole file). */
export function parseRange(header: string | undefined, size: number): [number, number] | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return [start, end];
}
