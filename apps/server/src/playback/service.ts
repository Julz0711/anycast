/** Playback orchestration: PlaybackInfo decisions and the stream endpoints behind them. */
import type { PlaybackDiagnostics, PlaybackInfo, StreamProbe, StreamSource, TimelineInfo } from '@anycast/shared';
import type { FastifyBaseLogger } from 'fastify';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { epgFor, getChannel, getEpisode, getMovie, getSeries, type ChannelRow } from '../catalog/store';
import type { Db } from '../db';
import type { SourceService } from '../source';
import type { XtreamClient } from '../xtream/client';
import type { ClientCaps } from './caps';
import type { HlsPipeline } from './ffmpeg';
import { LiveFanouts } from './fanout';
import { HlsError, HlsSessions, StreamHlsSession, VodHlsSession } from './hls';
import { choosePipeline, explainPipeline, type PipelineChoice } from './pipeline';
import { ProbeCache, type ProbeResult } from './probe';
import { BufferManager } from './buffer';
import { buildTimeline, gapAt, sourceAt, type TimelineSource } from './timeline';
import type { BufferConfig } from '../config';
import type { Thumbnails } from './thumbs';
import { GapError, openUpstream, UpstreamError, UpstreamPool, type Lease } from './upstream';
import { Claims, ConnectionBusyError, holderOf, TakenOverError, type Claim, type Viewer } from './claims';

export type VodKind = 'movie' | 'episode';
const HLS_PIPELINES: readonly HlsPipeline[] = ['remux', 'transcode-audio', 'transcode'];
const MAX_TIMESHIFT_MIN = 240;
/** after a client moved on, late requests of its old player must not reopen the stream for this long */
const REVOKE_MS = 10 * 60_000;

const ASSUMED_LIVE: ProbeResult = { container: 'ts', duration: null, video: { codec: 'h264', width: null, height: null }, audio: [{ codec: 'aac', language: null, channels: 2 }], subtitles: [] };

/** The probe as the client sees it (codec facts only). */
export function toStreamProbe(p: ProbeResult): StreamProbe {
  return {
    container: p.container,
    duration: p.duration,
    video: p.video ? { codec: p.video.codec, width: p.video.width, height: p.video.height, fps: p.video.fps ?? null } : null,
    audio: p.audio.map((a) => ({ codec: a.codec, channels: a.channels, language: a.language })),
    subtitles: p.subtitles.map((t) => ({ codec: t.codec, language: t.language })),
  };
}

function diagnose(source: StreamSource, probe: ProbeResult, assumed: boolean, caps: ClientCaps, choice: PipelineChoice): PlaybackDiagnostics {
  const mode = source === 'movie' || source === 'episode' ? 'vod' : 'live';
  return { source, reason: explainPipeline(probe, caps, mode, choice, assumed), probe: toStreamProbe(probe), assumed };
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
}

export interface StreamBody {
  status: number;
  headers: Record<string, string>;
  body: Readable;
}

export class PlaybackService {
  readonly pool: UpstreamPool;
  readonly fanouts: LiveFanouts;
  readonly sessions: HlsSessions;
  /** rolling live buffer; null when disabled */
  readonly buffer: BufferManager | null;
  private readonly timelineSources: TimelineSource[];
  /** what each playback client watches (see claims.ts) */
  readonly claims = new Claims();
  /** connection keys whose playback was stopped (zapped away, closed, taken over), until asked for again */
  private readonly revoked = new Map<string, number>();
  /** direct (non-HLS) upstream streams per connection key, so they can be stopped at once */
  private readonly direct = new Map<string, Set<() => void>>();
  private lastRelease = 0;
  /** scrub thumbnails, fed from VOD HLS segments as they are written (no provider connection of their own) */
  thumbs: Thumbnails | null = null;
  /** a client's playback was stopped because `by` took its connection over */
  onTakenOver: (victim: Claim, by: Viewer) => void = () => undefined;

