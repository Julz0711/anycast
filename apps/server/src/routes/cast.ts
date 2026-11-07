import { CHROMECAST_CAPS, type CastPlayResponse, type PlaybackInfo } from '@anycast/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAST_CORS, castTokenOf, normalizeBaseUrl, scopeOfPath } from '../cast';
import { auth, type Services } from '../context';
import { parentalCtx } from '../parental';
import { parseCaps, type ClientCaps } from '../playback/caps';
import type { TrackRequest } from '../playback/service';
import { viewerOf } from './playback';

const Track = z.number().int().min(0).max(99);
const PlayBody = z
  .object({
    kind: z.enum(['live', 'movie', 'episode']),
    id: z.string().min(1).max(64),
    target: z.enum(['chromecast', 'airplay']),
    at: z.number().finite().optional(),
    audio: Track.optional(),
    sub: z.union([Track, z.literal('off')]).optional(),
  })
  .strict();
const SettingsBody = z.object({ baseUrl: z.string().max(300).nullable() }).strict();

const chromecastCaps: ClientCaps = { hls: CHROMECAST_CAPS.hls, mse: CHROMECAST_CAPS.mse, codecs: [...CHROMECAST_CAPS.codecs] };

/** Casting: streams for a TV and the address TVs reach the server at (see cast.ts). */
export function castRoutes(app: FastifyInstance, s: Services): void {
  // the TV's player reads cast links cross-origin
  app.addHook('onSend', async (req, reply) => {
    if (castTokenOf(req.raw)) reply.headers(CAST_CORS);
  });

  app.post('/api/cast/play', async (req, reply) => {
    const body = PlayBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'kind, id and target are required' });
    const { kind, id, target, at } = body.data;
    const a = auth(req);
    const adult = s.parental.view(parentalCtx(req));
    if (adult.adultIds.size) adult.assertOpen(s.parental.categoryOf(kind, id));

    const caps = target === 'chromecast' ? chromecastCaps : parseCaps(req.headers['x-anycast-caps'] as string | undefined);
    const tracks: TrackRequest = {
      audio: body.data.audio,
      sub: body.data.sub,
      saved: s.userData.trackChoice(a.profileId, kind, id),
      prefs: s.userData.preferences(a.profileId).player,
    };
    // the same viewer (this app) as its own player: its claim moves to the TV's stream
    const viewer = viewerOf(req, s);
    const p = s.playback;
    let info: PlaybackInfo;
    if (kind === 'live') {
      info = at !== undefined ? await p.atInfo(id, Math.round(at), caps, viewer, tracks) : await p.liveInfo(id, caps, viewer, tracks);
    } else {
      const saved = s.userData.progressFor(a.profileId, kind, id);
      const resumeAt = saved && !saved.finished && saved.position > 0 ? saved.position : null;
      info = await p.vodInfo(kind, id, caps, resumeAt, viewer, tracks);
    }
    const scope = scopeOfPath(info.url);
    if (!scope) return reply.code(500).send({ error: 'error', message: 'Something went wrong' });
    const token = s.cast.create(a, scope);
    const res: CastPlayResponse = { info, castPath: `/cast/${token}${info.url}`, baseUrl: s.cast.baseUrl() };
    return res;
  });

  app.get('/api/cast/settings', async () => ({ baseUrl: s.cast.baseUrl() }));

  app.put('/api/cast/settings', async (req, reply) => {
    if (auth(req).user.is_admin !== 1) {
      return reply.code(403).send({ error: 'forbidden', message: 'Only an admin can change the casting address' });
    }
    const body = SettingsBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'baseUrl is required (null to clear it)' });
    const raw = body.data.baseUrl?.trim() ?? '';
    const url = raw ? normalizeBaseUrl(raw) : null;
    if (raw && !url) {
      return reply.code(400).send({ error: 'bad_request', message: 'Enter the address as http://192.168.1.20:8787 (http or https, the server and port, nothing after it)' });
    }
    s.cast.setBaseUrl(url);
    return { baseUrl: url };
  });
}
