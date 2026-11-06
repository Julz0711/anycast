import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { auth, type Services } from '../context';
import { parentalCtx } from '../parental';
import { parseCaps } from '../playback/caps';
import type { Viewer } from '../playback/claims';
import { isHlsPipeline, type StreamBody, type VodKind } from '../playback/service';

const CLIENT_ID = /^[\w-]{8,64}$/;

/** The playback client behind a request (x-anycast-client / x-anycast-device), or null for clients that send none. */
function viewerOf(req: FastifyRequest, s: Services): Viewer | null {
  const clientId = req.headers['x-anycast-client'];
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) return null;
  const { user, profileId } = auth(req);
  const rawDevice = req.headers['x-anycast-device'];
  const device = typeof rawDevice === 'string' ? rawDevice.replace(/[\p{C}]/gu, '').trim().slice(0, 60) : '';
  const profileName = s.users.profiles(user.id).find((p) => p.id === profileId)?.name ?? user.username;
  return { clientId, profileId, profileName, device: device || null };
}

const caps = (req: FastifyRequest) => parseCaps((req.headers['x-anycast-caps'] as string | undefined) ?? (req.query as Record<string, string>).caps);

function contentType(file: string): string {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (file.endsWith('.mp4')) return 'video/mp4';
  if (file.endsWith('.m4s')) return 'video/iso.segment';
  return 'application/octet-stream';
}

/** Sends a playlist or one-or-more files concatenated. */
function sendHls(reply: FastifyReply, file: string, out: { text: string } | { files: string[] }) {
  reply.header('cache-control', 'no-cache').type(contentType(file));
  if ('text' in out) return reply.send(out.text);
  if (out.files.length === 1) return reply.send(createReadStream(out.files[0]!));
  const body = new PassThrough();
  void (async () => {
    for (const f of out.files) {
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(f);
        rs.on('end', resolve).on('error', reject);
        rs.pipe(body, { end: false });
      });
    }
    body.end();
  })().catch((err) => body.destroy(err));
  return reply.send(body);
}

function sendStream(req: FastifyRequest, reply: FastifyReply, s: StreamBody) {
  req.raw.on('close', () => s.body.destroy());
  return reply.code(s.status).headers({ ...s.headers, 'cache-control': 'no-store' }).send(s.body);
}

function abortOnClose(req: FastifyRequest): AbortSignal {
  const ac = new AbortController();
  req.raw.on('close', () => ac.abort());
  return ac.signal;
}