  constructor(
    private readonly db: Db,
    private readonly source: SourceService,
    readonly probes: ProbeCache,
    private readonly log: FastifyBaseLogger,
    private readonly redact: () => (s: string) => string,
    timelineSources: TimelineSource[],
    buffer: { dir: string; config: BufferConfig } | null = null,
  ) {
    this.pool = new UpstreamPool(() => source.maxConnections());
    this.fanouts = new LiveFanouts(this.pool);
    this.sessions = new HlsSessions();
    this.buffer =
      buffer && buffer.config.enabled
        ? new BufferManager(buffer.dir, buffer.config, {
            db,
            fanouts: this.fanouts,
            liveUrl: (id) => this.client().liveUrl(id),
            maxConnections: () => source.maxConnections(),
            onError: (msg) => this.log.warn({ buffer: this.redact()(msg) }, 'live buffer problem'),
          })
        : null;
    this.timelineSources = this.buffer ? [...timelineSources, this.buffer.source] : timelineSources;
  }

  private client(): XtreamClient {
    const c = this.source.client();
    if (!c) throw new UpstreamError(503, 'No provider is configured');
    return c;
  }

  private ffmpegError = (msg: string) => this.log.warn({ ffmpeg: this.redact()(msg) }, 'ffmpeg failed');

  private channel(id: string): ChannelRow {
    const c = getChannel(this.db, id);
    if (!c) throw new NotFoundError('Channel not found');
    return c;
  }

  private vodItem(kind: VodKind, id: string): { url: () => string; container: string | null; duration: number | null; seriesId: string | null; title: string } {
    const row = kind === 'movie' ? getMovie(this.db, id) : getEpisode(this.db, id);
    if (!row) throw new NotFoundError(kind === 'movie' ? 'Movie not found' : 'Episode not found');
    const url = () => (kind === 'movie' ? this.client().movieUrl(id, row.container) : this.client().episodeUrl(id, row.container));
    let title = 'name' in row ? row.name : row.title;
    if ('series_id' in row) {
      const series = getSeries(this.db, row.series_id);
      if (series) title = `${series.name} S${row.season} E${row.episode}`;
    }
    return { url, container: row.container, duration: row.duration, seriesId: 'series_id' in row ? row.series_id : null, title };
  }

  private async probe(key: string, url: () => string, fallback: ProbeResult): Promise<ProbeResult> {
    const cached = this.probes.cached(key);
    if (cached) return cached;
    const lease = this.pool.acquire(key);
    try {
      return await this.probes.get(key, url);
    } catch (err) {
      // right after we dropped a connection the panel may still count it: try once more
      if (Date.now() - this.lastRelease < 5000) {
        await new Promise((r) => setTimeout(r, 1200));
        const again = await this.probes.get(key, url).catch(() => null);
        if (again) return again;
      }
      this.log.warn({ key, err: this.redact()(String((err as Error).message)) }, 'probe failed, assuming defaults');
      return fallback;
    } finally {
      lease.release();
    }
  }

  // ----- connection arbitration -----

  /**
   * A client asks to play `key` (null: needs no provider connection). Its previous playback is
   * released first, so zapping never holds two connections. When every connection is in use,
   * recordings kept only for the grace period give theirs up; otherwise the holder is named
   * (ConnectionBusyError) so the client can offer to take over.
   */
  private begin(viewer: Viewer | null, key: string | null, title: string, needSlot = key !== null): void {
    if (viewer) {
      const prev = this.claims.set(viewer, key, title);
      if (key) this.revoked.delete(key);
      if (prev?.key && prev.key !== key && !this.claims.holders(prev.key).length) this.release(prev.key);
    }
    if (!key || !needSlot) return;
    try {
      this.ensureSlot(key, viewer);
    } catch (err) {
      if (viewer) this.claims.set(viewer, null, title);
      throw err;
    }
  }

