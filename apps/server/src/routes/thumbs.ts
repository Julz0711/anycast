import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import type { Services } from '../context';
import { Thumbnails } from '../playback/thumbs';

const notFound = { error: 'not_found', message: 'Not found' };

/** Scrub thumbnails (PB-1): the index of a movie's or episode's tiles, and its sprite sheets. */
export function thumbRoutes(app: FastifyInstance, s: Services): void {
  for (const kind of ['movie', 'episode'] as const) {
    app.get<{ Params: { id: string } }>(`/api/thumbs/${kind}/:id`, async (req, reply) => {
      const thumbs = s.playback.thumbs;
      if (!thumbs || !Thumbnails.validId(req.params.id)) return reply.code(404).send(notFound);
      return reply.header('cache-control', 'no-cache').send(await thumbs.index(kind, req.params.id));
    });
    app.get<{ Params: { id: string; n: string } }>(`/api/thumbs/${kind}/:id/sheet/:n.jpg`, async (req, reply) => {
      const thumbs = s.playback.thumbs;
      if (!thumbs || !Thumbnails.validId(req.params.id) || !/^\d{1,6}$/.test(req.params.n)) return reply.code(404).send(notFound);
      const file = await thumbs.sheet(kind, req.params.id, Number(req.params.n));
      if (!file) return reply.code(404).send(notFound);
      // the index versions sheet urls (?v=tile count), so a cached copy is never stale for its url
      return reply.header('cache-control', 'private, max-age=86400').type('image/jpeg').send(createReadStream(file));
    });
  }
}
