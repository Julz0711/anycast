/** Playback orchestration: PlaybackInfo decisions and the stream endpoints behind them. */
import type { PlaybackInfo, TimelineInfo } from '@anycast/shared';
import type { FastifyBaseLogger } from 'fastify';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { epgFor, getChannel, getEpisode, getMovie, type ChannelRow } from '../catalog/store';
import type { Db } from '../db';
import type { SourceService } from '../source';
import type { XtreamClient } from '../xtream/client';
import type { ClientCaps } from './caps';
import type { HlsPipeline } from './ffmpeg';
import { LiveFanouts } from './fanout';
import { HlsError, HlsSessions, StreamHlsSession, VodHlsSession } from './hls';
import { choosePipeline } from './pipeline';
import { ProbeCache, type ProbeResult } from './probe';
import { buildTimeline, LIVE_EDGE_MS, noArchiveReason, sourceAt, type TimelineSource } from './timeline';
import { openUpstream, UpstreamError, UpstreamPool } from './upstream';

export type VodKind = 'movie' | 'episode';
const HLS_PIPELINES: readonly HlsPipeline[] = ['remux', 'transcode-audio', 'transcode'];
const MAX_TIMESHIFT_MIN = 240;

const ASSUMED_LIVE: ProbeResult = { container: 'ts', duration: null, video: { codec: 'h264', width: null, height: null }, audio: [{ codec: 'aac', language: null, channels: 2 }], subtitles: [] };

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

  constructor(
    private readonly db: Db,
    private readonly source: SourceService,
    readonly probes: ProbeCache,
    private readonly log: FastifyBaseLogger,
    private readonly redact: () => (s: string) => string,
    private readonly timelineSources: TimelineSource[],
  ) {
    this.pool = new UpstreamPool(() => source.maxConnections());
    this.fanouts = new LiveFanouts(this.pool);
    this.sessions = new HlsSessions();
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

  private vodItem(kind: VodKind, id: string): { url: () => string; container: string | null; duration: number | null } {
    const row = kind === 'movie' ? getMovie(this.db, id) : getEpisode(this.db, id);
    if (!row) throw new NotFoundError(kind === 'movie' ? 'Movie not found' : 'Episode not found');
    const url = () => (kind === 'movie' ? this.client().movieUrl(id, row.container) : this.client().episodeUrl(id, row.container));
    return { url, container: row.container, duration: row.duration };
  }

  private async probe(key: string, url: () => string, fallback: ProbeResult): Promise<ProbeResult> {
    const cached = this.probes.cached(key);
    if (cached) return cached;
    const lease = this.pool.acquire(key);
    try {
      return await this.probes.get(key, url);
    } catch (err) {
      this.log.warn({ key, err: this.redact()(String((err as Error).message)) }, 'probe failed, assuming defaults');
      return fallback;
    } finally {
      lease.release();
    }
  }

  // ----- PlaybackInfo -----

  async liveInfo(id: string, caps: ClientCaps): Promise<PlaybackInfo> {
    this.channel(id);
    const key = `live:${id}`;
    if (!this.fanouts.isOpen(key)) this.pool.check(key);
    const probe = await this.probe(key, () => this.client().liveUrl(id), ASSUMED_LIVE);
    const choice = choosePipeline({ ...probe, container: 'ts' }, caps, 'live');
    const base = `/api/stream/live/${encodeURIComponent(id)}`;
    return {
      url: choice.pipeline === 'passthrough' ? `${base}.ts` : `${base}/${choice.pipeline}/index.m3u8`,
      type: choice.type,
      pipeline: choice.pipeline,
      startsAt: Date.now(),
    };
  }

  timeline(id: string, now = Date.now()): TimelineInfo {
    const channel = this.channel(id);
    const { window, ...t } = buildTimeline(channel, this.timelineSources, now);
    return { ...t, programs: epgFor(this.db, [channel], window.start, window.end)[channel.id] ?? [] };
  }

  async atInfo(id: string, at: number, caps: ClientCaps): Promise<PlaybackInfo> {
    const channel = this.channel(id);
    const now = Date.now();
    if (at >= now - LIVE_EDGE_MS) return this.liveInfo(id, caps);
    const range = sourceAt(buildTimeline(channel, this.timelineSources, now), at);
    if (!range || range.source !== 'archive') {
      throw new UpstreamError(422, noArchiveReason(this.timelineSources));
    }
    const startMin = Math.floor(at / 60_000);
    const durMin = Math.min(MAX_TIMESHIFT_MIN, Math.ceil((now - startMin * 60_000) / 60_000));
    const key = `ts:${id}:${startMin}`;
    this.pool.check(key);
    const probe = this.probes.cached(`live:${id}`) ?? ASSUMED_LIVE;
    const choice = choosePipeline({ ...probe, container: 'ts' }, caps, 'live');
    const base = `/api/stream/timeshift/${encodeURIComponent(id)}/${startMin}/${durMin}`;
    return {
      url: choice.pipeline === 'passthrough' ? `${base}.ts` : `${base}/${choice.pipeline}/index.m3u8`,
      type: choice.type,
      pipeline: choice.pipeline,
      startsAt: startMin * 60_000,
    };
  }

  async vodInfo(kind: VodKind, id: string, caps: ClientCaps, resumeAt: number | null): Promise<PlaybackInfo> {
    const item = this.vodItem(kind, id);
    const key = `${kind}:${id}`;
    this.pool.check(key);
    const fallback: ProbeResult = { container: item.container, duration: item.duration, video: null, audio: [], subtitles: [] };
    const probe = await this.probe(key, item.url, fallback);
    const choice = choosePipeline(probe, caps, 'vod');
    const base = `/api/stream/${kind}/${encodeURIComponent(id)}`;
    return {
      url: choice.pipeline === 'passthrough' ? `${base}/video.mp4` : `${base}/${choice.pipeline}/index.m3u8`,
      type: choice.type,
      pipeline: choice.pipeline,
      ...(resumeAt ? { resumeAt } : {}),
    };
  }

  // ----- streams -----

  async liveTs(id: string): Promise<Readable> {
    this.channel(id);
    return this.fanouts.subscribe(`live:${id}`, () => this.client().liveUrl(id));
  }

  /** Live HLS shares one session (and the fan-out upstream) per channel + pipeline. */
  async liveHls(id: string, pipeline: HlsPipeline, file: string): Promise<{ text: string } | { files: string[] }> {
    this.channel(id);
    const key = `live:${id}:${pipeline}`;
    const session = await this.sessions.getOrCreate(key, async (dir) => {
      const stream = await this.fanouts.subscribe(`live:${id}`, () => this.client().liveUrl(id));
      return new StreamHlsSession(dir, { stream }, pipeline, 'live', null, this.ffmpegError);
    });
    return file === 'index.m3u8' ? { text: await session.playlist() } : { files: await session.file(file) };
  }

  async timeshiftTs(id: string, startMin: number, durMin: number, signal: AbortSignal): Promise<StreamBody> {
    this.channel(id);
    const lease = this.pool.acquire(`ts:${id}:${startMin}`);
    try {
      const res = await openUpstream(this.timeshiftUrl(id, startMin, durMin), signal);
      const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
      body.on('close', () => lease.release());
      return { status: 200, headers: { 'content-type': 'video/mp2t' }, body };
    } catch (err) {
      lease.release();
      throw err;
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
      const lease = this.pool.acquire(key);
      return new StreamHlsSession(dir, { url: this.timeshiftUrl(id, startMin, durMin) }, pipeline, 'event', lease, this.ffmpegError);
    });
    return file === 'index.m3u8' ? { text: await session.playlist() } : { files: await session.file(file) };
  }

  /** Progressive passthrough with Range support. */
  async vodFile(kind: VodKind, id: string, range: string | undefined, signal: AbortSignal): Promise<StreamBody> {
    const item = this.vodItem(kind, id);
    const lease = this.pool.acquire(`${kind}:${id}`);
    try {
      const res = await openUpstream(item.url(), signal, range ? { range } : {});
      const headers: Record<string, string> = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
      for (const h of ['content-length', 'content-range', 'last-modified', 'etag']) {
        const v = res.headers.get(h);
        if (v) headers[h] = v;
      }
      const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
      body.on('close', () => lease.release());
      return { status: res.status, headers, body };
    } catch (err) {
      lease.release();
      throw err;
    }
  }

  async vodHls(kind: VodKind, id: string, pipeline: HlsPipeline, file: string): Promise<{ text: string } | { files: string[] }> {
    const item = this.vodItem(kind, id);
    const key = `${kind}:${id}`;
    const sessionKey = `${key}:${pipeline}`;
    const session = await this.sessions.getOrCreate(sessionKey, (dir) => {
      this.pool.check(key);
      const duration = this.probes.cached(key)?.duration ?? item.duration;
      if (!duration) throw new HlsError(422, 'The video length is unknown, so it cannot be prepared for this device');
      return new VodHlsSession(dir, item.url, pipeline, duration, () => this.pool.acquire(key), this.ffmpegError);
    });
    if (file === 'index.m3u8') return { text: session.playlist() };
    if (file === 'init.mp4') return { files: await session.init() };
    const m = /^seg\/(\d+)\.m4s$/.exec(file);
    if (!m) throw new HlsError(404, 'Not found');
    return { files: await session.segment(Number(m[1])) };
  }

  close(): void {
    this.sessions.closeAll();
  }
}

export function isHlsPipeline(p: string): p is HlsPipeline {
  return (HLS_PIPELINES as readonly string[]).includes(p);
}

