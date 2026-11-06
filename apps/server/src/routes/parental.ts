import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auth, type Services } from '../context';
import { parentalCtx, unlockCookieName } from '../parental';

const body = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});

/** Parental lock routes (see Api in @anycast/shared). The PIN hash never leaves the server. */
export function parentalRoutes(app: FastifyInstance, s: Services): void {
  const p = s.parental;
  const cookieOpts = (req: FastifyRequest) => ({ httpOnly: true, sameSite: 'lax' as const, path: '/api', secure: req.protocol === 'https' });
  const clearUnlock = (req: FastifyRequest, reply: FastifyReply) => {
    const name = unlockCookieName(auth(req).profileId);
    if (req.cookies[name]) reply.clearCookie(name, { path: '/api' });
  };

  app.get('/api/adult', async (req) => p.status(parentalCtx(req)));

  app.put('/api/adult/settings', async (req) => {
    const b = body(req);
    await p.updateSettings(parentalCtx(req), { mode: b.mode, unlockMinutes: b.unlockMinutes, pin: b.pin });
    return p.status(parentalCtx(req));
  });

  app.put('/api/adult/pin', async (req, reply) => {
    const b = body(req);
    await p.setPin(parentalCtx(req), auth(req).user, { pin: b.pin, currentPin: b.currentPin, password: b.password });
    clearUnlock(req, reply);
    return p.status({ ...parentalCtx(req), cookies: {} });
  });

  app.post('/api/adult/reset', async (req, reply) => {
    const profileId = body(req).profileId;
    if (typeof profileId !== 'string') return reply.code(400).send({ error: 'bad_request', message: 'profileId is required' });
    p.reset(auth(req).user, profileId);
    return { ok: true as const };
  });

  // 5 attempts per 10 min per profile are counted by Parental; this only stops floods
  app.post('/api/adult/unlock', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token, status } = await p.unlock(parentalCtx(req), body(req).pin);
    // no maxAge: a session cookie, gone when the browser closes; the server ends it after unlockMinutes
    reply.setCookie(unlockCookieName(auth(req).profileId), token, cookieOpts(req));
    return status;
  });

  app.post('/api/adult/lock', async (req, reply) => {
    p.lock(parentalCtx(req));
    clearUnlock(req, reply);
    return p.status({ ...parentalCtx(req), cookies: {} });
  });
}