  private ensureSlot(key: string, viewer: Viewer | null): void {
    if (this.pool.has(key) || !this.pool.full()) return;
    for (const id of this.buffer?.idleRecordings() ?? []) {
      if (this.buffer!.stopNow(id)) this.fanouts.close(`live:${id}`);
      if (!this.pool.full()) return;
    }
    const victim = this.victim(viewer?.clientId);
    if (victim) throw new ConnectionBusyError(holderOf(victim));
    this.pool.check(key);
  }

  /** The client using a connection that `except` could take over. */
  private victim(except?: string): Claim | undefined {
    for (const key of this.pool.keys()) {
      const holder = this.claims.holders(key, except)[0];
      if (holder) return holder;
    }
    return undefined;
  }

  /**
   * Stops what is served for `key` now: HLS sessions, direct streams, live viewers. A live
   * channel's recorder keeps the connection for its grace period, unless connections are scarce
   * (all in use) or `force`. Late requests of the old player get 409 until `key` is asked for again.
   */
  private release(key: string, force = false): void {
    const scarce = force || this.pool.full();
    this.lastRelease = Date.now();
    this.revoked.set(key, Date.now() + REVOKE_MS);
    this.sessions.closeWhere((k) => k.startsWith(`${key}:`));
    for (const stop of [...(this.direct.get(key) ?? [])]) stop();
    if (key.startsWith('live:')) {
      const id = key.slice(5);
      const recording = this.buffer?.isRecording(id) ?? false;
      if (recording && scarce && this.buffer!.stopNow(id)) this.fanouts.close(key);
      else if (recording) this.fanouts.dropViewers(key);
      else this.fanouts.close(key);
    }
  }

  private guard(key: string): void {
    const until = this.revoked.get(key);
    if (until === undefined) return;
    if (until > Date.now()) throw new TakenOverError();
    this.revoked.delete(key);
  }

  /** Registers a direct upstream stream so release() can stop it. */
  private trackDirect(key: string, stop: () => void): () => void {
    const set = this.direct.get(key) ?? new Set();
    set.add(stop);
    this.direct.set(key, set);
    return () => {
      set.delete(stop);
      if (!set.size && this.direct.get(key) === set) this.direct.delete(key);
    };
  }

  /** Stops the playback whose connection `viewer` was refused; its client is told (onTakenOver). */
  takeover(viewer: Viewer): boolean {
    const victim = this.victim(viewer.clientId);
    if (!victim?.key) {
      for (const id of this.buffer?.idleRecordings() ?? []) if (this.buffer!.stopNow(id)) this.fanouts.close(`live:${id}`);
      return false;
    }
    for (const c of this.claims.holders(victim.key, viewer.clientId)) {
      this.claims.delete(c.clientId);
      this.onTakenOver(c, viewer);
    }
    this.release(victim.key, true);
    return true;
  }

  /** The client closed its player: release its connection now. */
  stopClient(clientId: string): void {
    const prev = this.claims.delete(clientId);
    if (prev?.key && !this.claims.holders(prev.key).length) this.release(prev.key);
  }

  // ----- PlaybackInfo -----

  async liveInfo(id: string, caps: ClientCaps, viewer: Viewer | null = null): Promise<PlaybackInfo> {
    const channel = this.channel(id);
    const key = `live:${id}`;
    this.begin(viewer, key, channel.name);
    const probe = await this.probe(key, () => this.client().liveUrl(id), ASSUMED_LIVE);
    const choice = choosePipeline({ ...probe, container: 'ts' }, caps, 'live');
    const base = `/api/stream/live/${encodeURIComponent(id)}`;
    return {
      url: choice.pipeline === 'passthrough' ? `${base}.ts` : `${base}/${choice.pipeline}/index.m3u8`,
      type: choice.type,
      pipeline: choice.pipeline,
      startsAt: Date.now(),
      diagnostics: diagnose('live', probe, probe === ASSUMED_LIVE, caps, choice),
    };
  }

