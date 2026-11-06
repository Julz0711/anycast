import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { rawArtUrl } from '../catalog/store';
import type { Services } from '../context';

const MAX_BYTES = 5 * 1024 * 1024;

/** Proxies provider artwork (logos, posters) so the client never sees provider hosts. */
export function artRoutes(app: FastifyInstance, s: Services): void {
  app.get<{ Params: { kind: string; id: string } }>('/api/art/:kind/:id', async (req, reply) => {
    const kind = z.enum(['live', 'movie', 'series']).safeParse(req.params.kind);
    const url = kind.success ? rawArtUrl(s.db, kind.data, req.params.id) : null;
    if (!url || !/^https?:\/\//i.test(url)) return reply.code(404).send({ error: 'not_found', message: 'No artwork' });
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'AnyCast/0.1' } });
    } catch {
      return reply.code(502).send({ error: 'upstream', message: 'Artwork could not be loaded' });
    }
    const type = res.headers.get('content-type') ?? '';
    const length = Number(res.headers.get('content-length') ?? 0);
    if (!res.ok || !res.body || !type.startsWith('image/') || length > MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      return reply.code(404).send({ error: 'not_found', message: 'No artwork' });
    }
    reply.header('content-type', type).header('cache-control', 'private, max-age=86400');
    if (length) reply.header('content-length', String(length));
    return reply.send(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>));
  });
}
