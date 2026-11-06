import type { FastifyInstance } from 'fastify';
import { auth, type Services } from '../context';

const HEARTBEAT_MS = 15_000;

/** Server-Sent Events: SyncEvents for the current profile plus catalog updates. */
export function eventRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/events', (req, reply) => {
    const { profileId } = auth(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const unsubscribe = s.bus.subscribe(profileId, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