  timeline(id: string, now = Date.now()): TimelineInfo {
    const channel = this.channel(id);
    const { window, ...t } = buildTimeline(channel, this.timelineSources, now);
    return { ...t, programs: epgFor(this.db, [channel], window.start, window.end)[channel.id] ?? [] };
  }

  async atInfo(id: string, at: number, caps: ClientCaps, viewer: Viewer | null = null): Promise<PlaybackInfo> {
    const channel = this.channel(id);
    const now = Date.now();
    if (at >= now) return this.liveInfo(id, caps, viewer);
    const timeline = buildTimeline(channel, this.timelineSources, now);
    const range = sourceAt(timeline, at);
    const gap = () => {
      const g = gapAt(timeline, at);
      return new GapError(g.reason, g.cause);
    };
    if (!range) throw gap();
    if (range.source === 'live') return this.liveInfo(id, caps, viewer);
    if (range.source === 'buffer') {
      const seg = this.buffer?.segmentAt(id, at);
      if (!seg) throw gap();
      // the buffer needs no connection; while the channel still records, the viewer keeps its
      // claim on it, so the recording (the connection) is not given away under them
      const live = `live:${id}`;
      this.begin(viewer, this.buffer?.isRecording(id) && this.fanouts.isOpen(live) ? live : null, channel.name, false);
      return this.bufferInfo(id, seg.run_id, seg.seq, seg.start_ms, caps);
    }
    const startMin = Math.floor(at / 60_000);
    const durMin = Math.min(MAX_TIMESHIFT_MIN, Math.ceil((now - startMin * 60_000) / 60_000));
    const key = `ts:${id}:${startMin}`;
    this.begin(viewer, key, channel.name);
    const probe = this.probes.cached(`live:${id}`) ?? ASSUMED_LIVE;
    const choice = choosePipeline({ ...probe, container: 'ts' }, caps, 'live');
    const base = `/api/stream/timeshift/${encodeURIComponent(id)}/${startMin}/${durMin}`;
    return {
      url: choice.pipeline === 'passthrough' ? `${base}.ts` : `${base}/${choice.pipeline}/index.m3u8`,
      type: choice.type,
      pipeline: choice.pipeline,
      startsAt: startMin * 60_000,
      diagnostics: diagnose('timeshift', probe, probe === ASSUMED_LIVE, caps, choice),
    };
  }

  /** Buffered playback: the recorded TS segments as an EVENT playlist, or through FFmpeg when the client needs other codecs. */
  private bufferInfo(id: string, run: number, seq: number, startsAt: number, caps: ClientCaps): PlaybackInfo {
    const probe = this.probes.cached(`live:${id}`) ?? ASSUMED_LIVE;
    const choice = choosePipeline({ ...probe, container: 'ts' }, caps, 'live');
    const base = `/api/stream/buffer/${encodeURIComponent(id)}/${run}/${seq}`;
    const assumed = probe === ASSUMED_LIVE;
    if (choice.pipeline === 'transcode' || choice.pipeline === 'transcode-audio') {
      return { url: `${base}/${choice.pipeline}/index.m3u8`, type: 'hls', pipeline: choice.pipeline, startsAt, diagnostics: diagnose('buffer', probe, assumed, caps, choice) };
    }
    const served: PipelineChoice = { pipeline: 'passthrough', type: 'hls' };
    return { url: `${base}/index.m3u8`, type: 'hls', pipeline: 'passthrough', startsAt, diagnostics: diagnose('buffer', probe, assumed, caps, served) };
  }

  private requireBuffer(): BufferManager {
    if (!this.buffer) throw new NotFoundError('The live buffer is turned off');
    return this.buffer;
  }

  bufferPlaylist(id: string, run: number, from: number): string {
    const text = this.requireBuffer().playlist(id, run, from);
    if (!text) throw new NotFoundError('This part of the buffer is no longer available');
    return text;
  }

  bufferSegment(id: string, run: number, seq: number): string {
    const file = this.requireBuffer().segment(id, run, seq);
    if (!file) throw new HlsError(404, 'Segment not available');
    return file;
  }

