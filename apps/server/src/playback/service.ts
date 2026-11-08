/** Playback orchestration: PlaybackInfo decisions and the stream endpoints behind them. */
import { DEFAULT_PREFERENCES, type PlaybackDiagnostics, type PlaybackInfo, type PlaybackTracks, type Preferences, type StreamProbe, type StreamSource, type TimelineInfo } from '@anycast/shared';
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
import { HlsError, HlsSessions, StreamHlsSession, VodHlsSession, type SessionEncoder, type SubtitleRendition } from './hls';
import { encoderInfo, HwAccel } from './hwaccel';
import { choosePipeline, explainPipeline, type PipelineChoice } from './pipeline';
import { ProbeCache, type ProbeResult } from './probe';
import { BufferManager } from './buffer';
import { buildTimeline, gapAt, sourceAt, type TimelineSource } from './timeline';
import type { BufferConfig } from '../config';
import type { Thumbnails } from './thumbs';
import { GapError, openUpstream, UpstreamError, UpstreamPool, type Lease } from './upstream';
import { Claims, ConnectionBusyError, holderOf, TakenOverError, type Claim, type Viewer } from './claims';
import { audioTracks, pickAudio, pickSubtitle, subtitleTracks, type SavedChoice, type SubtitleRequest } from './tracks';

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
    video: p.video ? { codec: p.video.codec, width: p.video.width, height: p.video.height, fps: p.video.fps ?? null, bitDepth: p.video.bitDepth ?? null } : null,
    audio: p.audio.map((a) => ({ codec: a.codec, channels: a.channels, language: a.language })),
    subtitles: p.subtitles.map((t) => ({ codec: t.codec, language: t.language })),
  };
}

function diagnose(source: StreamSource, probe: ProbeResult, assumed: boolean, caps: ClientCaps, choice: PipelineChoice, hw: HwAccel): PlaybackDiagnostics {
  const mode = source === 'movie' || source === 'episode' ? 'vod' : 'live';
  const d: PlaybackDiagnostics = { source, reason: explainPipeline(probe, caps, mode, choice, assumed), probe: toStreamProbe(probe), assumed };
  if (choice.pipeline === 'transcode') d.videoEncoder = encoderInfo(hw.current());
  return d;
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
}

/** What a play request says about tracks (PB-3): ?audio / ?sub, the item's saved choice and the profile's preferences. */
export interface TrackRequest {
  audio?: number;
  sub?: SubtitleRequest;
  saved?: SavedChoice | null;
  prefs: Preferences['player'];
}
const NO_TRACK_REQUEST: TrackRequest = { prefs: DEFAULT_PREFERENCES.player };

/** Track part of a stream URL: audio track N > 0 plays from .../{pipeline}/a{N}/...; track 0 keeps the plain URL. */
export const audioPrefix = (audio: number | null) => (audio ? `a${audio}/` : '');
/** Splits "a2/seg/3.m4s" into the audio track and the file. */
export function splitAudio(file: string): { audio: number; file: string } {
  const m = /^a(\d{1,2})\/(.+)$/.exec(file);
  return m ? { audio: Number(m[1]), file: m[2]! } : { audio: 0, file };
}
const sessionAudio = (audio: number) => (audio ? `:a${audio}` : '');

let languageNames: Intl.DisplayNames | null = null;
function languageName(code: string | null): string | null {
  if (!code) return null;
  try {
    languageNames ??= new Intl.DisplayNames(['en'], { type: 'language' });
    return languageNames.of(code) ?? null;
  } catch {
    return null;
  }
}

