import type { FastifyInstance } from 'fastify';
import { auth, type Services } from '../context';
import { Diagnostics, type CommandRunner } from '../diagnostics';

/** GET /api/diagnostics: server health for Settings. Admin only. */
export function diagnosticsRoutes(app: FastifyInstance, s: Services, run?: CommandRunner): Diagnostics {
  const diag = new Diagnostics(s, run);
  app.get('/api/diagnostics', async (req, reply) => {
    if (auth(req).user.is_admin !== 1) {
      return reply.code(403).send({ error: 'forbidden', message: 'Only an admin can see server diagnostics' });
    }
    reply.header('cache-control', 'no-store');
    return diag.report();
  });
  return diag;
}