  async bufferHls(id: string, run: number, from: number, pipeline: HlsPipeline, file: string) {
    const buffer = this.requireBuffer();
    if (!buffer.playlist(id, run, from)) throw new NotFoundError('This part of the buffer is no longer available');
    const session = await this.sessions.getOrCreate(`buf:${id}:${run}:${from}:${pipeline}`, (dir) => {
      return new StreamHlsSession(dir, { stream: buffer.reader(id, run, from) }, pipeline, 'event', null, this.ffmpegError, this.liveAudio(id));
    });
    return file === 'index.m3u8' ? { text: await session.playlist() } : { files: await session.file(file) };
  }

  async vodInfo(kind: VodKind, id: string, caps: ClientCaps, resumeAt: number | null, viewer: Viewer | null = null): Promise<PlaybackInfo> {
    const item = this.vodItem(kind, id);
    const key = `${kind}:${id}`;
    this.begin(viewer, key, item.title);
    const fallback: ProbeResult = { container: item.container, duration: item.duration, video: null, audio: [], subtitles: [] };
    const probe = await this.probe(key, item.url, fallback);
    const choice = choosePipeline(probe, caps, 'vod');
    const base = `/api/stream/${kind}/${encodeURIComponent(id)}`;
    return {
      url: choice.pipeline === 'passthrough' ? `${base}/video.mp4` : `${base}/${choice.pipeline}/index.m3u8`,
      type: choice.type,
      pipeline: choice.pipeline,
      ...(resumeAt ? { resumeAt } : {}),
      ...(item.seriesId ? { seriesId: item.seriesId } : {}),
      diagnostics: diagnose(kind, probe, probe === fallback, caps, choice),
    };
  }

  // ----- streams -----

  async liveTs(id: string): Promise<Readable> {
    this.channel(id);
    this.guard(`live:${id}`);
    return this.fanouts.subscribe(`live:${id}`, () => this.client().liveUrl(id));
  }

  /** Live HLS shares one session (and the fan-out upstream) per channel + pipeline. */
  async liveHls(id: string, pipeline: HlsPipeline, file: string): Promise<{ text: string } | { files: string[] }> {
    this.channel(id);
    const key = `live:${id}:${pipeline}`;
    const session = await this.sessions.getOrCreate(key, async (dir) => {
      this.guard(`live:${id}`);
      const stream = await this.fanouts.subscribe(`live:${id}`, () => this.client().liveUrl(id));
      return new StreamHlsSession(dir, { stream }, pipeline, 'live', null, this.ffmpegError, this.liveAudio(id));
    });
    return file === 'index.m3u8' ? { text: await session.playlist() } : { files: await session.file(file) };
  }

  async timeshiftTs(id: string, startMin: number, durMin: number, signal: AbortSignal): Promise<StreamBody> {
    this.channel(id);
    const key = `ts:${id}:${startMin}`;
    this.guard(key);
    return this.directStream(key, this.pool.acquire(key), signal, async (s) => {
      const res = await openUpstream(this.timeshiftUrl(id, startMin, durMin), s);
      return { res, status: 200, headers: { 'content-type': 'video/mp2t' } };
    });
  }

