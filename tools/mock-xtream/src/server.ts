/** Fastify app wiring for the mock Xtream Codes panel. */
import { mkdirSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { handlePlayerApi, RawJson, type RequestInfo } from './api.js';
import { buildCatalog, DEFAULT_SEED, type Catalog, type CatalogSize } from './catalog.js';
import { ConnectionTracker } from './connections.js';
import { checkCredentials, nowSec, type MockContext } from './context.js';
import { capabilities, DEFAULT_CACHE_DIR } from './ffmpeg.js';
import { FaultState, sleep, type Faults } from './faults.js';
import { PROFILES } from './formats.js';
import { iconPng } from './icons.js';
import { StreamService } from './streams.js';
import { xmltvStream } from './xmltv.js';

export interface MockXtreamOptions {
  /** Port to listen on; 0 (default) picks a free one. */
  port?: number;
  /** Interface to bind; default 127.0.0.1. */
  host?: string;
  username?: string;
  password?: string;
  size?: CatalogSize;
  /** Concurrent stream responses allowed per account (default 2). */
  maxConnections?: number;
  seed?: number;
  /** Clock in milliseconds (default Date.now). Drives API times, EPG and the burned-in clock. */
  now?: () => number;
  faults?: Partial<Faults>;
  /** Panel timezone (default Europe/Berlin). */
  timezone?: string;
  /** XMLTV times with a UTC offset (default true); false writes bare panel-local times, like some panels. */
  xmltvOffsets?: boolean;
  /** Where VOD fixtures, HLS segments and text files go (default os.tmpdir()/anycast-mock-cache). */
  cacheDir?: string;
  /** Fastify request logging. */
  logger?: boolean;
}

export interface MockState {
  activeConnections: number;
  /** most connections open at the same time since start or the last reset */
  peakConnections: number;
  maxConnections: number;
  connections: ReturnType<ConnectionTracker['list']>;
  hlsChannels: number[];
  faults: Faults;
  catalog: { size: CatalogSize; seed: number; live: number; movies: number; series: number; episodes: number };
  now: number;
  timezone: string;
  ffmpeg: ReturnType<typeof capabilities>;
}

export interface MockXtream {
  app: FastifyInstance;
  /** Base URL, e.g. "http://127.0.0.1:41234". */
  url: string;
  port: number;
  username: string;
  password: string;
  catalog: Catalog;
  /** Merge fault switches at runtime (same as POST /__mock/faults). */
  setFaults(patch: Partial<Faults>): Faults;
  state(): MockState;
  /** Reset faults to the creation options and drop all open streams/sessions (same as POST /__mock/reset). */
  reset(): Promise<void>;
  close(): Promise<void>;
}

function requestInfo(req: FastifyRequest, port: number): RequestInfo {
  const host = req.headers.host ?? `127.0.0.1:${port}`;
  return { hostname: req.hostname || '127.0.0.1', port: req.port ?? port, baseUrl: `http://${host}` };
}

const q = (req: FastifyRequest): Record<string, unknown> => (req.query ?? {}) as Record<string, unknown>;
type P = Record<string, string>;

function m3uPlaylist(ctx: MockContext, info: RequestInfo, output: string): string {
  const { catalog } = ctx;
  const cat = new Map(
    [...catalog.liveCategories, ...catalog.vodCategories, ...catalog.seriesCategories].map((c) => [c.category_id, c.category_name]),
  );
  const ext = output === 'm3u8' || output === 'hls' ? 'm3u8' : 'ts';
  const auth = `${encodeURIComponent(ctx.username)}/${encodeURIComponent(ctx.password)}`;
  const icon = (s: string | null): string => (s ? `${info.baseUrl}/images/${s}.png` : '');
  const lines = ['#EXTM3U'];
  for (const c of catalog.live) {
    lines.push(
      `#EXTINF:-1 tvg-id="${c.epgChannelId ?? ''}" tvg-name="${c.name}" tvg-logo="${icon(c.icon)}" group-title="${cat.get(c.categoryId) ?? ''}"${c.archive ? ` catchup="xc" catchup-days="${c.archiveDays}"` : ''},${c.name}`,
      `${info.baseUrl}/live/${auth}/${c.id}.${ext}`,
    );
  }
  for (const m of catalog.movies) {
    lines.push(
      `#EXTINF:-1 tvg-id="" tvg-name="${m.name}" tvg-logo="${icon(m.icon)}" group-title="${cat.get(m.categoryId) ?? ''}",${m.name}`,
      `${info.baseUrl}/movie/${auth}/${m.id}.${PROFILES[m.profile].container}`,
    );
  }
  for (const s of catalog.series) {
    for (const season of s.seasons) {
      for (const e of season) {
        lines.push(
          `#EXTINF:-1 tvg-id="" tvg-name="${e.title}" tvg-logo="${icon(s.icon)}" group-title="${cat.get(s.categoryId) ?? ''}",${e.title}`,
          `${info.baseUrl}/series/${auth}/${e.id}.${PROFILES[e.profile].container}`,
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function createMockXtream(opts: MockXtreamOptions = {}): Promise<MockXtream> {
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  mkdirSync(cacheDir, { recursive: true });
  const now = opts.now ?? Date.now;
  const catalog = buildCatalog(opts.size ?? 'full', opts.seed ?? DEFAULT_SEED);
  const ctx: MockContext = {
    catalog,
    username: opts.username ?? 'test',
    password: opts.password ?? 'test',
    maxConnections: opts.maxConnections ?? 2,
    faults: new FaultState(opts.faults),
    connections: new ConnectionTracker(),
    now,
    timezone: opts.timezone ?? 'Europe/Berlin',
    xmltvOffsets: opts.xmltvOffsets ?? true,
    cacheDir,
    createdAt: Math.floor(now() / 1000 / 86400) * 86400 - 200 * 86400,
  };
  const streams = new StreamService(ctx);
  const app = Fastify({ logger: opts.logger ?? false, exposeHeadRoutes: true, forceCloseConnections: true });
  let port = opts.port ?? 0;

  const apiDelay = async (): Promise<void> => {
    const ms = ctx.faults.get().slowApiMs;
    if (ms > 0) await sleep(ms);
  };

  // --- Xtream API ------------------------------------------------------------------------------
  app.get('/player_api.php', async (req, reply) => {
    await apiDelay();
    const result = handlePlayerApi(ctx, q(req), requestInfo(req, port));
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return reply.send(result instanceof RawJson ? result.body : JSON.stringify(result));
  });

  app.get('/xmltv.php', async (req, reply) => {
    await apiDelay();
    const query = q(req);
    if (!checkCredentials(ctx, query.username, query.password)) return reply.code(403).send('');
    return reply
      .header('Content-Type', 'application/xml; charset=utf-8')
      .send(xmltvStream(ctx, requestInfo(req, port)));
  });

  app.get('/get.php', async (req, reply) => {
    await apiDelay();
    const query = q(req);
    if (!checkCredentials(ctx, query.username, query.password)) return reply.code(403).send('');
    return reply
      .header('Content-Type', 'audio/x-mpegurl; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="playlist.m3u"')
      .send(m3uPlaylist(ctx, requestInfo(req, port), String(query.output ?? 'ts')));
  });

  // --- Streams ---------------------------------------------------------------------------------
  app.get('/live/:u/:p/:file', (req, reply) => {
    const { u, p, file } = req.params as P;
    return streams.live(req, reply, u ?? '', p ?? '', file ?? '');
  });
  app.get('/:u/:p/:file', (req, reply) => {
    const { u, p, file } = req.params as P;
    if (!/^\d+(\.ts)?$/.test(file ?? '')) return reply.code(404).send('');
    return streams.live(req, reply, u ?? '', p ?? '', file ?? '');
  });
  app.get('/timeshift/:u/:p/:duration/:start/:file', (req, reply) => {
    const { u, p, duration, start, file } = req.params as P;
    return streams.timeshift(req, reply, { u, p, duration, start, stream: file });
  });
  app.get('/streaming/timeshift.php', (req, reply) => {
    const query = q(req);
    return streams.timeshift(req, reply, {
      u: query.username,
      p: query.password,
      duration: query.duration,
      start: query.start,
      stream: query.stream,
    });
  });
  app.get('/hls/:u/:p/:id/:seg', (req, reply) => {
    const { u, p, id, seg } = req.params as P;
    return streams.hlsSegment(req, reply, u ?? '', p ?? '', Number(id), seg ?? '');
  });
  app.get('/movie/:u/:p/:file', (req, reply) => {
    const { u, p, file } = req.params as P;
    return streams.vod(req, reply, 'movie', u ?? '', p ?? '', file ?? '');
  });
  app.get('/series/:u/:p/:file', (req, reply) => {
    const { u, p, file } = req.params as P;
    return streams.vod(req, reply, 'series', u ?? '', p ?? '', file ?? '');
  });

  app.get('/images/:file', (req, reply) => {
    const slug = (req.params as P).file?.replace(/\.png$/, '') ?? '';
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'max-age=86400').send(iconPng(slug));
  });

  // --- Test control ----------------------------------------------------------------------------
  const state = (): MockState => ({
    activeConnections: ctx.connections.count(ctx.username),
    peakConnections: ctx.connections.peak(ctx.username),
    maxConnections: ctx.maxConnections,
    connections: ctx.connections.list(),
    hlsChannels: streams.activeHlsChannels(),
    faults: ctx.faults.get(),
    catalog: {
      size: catalog.size,
      seed: catalog.seed,
      live: catalog.live.length,
      movies: catalog.movies.length,
      series: catalog.series.length,
      episodes: catalog.episodeById.size,
    },
    now: nowSec(ctx),
    timezone: ctx.timezone,
    ffmpeg: capabilities(),
  });
  const reset = async (): Promise<void> => {
    ctx.faults.reset();
    await streams.closeAll();
    ctx.connections.clear();
  };

  app.get('/__mock/state', async () => state());
  app.get('/__mock/faults', async () => ctx.faults.get());
  app.post('/__mock/faults', async (req, reply) => {
    try {
      return ctx.faults.update(req.body ?? {});
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.post('/__mock/reset', async () => {
    await reset();
    return { ok: true };
  });

  capabilities();
  const host = opts.host ?? '127.0.0.1';
  await app.listen({ port, host });
  const addr = app.server.address();
  port = typeof addr === 'object' && addr ? addr.port : port;
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return {
    app,
    url: `http://${urlHost}:${port}`,
    port,
    username: ctx.username,
    password: ctx.password,
    catalog,
    setFaults: (patch) => ctx.faults.update(patch),
    state,
    reset,
    close: async () => {
      await streams.dispose();
      await app.close();
    },
  };
}