export function playbackRoutes(app: FastifyInstance, s: Services): void {
  const p = s.playback;
  /** 403 adult_locked for adult items this profile cannot open (hidden, or locked and not unlocked here). */
  const gate = (req: FastifyRequest, kind: 'live' | 'movie' | 'episode', id: string) => {
    const adult = s.parental.view(parentalCtx(req));
    if (adult.adultIds.size) adult.assertOpen(s.parental.categoryOf(kind, id));
  };

  /**
   * Stream and thumbnail URLs are fetched by <video>/hls.js without the profile header, so they can't tell which
   * profile is watching. They are guessable from ids, so gate them too: allowed when any of the
   * signed-in user's profiles may open the item (all profiles share one login anyway).
   */
  app.addHook('onRequest', async (req) => {
    const m = /^\/api\/(?:stream|thumbs)\/(live|timeshift|buffer|movie|episode)\/([^/?]+?)(?:\.ts)?(?:[/?]|$)/.exec(req.url);
    if (!m || !req.auth) return;
    const kind = m[1] === 'movie' || m[1] === 'episode' ? m[1] : 'live';
    const category = s.parental.categoryOf(kind, decodeURIComponent(m[2]!));
    const a = req.auth;
    const views = s.users.profiles(a.user.id).map((pr) => s.parental.view({ profileId: pr.id, token: a.token, cookies: req.cookies }));
    if (views.some((v) => v.canOpen(category))) return;
    views[0]?.assertOpen(category);
  });

  app.get<{ Params: { id: string } }>('/api/play/live/:id', async (req) => {
    gate(req, 'live', req.params.id);
    return p.liveInfo(req.params.id, caps(req), viewerOf(req, s));
  });

  app.get<{ Params: { id: string }; Querystring: { at?: string } }>('/api/play/live/:id/at', async (req, reply) => {
    const at = Number(req.query.at);
    if (!Number.isFinite(at)) return reply.code(400).send({ error: 'bad_request', message: 'at (epoch ms) is required' });
    gate(req, 'live', req.params.id);
    return p.atInfo(req.params.id, at, caps(req), viewerOf(req, s));
  });

  app.get<{ Params: { channelId: string } }>('/api/timeline/:channelId', async (req) => {
    gate(req, 'live', req.params.channelId);
    return p.timeline(req.params.channelId);
  });

  for (const kind of ['movie', 'episode'] as const) {
    app.get<{ Params: { id: string } }>(`/api/play/${kind}/:id`, async (req) => {
      gate(req, kind, req.params.id);
      const saved = s.userData.progressFor(auth(req).profileId, kind, req.params.id);
      const resumeAt = saved && !saved.finished && saved.position > 0 ? saved.position : null;
      return p.vodInfo(kind, req.params.id, caps(req), resumeAt, viewerOf(req, s));
    });
  }

  app.post('/api/play/takeover', async (req, reply) => {
    const viewer = viewerOf(req, s);
    if (!viewer) return reply.code(400).send({ error: 'bad_request', message: 'x-anycast-client is required' });
    return { ok: true as const, stopped: p.takeover(viewer) };
  });

  app.post('/api/play/stop', async (req) => {
    const viewer = viewerOf(req, s);
    if (viewer) p.stopClient(viewer.clientId);
    return { ok: true as const };
  });

  // ----- streams (cookie-authenticated like every /api route) -----

  app.get<{ Params: { id: string } }>('/api/stream/live/:id.ts', async (req, reply) => {
    const body = await p.liveTs(req.params.id);
    return sendStream(req, reply, { status: 200, headers: { 'content-type': 'video/mp2t' }, body });
  });

  app.get<{ Params: { id: string; pipeline: string; '*': string } }>('/api/stream/live/:id/:pipeline/*', async (req, reply) => {
    const { id, pipeline } = req.params;
    const file = req.params['*'];
    if (!isHlsPipeline(pipeline) || !/^[\w.-]+$/.test(file)) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    return sendHls(reply, file, await p.liveHls(id, pipeline, file));
  });

  app.get<{ Params: { id: string; start: string; dur: string } }>('/api/stream/timeshift/:id/:start/:dur.ts', async (req, reply) => {
    const body = await p.timeshiftTs(req.params.id, Number(req.params.start), Number(req.params.dur), abortOnClose(req));
    return sendStream(req, reply, body);
  });

  app.get<{ Params: { id: string; start: string; dur: string; pipeline: string; '*': string } }>(
    '/api/stream/timeshift/:id/:start/:dur/:pipeline/*',
    async (req, reply) => {
      const { id, start, dur, pipeline } = req.params;
      const file = req.params['*'];
      if (!isHlsPipeline(pipeline) || !/^[\w.-]+$/.test(file) || !/^\d+$/.test(start) || !/^\d+$/.test(dur)) {
        return reply.code(404).send({ error: 'not_found', message: 'Not found' });
      }
      return sendHls(reply, file, await p.timeshiftHls(id, Number(start), Number(dur), pipeline, file));
    },
  );

  // ----- rolling buffer -----
  type BufParams = { id: string; run: string; from: string };
  const bufOk = (q: BufParams) => /^\d+$/.test(q.run) && /^\d+$/.test(q.from);
  const notFound = { error: 'not_found', message: 'Not found' };

  app.get<{ Params: BufParams }>('/api/stream/buffer/:id/:run/:from/index.m3u8', async (req, reply) => {
    if (!bufOk(req.params)) return reply.code(404).send(notFound);
    const { id, run, from } = req.params;
    return sendHls(reply, 'index.m3u8', { text: p.bufferPlaylist(id, Number(run), Number(from)) });
  });

  app.get<{ Params: BufParams & { seq: string } }>('/api/stream/buffer/:id/:run/:from/seg/:seq.ts', async (req, reply) => {
    if (!bufOk(req.params) || !/^\d+$/.test(req.params.seq)) return reply.code(404).send(notFound);
    const file = p.bufferSegment(req.params.id, Number(req.params.run), Number(req.params.seq));
    return reply.header('cache-control', 'max-age=3600').type('video/mp2t').send(createReadStream(file));
  });

  app.get<{ Params: BufParams & { pipeline: string; '*': string } }>('/api/stream/buffer/:id/:run/:from/:pipeline/*', async (req, reply) => {
    const { id, run, from, pipeline } = req.params;
    const file = req.params['*'];
    if (!bufOk(req.params) || !isHlsPipeline(pipeline) || !/^[\w.-]+$/.test(file)) return reply.code(404).send(notFound);
    return sendHls(reply, file, await p.bufferHls(id, Number(run), Number(from), pipeline, file));
  });

  for (const kind of ['movie', 'episode'] as const satisfies VodKind[]) {
    app.get<{ Params: { id: string } }>(`/api/stream/${kind}/:id/video.mp4`, async (req, reply) => {
      return sendStream(req, reply, await p.vodFile(kind, req.params.id, req.headers.range, abortOnClose(req)));
    });
    app.get<{ Params: { id: string; pipeline: string; '*': string } }>(`/api/stream/${kind}/:id/:pipeline/*`, async (req, reply) => {
      const { id, pipeline } = req.params;
      const file = req.params['*'];
      if (!isHlsPipeline(pipeline)) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
      return sendHls(reply, file, await p.vodHls(kind, id, pipeline, file));
    });
  }
}
