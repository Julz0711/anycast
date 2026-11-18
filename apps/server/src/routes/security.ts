/** Settings › Security (two-step sign-in, signed-in devices) and signing in a TV with a code. */
import { normalizeDeviceCode, type DeviceCodeInfo, type SecurityStatus } from '@anycast/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isHomeAddress } from '../auth/net';
import { TRUSTED_COOKIE } from '../auth/twofactor';
import { HttpError } from '../auth/users';
import { sha256 } from '../crypto';
import { auth, type Services } from '../context';
import { deviceLabel, lockedOut, signIn } from './auth';

const Password = z.object({ password: z.string().min(1).max(500) });
const Code = z.object({ code: z.string().trim().min(1).max(40) });
const Disable = z.object({ password: z.string().min(1).max(500), code: z.string().trim().min(1).max(40) });
const Poll = z.object({ pollToken: z.string().min(1).max(100) });

export function securityRoutes(app: FastifyInstance, s: Services): void {
  const { twoFactor, guard, devices } = s.security;

  /** Checks the signed-in user's password, counting wrong ones like a sign-in does. */
  const checkPassword = async (req: FastifyRequest, password: string) => {
    const user = auth(req).user;
    const account = user.username.toLowerCase();
    const wait = guard.retryAfter(req.ip, account);
    if (wait) throw Object.assign(new HttpError(429, 'locked_out', `Too many wrong tries. Try again in ${Math.ceil(wait / 60)} minutes.`), { retryAfter: wait });
    if (!(await s.users.passwordMatches(user, password))) {
      guard.fail(req.ip, account);
      throw new HttpError(403, 'wrong_password', 'Wrong password');
    }
  };
  const checkCode = (req: FastifyRequest, code: string) => {
    const user = auth(req).user;
    const account = user.username.toLowerCase();
    const wait = guard.retryAfter(req.ip, account);
    if (wait) throw new HttpError(429, 'locked_out', `Too many wrong tries. Try again in ${Math.ceil(wait / 60)} minutes.`);
    if (!twoFactor.verify(user.id, code)) {
      guard.fail(req.ip, account);
      throw new HttpError(403, 'wrong_code', 'Wrong code');
    }
  };

  app.get('/api/auth/security', async (req): Promise<SecurityStatus> => {
    const { user, token } = auth(req);
    const current = sha256(token);
    return {
      twoFactor: twoFactor.status(user.id),
      trustedDevices: twoFactor.trustedCount(user.id),
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
      here: { ip: req.ip, outside: !isHomeAddress(req.ip) },
      outsideNeedsTwoFactor: s.config.requireTwoFactorOutside !== false,
    };
  });

  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/2fa/setup', strict, async (req, reply) => {
    const b = Password.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Enter your password' });
    await checkPassword(req, b.data.password);
    return twoFactor.begin(auth(req).user.id, auth(req).user.username);
  });

  app.post('/api/auth/2fa/enable', strict, async (req, reply) => {
    const b = Code.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Enter the 6-digit code' });
    return { recoveryCodes: twoFactor.enable(auth(req).user.id, b.data.code) };
  });

  app.post('/api/auth/2fa/disable', strict, async (req, reply) => {
    const b = Disable.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Enter your password and a code' });
    await checkPassword(req, b.data.password);
    checkCode(req, b.data.code);
    twoFactor.disable(auth(req).user.id);
    reply.clearCookie(TRUSTED_COOKIE, { path: '/api/auth' });
    return { ok: true as const };
  });

  app.post('/api/auth/2fa/recovery-codes', strict, async (req, reply) => {
    const b = Code.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Enter a code' });
    checkCode(req, b.data.code);
    return { recoveryCodes: twoFactor.newRecoveryCodes(auth(req).user.id) };
  });

  app.delete('/api/auth/trusted', async (req, reply) => {
    twoFactor.forgetTrusted(auth(req).user.id);
    reply.clearCookie(TRUSTED_COOKIE, { path: '/api/auth' });
    return { ok: true as const };
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
    const wait = guard.retryAfter(req.ip);
    if (wait) return lockedOut(reply, wait);
    return devices.start(deviceLabel(req), req.ip);
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
    return { code: r.code, label: r.label, ip: r.ip, outside: !isHomeAddress(r.ip), createdAt: r.createdAt, expiresAt: r.expiresAt };
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
