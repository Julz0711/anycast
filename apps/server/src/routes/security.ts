/** Settings › Security (signed-in devices) and signing in a TV with a code a signed-in device approves. */
import { normalizeDeviceCode, type DeviceCodeInfo, type SecurityStatus } from '@anycast/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientIp, fromInternet, isHomeAddress } from '../auth/net';
import { HttpError } from '../auth/users';
import { sha256 } from '../crypto';
import { auth, type Services } from '../context';
import { deviceLabel, lockedOut, signIn } from './auth';

const Poll = z.object({ pollToken: z.string().min(1).max(100) });

export function securityRoutes(app: FastifyInstance, s: Services): void {
  const { guard, devices } = s.security;

  app.get('/api/auth/security', async (req): Promise<SecurityStatus> => {
    const { user, token } = auth(req);
    const current = sha256(token);
    return {
      devices: s.users.sessions(user.id).map((r) => ({
        id: r.id,
        label: r.label,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at ?? r.created_at,
        ip: r.ip,
        outside: r.ip ? !isHomeAddress(r.ip) : false,
        method: r.method ?? null,
        current: r.token_hash === current,
      })),
      here: { ip: clientIp(req), outside: fromInternet(req) },
      passwordFromInternet: s.config.passwordFromInternet === true,
    };
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req, reply) => {
    const hash = s.users.deleteSessionById(auth(req).user.id, req.params.id);
    if (!hash) return reply.code(404).send({ error: 'not_found', message: 'That device is already signed out' });
    s.cast.revokeSessionHash(hash);
    return { ok: true as const };
  });

  app.post('/api/auth/sessions/sign-out-others', async (req) => {
    const gone = s.users.deleteOtherSessions(auth(req).user.id, auth(req).token);
    for (const h of gone) s.cast.revokeSessionHash(h);
    return { removed: gone.length };
  });

  /* ---------------- a TV signs in with a code ---------------- */

  app.post('/api/auth/device/start', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const wait = guard.retryAfter(clientIp(req));
    if (wait) return lockedOut(reply, wait);
    return devices.start(deviceLabel(req), clientIp(req), fromInternet(req));
  });

  app.post('/api/auth/device/poll', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = Poll.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'pollToken is required' });
    const r = devices.poll(b.data.pollToken);
    if (r.status !== 'approved') return r;
    const user = s.users.byId(r.userId);
    if (!user) return { status: 'expired' as const };
    return { status: 'approved' as const, me: signIn(s, req, reply, user, 'approved', r.label) };
  });

  const pending = (raw: string) => {
    const r = devices.get(normalizeDeviceCode(raw));
    if (!r) throw new HttpError(404, 'not_found', 'This code has expired or was already used. Show a new code on the TV.');
    return r;
  };

  // looking codes up needs a signed-in account; this only stops typo floods
  const lookup = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get<{ Params: { code: string } }>('/api/auth/device/:code', lookup, async (req): Promise<DeviceCodeInfo> => {
    const r = pending(req.params.code);
    return { code: r.code, label: r.label, ip: r.ip, outside: r.outside, createdAt: r.createdAt, expiresAt: r.expiresAt };
  });

  app.post<{ Params: { code: string } }>('/api/auth/device/:code/approve', lookup, async (req) => {
    const r = pending(req.params.code);
    devices.approve(r.code, auth(req).user.id);
    req.log.info({ device: r.label, ip: r.ip }, 'device sign-in approved');
    return { ok: true as const };
  });

  app.post<{ Params: { code: string } }>('/api/auth/device/:code/deny', lookup, async (req) => {
    devices.deny(pending(req.params.code).code);
    return { ok: true as const };
  });
}
