import type { HwAccelSetting } from '@anycast/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auth, type Services } from '../context';
import { Diagnostics, type CommandRunner } from '../diagnostics';
import { HW_SETTINGS } from '../playback/hwaccel';

function adminOnly(req: FastifyRequest, reply: FastifyReply, what: string): boolean {
  if (auth(req).user.is_admin === 1) return true;
  void reply.code(403).send({ error: 'forbidden', message: `Only an admin can ${what}` });
  return false;
}

/** GET /api/diagnostics: server health for Settings. Admin only. */
export function diagnosticsRoutes(app: FastifyInstance, s: Services, run?: CommandRunner): Diagnostics {
  const diag = new Diagnostics(s, run);
  app.get('/api/diagnostics', async (req, reply) => {
    if (!adminOnly(req, reply, 'see server diagnostics')) return reply;
    reply.header('cache-control', 'no-store');
    return diag.report();
  });

  // hardware encoding (Settings › All › Player): status, an admin override, check again
  const hw = s.playback.hw;
  app.get('/api/hwaccel', async (req, reply) => {
    if (!adminOnly(req, reply, 'see the hardware encoding setting')) return reply;
    reply.header('cache-control', 'no-store');
    await hw.settled();
    return hw.status();
  });
  app.put('/api/hwaccel', async (req, reply) => {
    if (!adminOnly(req, reply, 'change hardware encoding')) return reply;
    const setting = (req.body as { setting?: unknown } | null)?.setting;
    if (setting !== null && !HW_SETTINGS.includes(setting as HwAccelSetting)) {
      return reply.code(400).send({ error: 'invalid', message: `setting must be null or one of ${HW_SETTINGS.join(', ')}` });
    }
    return hw.setOverride(setting as HwAccelSetting | null);
  });
  app.post('/api/hwaccel/check', async (req, reply) => {
    if (!adminOnly(req, reply, 'check the hardware encoders')) return reply;
    return hw.check();
  });
  return diag;
}
