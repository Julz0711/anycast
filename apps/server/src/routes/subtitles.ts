/**
 * External subtitles (subtitles/service.ts): per-item state, online search and download, files
 * from the device, each profile's pick, the WebVTT files, and the OpenSubtitles login (admins).
 */
import { SUBTITLE_LIMITS } from '@anycast/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auth, type Services } from '../context';
import { parentalCtx } from '../parental';
import { OpenSubtitlesError } from '../subtitles/opensubtitles';
import { SubtitleError, type SubKind } from '../subtitles/service';

const SettingsBody = z.object({
  apiKey: z.string().max(SUBTITLE_LIMITS.apiKey).optional(),
  username: z.string().max(SUBTITLE_LIMITS.username).optional(),
  password: z.string().max(SUBTITLE_LIMITS.password).optional(),
});
const ChoiceBody = z.object({ fileId: z.string().max(40).nullable(), offsetMs: z.number().finite().optional() });
const UploadBody = z.object({
  name: z.string().max(SUBTITLE_LIMITS.name * 2),
  // base64 of up to uploadBytes
  data: z.string().max(Math.ceil(SUBTITLE_LIMITS.uploadBytes / 3) * 4 + 8),
  language: z.string().max(12).nullable().optional(),
});

function adminOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (auth(req).user.is_admin === 1) return true;
  void reply.code(403).send({ error: 'forbidden', message: 'Only an admin can change online subtitles' });
  return false;
}

export function subtitleRoutes(app: FastifyInstance, s: Services): void {
  const sub = s.subtitles;

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SubtitleError) return reply.code(err.status).send({ error: err.code, message: err.message });
    throw err;
  };

  /** movie | episode, in the catalog, and open to this profile (adult lock) */
  const item = (req: FastifyRequest<{ Params: { kind: string; id: string } }>): { kind: SubKind; id: string } => {
    const { kind, id } = req.params;
    if (kind !== 'movie' && kind !== 'episode') throw new SubtitleError(404, 'not_found', 'Not found');
    sub.exists(kind, id);
    const adult = s.parental.view(parentalCtx(req));
    if (adult.adultIds.size) adult.assertOpen(s.parental.categoryOf(kind, id));
    return { kind, id };
  };

  // the admin routes come first: /settings is not an item kind
  app.get('/api/subtitles/settings', async (req, reply) => {
    if (!adminOnly(req, reply)) return reply;
    reply.header('cache-control', 'no-store');
    return sub.settings();
  });

  const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.put('/api/subtitles/settings', limited, async (req, reply) => {
    if (!adminOnly(req, reply)) return reply;
    const body = SettingsBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'Enter the API key, and the username and password if you add an account.' });
    try {
      const login = sub.merge(body.data);
      let message: string;
      try {
        message = await sub.test(login);
      } catch (err) {
        if (err instanceof OpenSubtitlesError) return reply.code(400).send({ error: 'opensubtitles', message: err.message });
        throw err;
      }
      sub.save(login);
      req.log.info('OpenSubtitles login changed in the app');
      return { ...sub.settings(), test: { ok: true, message } };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/subtitles/settings', async (req, reply) => {
    if (!adminOnly(req, reply)) return reply;
    sub.clear();
    return sub.settings();
  });

  app.get<{ Params: { fileId: string } }>('/api/subtitles/file/:fileId', async (req, reply) => {
    const f = sub.file(req.params.fileId);
    if (!f) return reply.code(404).send({ error: 'not_found', message: 'Subtitle not found' });
    const adult = s.parental.view(parentalCtx(req));
    if (adult.adultIds.size) adult.assertOpen(s.parental.categoryOf(f.kind, f.itemId));
    return reply.header('cache-control', 'private, max-age=86400').type('text/vtt; charset=utf-8').send(f.vtt);
  });

  app.get<{ Params: { kind: string; id: string } }>('/api/subtitles/:kind/:id', async (req, reply) => {
    try {
      const { kind, id } = item(req);
      const { profileId } = auth(req);
      reply.header('cache-control', 'no-store');
      return sub.state(profileId, kind, id, s.userData.trackChoice(profileId, kind, id)?.subtitle === null);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { kind: string; id: string }; Querystring: { lang?: string } }>('/api/subtitles/:kind/:id/search', limited, async (req, reply) => {
    try {
      const { kind, id } = item(req);
      return await sub.search(kind, id, req.query.lang ?? '');
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { kind: string; id: string } }>('/api/subtitles/:kind/:id/download', limited, async (req, reply) => {
    try {
      const { kind, id } = item(req);
      const fileId = (req.body as { fileId?: unknown } | null)?.fileId;
      if (typeof fileId !== 'string') return reply.code(400).send({ error: 'bad_request', message: 'fileId is required' });
      return await sub.download(kind, id, fileId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { kind: string; id: string } }>('/api/subtitles/:kind/:id/auto', limited, async (req, reply) => {
    try {
      const { kind, id } = item(req);
      const language = (req.body as { language?: unknown } | null)?.language;
      if (typeof language !== 'string') return reply.code(400).send({ error: 'bad_request', message: 'language is required' });
      return { file: await sub.auto(kind, id, language) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { kind: string; id: string } }>(
    '/api/subtitles/:kind/:id/upload',
    { bodyLimit: SUBTITLE_LIMITS.uploadBytes * 2, ...limited },
    async (req, reply) => {
      try {
        const { kind, id } = item(req);
        const body = UploadBody.safeParse(req.body ?? {});
        if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'That file is too big for a subtitle file.' });
        const bytes = Buffer.from(body.data.data, 'base64');
        return { file: sub.upload(kind, id, body.data.name, bytes, body.data.language ?? null), remaining: null };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.put<{ Params: { kind: string; id: string } }>('/api/subtitles/:kind/:id/choice', async (req, reply) => {
    try {
      const { kind, id } = item(req);
      const body = ChoiceBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'fileId is a kept subtitle id, or null for off' });
      sub.saveChoice(auth(req).profileId, kind, id, body.data.fileId, body.data.offsetMs);
      return { ok: true as const };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
