import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth, type Services } from '../context';
import type { BufferManager } from '../playback/buffer';

const PinBody = z.object({ channelId: z.string().min(1).max(64), pinned: z.boolean() });

/** Rolling live buffer: pinned channels and status. */
export function bufferRoutes(app: FastifyInstance, s: Services): void {
  const off = { error: 'buffer_disabled', message: 'The live buffer is turned off on this server' };
  const pinsOf = (b: BufferManager) => ({ channelIds: b.pins(), maxPins: b.maxPins() });

  app.get('/api/buffer/pins', async (_req, reply) => {
    const b = s.playback.buffer;
    return b ? pinsOf(b) : reply.code(404).send(off);
  });

  app.put('/api/buffer/pins', async (req, reply) => {
    if (auth(req).user.is_admin !== 1) {
      return reply.code(403).send({ error: 'forbidden', message: 'Only an admin can choose which channels keep a rewind buffer' });
    }
    const b = s.playback.buffer;
    if (!b) return reply.code(404).send(off);
    const body = PinBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'channelId and pinned are required' });
    await b.setPin(body.data.channelId, body.data.pinned);
    return pinsOf(b);
  });

  app.get('/api/buffer/status', async (_req, reply) => {
    const b = s.playback.buffer;
    return b ? b.status() : reply.code(404).send(off);
  });
}