/** Text subtitle tracks as HLS renditions, with unique display names. */
export function subtitleRenditions(probe: ProbeResult): SubtitleRendition[] {
  const used = new Map<string, number>();
  return subtitleTracks(probe.subtitles, 'vod')
    .filter((t) => !t.unavailable)
    .map((t) => {
      const lang = languageName(t.language) ?? (t.language ? t.language.toUpperCase() : null);
      let name = [lang, t.title].filter(Boolean).join(' · ') || `Subtitles ${t.index + 1}`;
      const n = (used.get(name) ?? 0) + 1;
      used.set(name, n);
      if (n > 1) name = `${name} (${n})`;
      return { index: t.index, name, language: t.language };
    });
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
  /** picks the H.264 encoder of full transcodes (hardware when it works, see hwaccel.ts) */
  hw: HwAccel = new HwAccel();
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

  /** Full transcodes: the encoder a new session uses (null: the pipeline copies video). */
  private async sessionEncoder(pipeline: HlsPipeline): Promise<SessionEncoder | null> {
    if (pipeline !== 'transcode') return null;
    return { video: await this.hw.encoder(), failed: (video, error) => this.hw.markFailed(video, this.redact()(error)) };
  }

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

  /** The tracks a stream lists and which ones it plays (PB-3). */
  private tracksFor(probe: ProbeResult, mode: 'vod' | 'live', req: TrackRequest): Omit<PlaybackTracks, 'subtitlesInStream'> {
    const audio = audioTracks(probe.audio);
    const subtitles = subtitleTracks(probe.subtitles, mode);
    const audioIndex = pickAudio(probe.audio, { requested: req.audio, saved: req.saved?.audio, preferred: req.prefs.preferredAudioLanguage });
    const audioLanguage = audioIndex === null ? null : (audio[audioIndex]?.language ?? null);
    const subtitleIndex = pickSubtitle(subtitles, { requested: req.sub, saved: req.saved?.subtitle, prefs: req.prefs, audioLanguage });
    return { audio, subtitles, audioIndex, subtitleIndex };
  }

  /**
   * A play request that names its tracks (a switch, or a reload keeping them): stop what `key`
   * still serves with other tracks, so the new stream does not need a second provider connection
   * (one-connection providers): its other HLS sessions (each reads the source, or the live fan-out,
   * on its own) and its direct streams (a file or raw TS the old player may still hold open).
   * Left alone while another client watches the same item, which may be playing them.
   */
  private switchTracks(key: string, keep: string | null, viewer: Viewer | null): void {
    if (viewer && this.claims.holders(key, viewer.clientId).length) return;
    this.sessions.closeWhere((k) => k.startsWith(`${key}:`) && k !== keep);
    for (const stop of [...(this.direct.get(key) ?? [])]) stop();
  }

  async liveInfo(id: string, caps: ClientCaps, viewer: Viewer | null = null, req: TrackRequest = NO_TRACK_REQUEST): Promise<PlaybackInfo> {
    const channel = this.channel(id);
    const key = `live:${id}`;
    this.begin(viewer, key, channel.name);
    const probe = await this.probe(key, () => this.client().liveUrl(id), ASSUMED_LIVE);
    const tracks = this.tracksFor(probe, 'live', req);
    const choice = choosePipeline({ ...probe, container: 'ts' }, caps, 'live', { audio: tracks.audioIndex });
    if (req.audio !== undefined) {
      this.switchTracks(key, choice.pipeline === 'passthrough' ? null : `${key}:${choice.pipeline}${sessionAudio(tracks.audioIndex ?? 0)}`, viewer);
    }
    const base = `/api/stream/live/${encodeURIComponent(id)}`;
    return {
      url: choice.pipeline === 'passthrough' ? `${base}.ts` : `${base}/${choice.pipeline}/${audioPrefix(tracks.audioIndex)}index.m3u8`,
      type: choice.type,
      pipeline: choice.pipeline,
      startsAt: Date.now(),
      diagnostics: diagnose('live', probe, probe === ASSUMED_LIVE, caps, choice, this.hw),
      tracks: { ...tracks, subtitlesInStream: false },
    };
  }

  timeline(id: string, now = Date.now()): TimelineInfo {
    const channel = this.channel(id);
    const { window, ...t } = buildTimeline(channel, this.timelineSources, now);
    return { ...t, programs: epgFor(this.db, [channel], window.start, window.end)[channel.id] ?? [] };
  }

  async atInfo(id: string, at: number, caps: ClientCaps, viewer: Viewer | null = null, req: TrackRequest = NO_TRACK_REQUEST): Promise<PlaybackInfo> {
    const channel = this.channel(id);
    const now = Date.now();
    if (at >= now) return this.liveInfo(id, caps, viewer, req);
    const timeline = buildTimeline(channel, this.timelineSources, now);
    const range = sourceAt(timeline, at);
    const gap = () => {
      const g = gapAt(timeline, at);
      return new GapError(g.reason, g.cause);
    };
    if (!range) throw gap();
    if (range.source === 'live') return this.liveInfo(id, caps, viewer, req);
    if (range.source === 'buffer') {
      const seg = this.buffer?.segmentAt(id, at);
      if (!seg) throw gap();
      // the buffer needs no connection; while the channel still records, the viewer keeps its
      // claim on it, so the recording (the connection) is not given away under them
      const live = `live:${id}`;
      this.begin(viewer, this.buffer?.isRecording(id) && this.fanouts.isOpen(live) ? live : null, channel.name, false);
      return this.bufferInfo(id, seg.run_id, seg.seq, seg.start_ms, caps, req);
    }
    const startMin = Math.floor(at / 60_000);
    const durMin = Math.min(MAX_TIMESHIFT_MIN, Math.ceil((now - startMin * 60_000) / 60_000));
    const key = `ts:${id}:${startMin}`;
    this.begin(viewer, key, channel.name);
    // the archive has the live stream's tracks: probe the channel if it never played live here
    // (before the archive stream opens, so one connection is enough)
    const probe = await this.probe(`live:${id}`, () => this.client().liveUrl(id), ASSUMED_LIVE);
    const tracks = this.tracksFor(probe, 'live', req);
    const choice = choosePipeline({ ...probe, container: 'ts' }, caps, 'live', { audio: tracks.audioIndex });
    if (req.audio !== undefined) {
      const keep = choice.pipeline === 'passthrough' ? null : `${key}:${durMin}:${choice.pipeline}${sessionAudio(tracks.audioIndex ?? 0)}`;
      this.switchTracks(key, keep, viewer);
    }
    const base = `/api/stream/timeshift/${encodeURIComponent(id)}/${startMin}/${durMin}`;
    return {
      url: choice.pipeline === 'passthrough' ? `${base}.ts` : `${base}/${choice.pipeline}/${audioPrefix(tracks.audioIndex)}index.m3u8`,
      type: choice.type,
      pipeline: choice.pipeline,
      startsAt: startMin * 60_000,
      diagnostics: diagnose('timeshift', probe, probe === ASSUMED_LIVE, caps, choice, this.hw),
      tracks: { ...tracks, subtitlesInStream: false },
    };
  }

  /**
   * Buffered playback: the recorded TS segments as an EVENT playlist, or through FFmpeg when the
   * client needs other codecs or another audio track than the first.
   */
  private bufferInfo(id: string, run: number, seq: number, startsAt: number, caps: ClientCaps, req: TrackRequest): PlaybackInfo {
    const probe = this.probes.cached(`live:${id}`) ?? ASSUMED_LIVE;
    const tracks = { ...this.tracksFor(probe, 'live', req), subtitlesInStream: false };
    const choice = choosePipeline({ ...probe, container: 'ts' }, caps, 'live', { audio: tracks.audioIndex });
    const base = `/api/stream/buffer/${encodeURIComponent(id)}/${run}/${seq}`;
    const assumed = probe === ASSUMED_LIVE;
    if (choice.pipeline !== 'passthrough' && (choice.pipeline !== 'remux' || tracks.audioIndex)) {
      return { url: `${base}/${choice.pipeline}/${audioPrefix(tracks.audioIndex)}index.m3u8`, type: 'hls', pipeline: choice.pipeline, startsAt, tracks, diagnostics: diagnose('buffer', probe, assumed, caps, choice, this.hw) };
    }
    const served: PipelineChoice = { pipeline: 'passthrough', type: 'hls' };
    return { url: `${base}/index.m3u8`, type: 'hls', pipeline: 'passthrough', startsAt, tracks, diagnostics: diagnose('buffer', probe, assumed, caps, served, this.hw) };
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

  async bufferHls(id: string, run: number, from: number, pipeline: HlsPipeline, path: string) {
    const buffer = this.requireBuffer();
    const { audio, file } = this.liveTrackFile(id, path);
    if (!buffer.playlist(id, run, from)) throw new NotFoundError('This part of the buffer is no longer available');
    const session = await this.sessions.getOrCreate(`buf:${id}:${run}:${from}:${pipeline}${sessionAudio(audio)}`, async (dir) => {
      const encoder = await this.sessionEncoder(pipeline);
      return new StreamHlsSession(dir, { stream: buffer.reader(id, run, from) }, pipeline, 'event', null, this.ffmpegError, this.liveAudio(id, audio), audio, encoder);
    });
    return file === 'index.m3u8' ? { text: await session.playlist() } : { files: await session.file(file) };
  }

  async vodInfo(
    kind: VodKind, id: string, caps: ClientCaps, resumeAt: number | null, viewer: Viewer | null = null, req: TrackRequest = NO_TRACK_REQUEST,
  ): Promise<PlaybackInfo> {
    const item = this.vodItem(kind, id);
    const key = `${kind}:${id}`;
    this.begin(viewer, key, item.title);
    const fallback: ProbeResult = { container: item.container, duration: item.duration, video: null, audio: [], subtitles: [] };
    const probe = await this.probe(key, item.url, fallback);
    const tracks = this.tracksFor(probe, 'vod', req);
    const choice = choosePipeline(probe, caps, 'vod', { audio: tracks.audioIndex, subtitles: tracks.subtitleIndex !== null });
    const hls = choice.pipeline !== 'passthrough';
    if (req.audio !== undefined || req.sub !== undefined) {
      this.switchTracks(key, hls ? `${key}:${choice.pipeline}${sessionAudio(tracks.audioIndex ?? 0)}` : null, viewer);
    }
    const subtitlesInStream = hls && subtitleRenditions(probe).length > 0;
    const base = `/api/stream/${kind}/${encodeURIComponent(id)}`;
    return {
      url: hls ? `${base}/${choice.pipeline}/${audioPrefix(tracks.audioIndex)}${subtitlesInStream ? 'master' : 'index'}.m3u8` : `${base}/video.mp4`,
      type: choice.type,
      pipeline: choice.pipeline,
      tracks: { ...tracks, subtitlesInStream },
      ...(resumeAt ? { resumeAt } : {}),
      ...(item.seriesId ? { seriesId: item.seriesId } : {}),
      diagnostics: diagnose(kind, probe, probe === fallback, caps, choice, this.hw),
    };
  }

  // ----- streams -----

  async liveTs(id: string): Promise<Readable> {
    this.channel(id);
    this.guard(`live:${id}`);
    return this.fanouts.subscribe(`live:${id}`, () => this.client().liveUrl(id));
  }

  /** A live/archive/buffer stream file of audio track N ("a1/index.m3u8"); 404 for a track the channel does not have. */
  private liveTrackFile(id: string, path: string): { audio: number; file: string } {
    const r = splitAudio(path);
    if (r.audio && r.audio >= (this.probes.cached(`live:${id}`) ?? ASSUMED_LIVE).audio.length) throw new HlsError(404, 'Audio track not available');
    return r;
  }

  /** Live HLS shares one session (and the fan-out upstream) per channel + pipeline + audio track. */
  async liveHls(id: string, pipeline: HlsPipeline, path: string): Promise<{ text: string } | { files: string[] }> {
    this.channel(id);
    const { audio, file } = this.liveTrackFile(id, path);
    const key = `live:${id}:${pipeline}${sessionAudio(audio)}`;
    const session = await this.sessions.getOrCreate(key, async (dir) => {
      const encoder = await this.sessionEncoder(pipeline);
      this.guard(`live:${id}`);
      const stream = await this.fanouts.subscribe(`live:${id}`, () => this.client().liveUrl(id));
      return new StreamHlsSession(dir, { stream }, pipeline, 'live', null, this.ffmpegError, this.liveAudio(id, audio), audio, encoder);
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

  async timeshiftHls(id: string, startMin: number, durMin: number, pipeline: HlsPipeline, path: string) {
    this.channel(id);
    const { audio, file } = this.liveTrackFile(id, path);
    const key = `ts:${id}:${startMin}`;
    const sessionKey = `${key}:${durMin}:${pipeline}${sessionAudio(audio)}`;
    const session = await this.sessions.getOrCreate(sessionKey, async (dir) => {
      const encoder = await this.sessionEncoder(pipeline);
      this.guard(key);
      const lease = this.pool.acquire(key);
      return new StreamHlsSession(dir, { url: this.timeshiftUrl(id, startMin, durMin) }, pipeline, 'event', lease, this.ffmpegError, this.liveAudio(id, audio), audio, encoder);
    });
    return file === 'index.m3u8' ? { text: await session.playlist() } : { files: await session.file(file) };
  }

  /** The codec of a live channel's audio track, from its probe (or the assumed live defaults). */
  private liveAudio(id: string, audio = 0): string | null {
    return (this.probes.cached(`live:${id}`) ?? ASSUMED_LIVE).audio[audio]?.codec ?? null;
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

  /**
   * VOD HLS files of one audio track (PB-3: "a1/..." for track 1): master.m3u8 (with subtitle
   * renditions), index.m3u8, init.mp4, seg/{n}.m4s, subs/{k}.m3u8, subs/{k}/{n}.vtt.
   */
  async vodHls(kind: VodKind, id: string, pipeline: HlsPipeline, path: string): Promise<{ text: string } | { files: string[] }> {
    const item = this.vodItem(kind, id);
    const key = `${kind}:${id}`;
    const { audio, file } = splitAudio(path);
    const sessionKey = `${key}:${pipeline}${sessionAudio(audio)}`;
    const session = await this.sessions.getOrCreate(sessionKey, async (dir) => {
      const encoder = await this.sessionEncoder(pipeline);
      this.guard(key);
      this.pool.check(key);
      const probe = this.probes.cached(key);
      if (audio && audio >= (probe?.audio.length ?? 0)) throw new HlsError(404, 'Audio track not available');
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
      const tracks = { audio, subtitles: probe ? subtitleRenditions(probe) : [] };
      return new VodHlsSession(dir, item.url, pipeline, duration, acquire, this.ffmpegError, probe?.audio[audio]?.codec ?? null, onSegment, tracks, encoder);
    });
    if (file === 'master.m3u8') return { text: session.masterPlaylist() };
    if (file === 'index.m3u8') return { text: session.playlist() };
    if (file === 'init.mp4') return { files: await session.init() };
    const m = /^seg\/(\d+)\.m4s$/.exec(file);
    if (m) return { files: await session.segment(Number(m[1])) };
    const sp = /^subs\/(\d+)\.m3u8$/.exec(file);
    if (sp) return { text: session.subtitlePlaylist(Number(sp[1])) };
    const sv = /^subs\/(\d+)\/(\d+)\.vtt$/.exec(file);
    if (sv) return { text: await session.subtitleSegment(Number(sv[1]), Number(sv[2])) };
    throw new HlsError(404, 'Not found');
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