  /** A direct upstream stream that release() can stop at once (the lease is freed right away). */
  private async directStream(
    key: string,
    lease: Lease,
    signal: AbortSignal,
    open: (signal: AbortSignal) => Promise<{ res: Response; status: number; headers: Record<string, string> }>,
  ): Promise<StreamBody> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort);
    let body: Readable | null = null;
    const untrack = this.trackDirect(key, () => {
      ac.abort();
      body?.destroy();
      lease.release();
    });
    const done = () => {
      untrack();
      signal.removeEventListener('abort', onAbort);
      lease.release();
    };
    try {
      const { res, status, headers } = await open(ac.signal);
      body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
      body.on('close', done);
      body.on('error', () => undefined);
      if (ac.signal.aborted) body.destroy();
      return { status, headers, body };
    } catch (err) {
      done();
      throw ac.signal.aborted && !signal.aborted ? new TakenOverError() : err;
    }
  }

  private timeshiftUrl(id: string, startMin: number, durMin: number): string {
    return this.client().timeshiftUrl(id, startMin * 60_000, Math.min(MAX_TIMESHIFT_MIN, durMin), this.source.timezone());
  }

  async timeshiftHls(id: string, startMin: number, durMin: number, pipeline: HlsPipeline, file: string) {
    this.channel(id);
    const key = `ts:${id}:${startMin}`;
    const sessionKey = `${key}:${durMin}:${pipeline}`;
    const session = await this.sessions.getOrCreate(sessionKey, (dir) => {
      this.guard(key);
      const lease = this.pool.acquire(key);
      return new StreamHlsSession(dir, { url: this.timeshiftUrl(id, startMin, durMin) }, pipeline, 'event', lease, this.ffmpegError, this.liveAudio(id));
    });
    return file === 'index.m3u8' ? { text: await session.playlist() } : { files: await session.file(file) };
  }

  /** The live channel's audio codec, from its probe (or the assumed live defaults). */
  private liveAudio(id: string): string | null {
    return (this.probes.cached(`live:${id}`) ?? ASSUMED_LIVE).audio[0]?.codec ?? null;
  }

  /** Progressive passthrough with Range support. */
  async vodFile(kind: VodKind, id: string, range: string | undefined, signal: AbortSignal): Promise<StreamBody> {
    const item = this.vodItem(kind, id);
    const key = `${kind}:${id}`;
    this.guard(key);
    return this.directStream(key, this.pool.acquire(key), signal, async (s) => {
      const res = await openUpstream(item.url(), s, range ? { range } : {});
      const headers: Record<string, string> = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
      for (const h of ['content-length', 'content-range', 'last-modified', 'etag']) {
        const v = res.headers.get(h);
        if (v) headers[h] = v;
      }
      return { res, status: res.status, headers };
    });
  }

  async vodHls(kind: VodKind, id: string, pipeline: HlsPipeline, file: string): Promise<{ text: string } | { files: string[] }> {
    const item = this.vodItem(kind, id);
    const key = `${kind}:${id}`;
    const sessionKey = `${key}:${pipeline}`;
    const session = await this.sessions.getOrCreate(sessionKey, (dir) => {
      this.guard(key);
      this.pool.check(key);
      const probe = this.probes.cached(key);
      // ffprobe can only estimate a TS file's length from its bitrate when it cannot open a second
      // connection to read the end (one-connection providers); then the catalog's length is better
      const probed = probe?.duration ?? null;
      const duration = probed && item.duration && Math.abs(probed - item.duration) > item.duration * 0.1 ? item.duration : (probed ?? item.duration);
      if (!duration) throw new HlsError(422, 'The video length is unknown, so it cannot be prepared for this device');
      const acquire = () => {
        this.guard(key);
        return this.pool.acquire(key);
      };
      const thumbs = this.thumbs;
      const onSegment = thumbs ? (seg: Parameters<Thumbnails['ingest']>[2]) => thumbs.ingest(kind, id, seg) : undefined;
      return new VodHlsSession(dir, item.url, pipeline, duration, acquire, this.ffmpegError, probe?.audio[0]?.codec ?? null, onSegment);
    });
    if (file === 'index.m3u8') return { text: session.playlist() };
    if (file === 'init.mp4') return { files: await session.init() };
    const m = /^seg\/(\d+)\.m4s$/.exec(file);
    if (!m) throw new HlsError(404, 'Not found');
    return { files: await session.segment(Number(m[1])) };
  }

  async close(): Promise<void> {
    await this.buffer?.close();
    this.sessions.closeAll();
    this.thumbs?.close();
  }
}

export function isHlsPipeline(p: string): p is HlsPipeline {
  return (HLS_PIPELINES as readonly string[]).includes(p);
}

