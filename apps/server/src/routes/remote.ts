import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth, type Services } from '../context';
import { viewerOf } from './playback';

const Text = (max: number) => z.string().max(max);
const Id = z.string().min(1).max(64);
const Kind = z.enum(['live', 'movie', 'episode']);
const Num = z.number().finite();

const NowPlaying = z
  .object({
    kind: Kind,
    id: Id,
    seriesId: Id.nullish(),
    title: Text(300),
    subtitle: Text(300).nullish(),
    image: Text(500).nullish(),
    paused: z.boolean(),
    waiting: z.boolean(),
    needsTap: z.boolean().optional(),
    position: Num,
    duration: Num.min(0),
    program: z.object({ start: Num, end: Num }).nullish(),
    behindMs: Num.min(0).optional(),
    volume: Num.min(0).max(1),
    muted: z.boolean(),
    canPrev: z.boolean(),
    canNext: z.boolean(),
    casting: z.boolean().optional(),
  })
  .strict();

const Presence = z
  .object({
    name: Text(60).nullish(),
    form: z.enum(['phone', 'large', 'tv']),
    playing: NowPlaying.nullable(),
  })
  .strict();

const Command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('toggle') }).strict(),
  z.object({ type: z.literal('play') }).strict(),
  z.object({ type: z.literal('pause') }).strict(),
  z.object({ type: z.literal('seekBy'), seconds: Num.min(-3600).max(3600) }).strict(),
  z.object({ type: z.literal('seekTo'), position: Num.min(0) }).strict(),
  z.object({ type: z.literal('live') }).strict(),
  z.object({ type: z.literal('volume'), level: Num.min(0).max(1) }).strict(),
  z.object({ type: z.literal('volumeBy'), delta: Num.min(-1).max(1) }).strict(),
  z.object({ type: z.literal('mute'), muted: z.boolean() }).strict(),
  z.object({ type: z.literal('step'), dir: z.union([z.literal(1), z.literal(-1)]) }).strict(),
  z.object({ type: z.literal('open'), kind: Kind, id: Id, seriesId: Id.optional() }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
]);
const CommandBody = z.object({ clientId: Id, command: Command }).strict();

const clean = (s: string | null | undefined) => (s ?? '').replace(/[\p{C}]/gu, '').trim() || null;

/** Remote control: devices announce themselves, phones list them and send commands (see remote.ts). */
export function remoteRoutes(app: FastifyInstance, s: Services): void {
  app.post('/api/remote/presence', async (req, reply) => {
    const viewer = viewerOf(req, s);
    if (!viewer) return reply.code(400).send({ error: 'bad_request', message: 'x-anycast-client is required' });
    const body = Presence.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'form and playing are required' });
    const { user } = auth(req);
    s.remote.announce({
      userId: user.id,
      clientId: viewer.clientId,
      profileId: viewer.profileId,
      profileName: viewer.profileName,
      name: clean(body.data.name),
      device: viewer.device,
      form: body.data.form,
      playing: body.data.playing ? { ...body.data.playing, seriesId: body.data.playing.seriesId ?? null } : null,
    });
    return { ok: true as const };
  });

  app.delete('/api/remote/presence', async (req) => {
    const viewer = viewerOf(req, s);
    if (viewer) s.remote.leave(auth(req).user.id, viewer.clientId);
    return { ok: true as const };
  });

  app.get('/api/remote/devices', async (req) => s.remote.devices(auth(req).user.id, viewerOf(req, s)?.clientId ?? null));

  app.post('/api/remote/command', async (req, reply) => {
    const body = CommandBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'clientId and a known command are required' });
    const from = viewerOf(req, s)?.device ?? null;
    if (!s.remote.command(auth(req).user.id, body.data.clientId, body.data.command, from)) {
      return reply.code(404).send({ error: 'not_found', message: 'That device is no longer open' });
    }
    return { ok: true as const };
  });
}
