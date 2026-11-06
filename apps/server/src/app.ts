import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import { HttpError, Users } from './auth/users';
import { CatalogSync } from './catalog/sync';
import { DEFAULT_BUFFER, VERSION, type Config } from './config';
import type { Services } from './context';
import { openDb } from './db';
import { EventBus } from './events';
import { HlsError } from './playback/hls';
import { ConnectionBusyError, TakenOverError } from './playback/claims';
import { ProbeCache } from './playback/probe';
import { NotFoundError, PlaybackService } from './playback/service';
import { archiveSource } from './playback/timeline';
import { DEFAULT_THUMBS, Thumbnails } from './playback/thumbs';
import { ConnectionLimitError, GapError, UpstreamError } from './playback/upstream';
import { createRedactor, redactDeep, type Redactor } from './redact';
import { artRoutes } from './routes/art';
import { authRoutes, registerAuthHook } from './routes/auth';
import { bufferRoutes } from './routes/buffer';
import { catalogRoutes } from './routes/catalog';
import { eventRoutes } from './routes/events';
import { listRoutes } from './routes/lists';
import { playbackRoutes } from './routes/playback';
import { thumbRoutes } from './routes/thumbs';
import { userDataRoutes } from './routes/userdata';
import { SourceService } from './source';
import { UserData } from './userdata';
import { XtreamError } from './xtream/client';

export interface BuildOptions {
  logger?: boolean;
  /** log destination (default stdout); tests capture logs here */
  logStream?: NodeJS.WritableStream;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: Services;
}

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<BuiltApp> {
  const db = openDb(path.join(config.dataDir, 'anycast.db'));
  const source = new SourceService(db, config.secret);
  source.seed(config.xtream);

  // the redactor follows the stored credentials, so it is rebuilt lazily when they change
  let redactor: { key: string; fn: Redactor } | null = null;
  const redact = (): Redactor => {
    const creds = source.credentials();
    const key = creds ? `${creds.url}\n${creds.username}\n${creds.password}` : '';
    if (!redactor || redactor.key !== key) redactor = { key, fn: createRedactor(creds ?? {}, { collapseUrls: false }) };
    return redactor.fn;
  };

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            ...(opts.logStream ? { stream: opts.logStream } : {}),
            redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'], censor: '***' },
            hooks: {
              logMethod(args, method) {
                method.apply(this, redactDeep(args, redact()) as typeof args);
              },
            },
          },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  const bus = new EventBus();
  const users = new Users(db);
  await users.ensureAdmin(config.admin);
  const sync = new CatalogSync(db, source, bus, app.log);
  const playback = new PlaybackService(db, source, new ProbeCache(db), app.log, redact, [archiveSource], {
    dir: config.bufferDir,
    config: { ...DEFAULT_BUFFER, ...config.buffer },
  });
  playback.thumbs = new Thumbnails(
    path.join(config.dataDir, 'thumbs'),
    { ...DEFAULT_THUMBS, ...(config.thumbsMaxBytes !== undefined ? { maxBytes: config.thumbsMaxBytes } : {}) },
    (msg) => app.log.warn({ thumbs: redact()(msg) }, 'thumbnail problem'),
  );
  playback.onTakenOver = (victim, by) =>
    bus.emit({
      type: 'playback-stopped', profileId: victim.profileId, clientId: victim.clientId, reason: 'taken-over',
      by: { profileName: by.profileName, ...(by.device ? { device: by.device } : {}) },
    });
  const services: Services = { config, db, users, source, sync, bus, userData: new UserData(db, bus), playback };

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ConnectionLimitError) return reply.code(429).send({ error: err.code, message: err.message });
    if (err instanceof ConnectionBusyError) {
      return reply.code(409).send({ error: err.code, message: err.message, holder: err.holder, canTakeOver: true });
    }
    if (err instanceof TakenOverError) return reply.code(409).send({ error: err.code, message: err.message });
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'not_found', message: err.message });
    if (err instanceof GapError) return reply.code(err.statusCode).send({ error: 'gap', message: err.message, cause: err.gap });
    if (err instanceof UpstreamError || err instanceof HlsError) {
      return reply.code(err.statusCode).send({ error: err instanceof HlsError ? 'stream' : 'upstream', message: err.message });
    }
    if (err instanceof XtreamError) return reply.code(502).send({ error: 'upstream', message: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: status === 429 ? 'rate_limited' : 'error', message: status >= 500 ? 'Something went wrong' : redact()((err as Error).message) });
  });

  registerAuthHook(app, services);
  app.get('/api/health', async () => ({ ok: true as const, version: VERSION }));
  authRoutes(app, services);
  catalogRoutes(app, services);
  userDataRoutes(app, services);
  listRoutes(app, services);
  playbackRoutes(app, services);
  bufferRoutes(app, services);
  thumbRoutes(app, services);
  eventRoutes(app, services);
  artRoutes(app, services);

  if (config.webDist) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
  }
  app.setNotFoundHandler((req, reply) => {
    if (config.webDist && req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found', message: 'Not found' });
  });

  app.addHook('onClose', async () => {
    await sync.stop();
    await playback.close();
    db.close();
  });

  return { app, services };
}
