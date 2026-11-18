import { PROFILE_NAME_MAX } from '@anycast/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isHomeAddress } from '../auth/net';
import { TRUSTED_COOKIE, TRUSTED_TTL_MS } from '../auth/twofactor';
import { SESSION_COOKIE, SESSION_TTL_MS, type SessionInfo, type UserRow } from '../auth/users';
import { CAST_CORS, castTokenOf } from '../cast';
import { auth, type Services } from '../context';

const LoginBody = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500) });
const TwoFactorBody = z.object({ challenge: z.string().min(1).max(100), code: z.string().trim().min(1).max(40), remember: z.boolean().optional() });
const Name = z.string().trim().min(1).max(PROFILE_NAME_MAX);
const CreateBody = z.object({ name: Name, avatar: z.string().max(40).nullable().optional() });
const PatchBody = z.object({ name: Name.optional(), avatar: z.string().max(40).nullable().optional() });

const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/auth/2fa', '/api/auth/device/start', '/api/auth/device/poll', '/api/health']);
/**
 * Routes that work before a profile is open (the profile picker and profile management): they are
 * not refused for a locked profile, and check what they touch themselves.
 */
const PROFILE_FREE = (url: string) => url === '/api/me' || url.startsWith('/api/auth/') || url === '/api/profiles' || url.startsWith('/api/profiles/');

const body = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});

/** What the device calls itself (x-anycast-device, e.g. "Chrome on Mac") */
export const deviceLabel = (req: FastifyRequest): string | null => {
  const v = req.headers['x-anycast-device'];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null;
};

export function lockedOut(reply: FastifyReply, seconds: number) {
  const mins = Math.max(1, Math.ceil(seconds / 60));
  return reply
    .code(429)
    .header('retry-after', String(seconds))
    .send({ error: 'locked_out', message: `Too many wrong tries. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, retryAfter: seconds });
}

/** Starts a session for the user on this device (session cookie) and answers Me. */
export function signIn(s: Services, req: FastifyRequest, reply: FastifyReply, user: UserRow, method: NonNullable<SessionInfo['method']>, label = deviceLabel(req)) {
  const token = s.users.createSession(user.id, { label, ip: req.ip, method });
  s.security.guard.succeed(req.ip);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/', secure: req.protocol === 'https', maxAge: SESSION_TTL_MS / 1000,
  });
  return s.users.me(user, token);
}

/** Resolves the session cookie and the profile (header x-anycast-profile, or ?profile= for EventSource). */
export function registerAuthHook(app: FastifyInstance, s: Services): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    // a TV opening a cast link: authenticated by the link's token, for that item's streams only
    const castToken = castTokenOf(req.raw);
    if (castToken) {
      if (req.method === 'OPTIONS') return reply.code(204).headers(CAST_CORS).send();
      const a = s.cast.resolve(castToken, url);
      if (!a) return reply.code(401).headers(CAST_CORS).send({ error: 'unauthorized', message: 'This cast link has ended. Cast again from the app.' });
      req.auth = a;
      return;
    }
    if (!url.startsWith('/api/') || PUBLIC_ROUTES.has(url)) return;
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? s.users.userForSession(token, req.ip) : null;
    if (!token || !user) return reply.code(401).send({ error: 'unauthorized', message: 'Please sign in' });
    const profiles = s.users.profiles(user.id, token);
    const q = req.query as Record<string, unknown>;
    const wanted = (req.headers['x-anycast-profile'] as string | undefined) ?? (typeof q.profile === 'string' ? q.profile : undefined);
    const profile = wanted ? profiles.find((p) => p.id === wanted) : profiles[0];
    if (!profile) return reply.code(403).send({ error: 'profile', message: 'This profile does not belong to you' });
    if (profile.needsPin && !PROFILE_FREE(url)) {
      return reply.code(403).send({ error: 'profile_locked', message: 'This profile is locked. Enter its PIN to open it.' });
    }
    req.auth = { user, profileId: profile.id, token };
  });
}

export function authRoutes(app: FastifyInstance, s: Services): void {
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'Username and password are required' });
    const { guard, twoFactor, challenges } = s.security;
    const account = body.data.username.toLowerCase();
    const wait = guard.retryAfter(req.ip, account);
    if (wait) return lockedOut(reply, wait);
    const user = await s.users.verifyLogin(body.data.username, body.data.password);
    if (!user) {
      guard.fail(req.ip, account);
      return reply.code(401).send({ error: 'invalid_login', message: 'Wrong username or password' });
    }
    if (twoFactor.enabled(user.id)) {
      if (twoFactor.isTrusted(user.id, req.cookies[TRUSTED_COOKIE])) return signIn(s, req, reply, user, 'trusted');
      return { twoFactor: challenges.create(user.id, deviceLabel(req)) };
    }
    if (s.config.requireTwoFactorOutside !== false && !isHomeAddress(req.ip)) {
      return reply.code(403).send({
        error: 'two_factor_required',
        message: 'Signing in from the internet needs two-step sign-in. Sign in at home once and turn it on in Settings › Security.',
      });
    }
    return signIn(s, req, reply, user, 'password');
  });

  app.post('/api/auth/2fa', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = TwoFactorBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Enter the code from your authenticator app' });
    const { guard, twoFactor, challenges } = s.security;
    const c = challenges.get(b.data.challenge);
    if (!c) return reply.code(410).send({ error: 'challenge_expired', message: 'That took too long. Sign in again.' });
    const user = s.users.byId(c.userId);
    if (!user) return reply.code(410).send({ error: 'challenge_expired', message: 'Sign in again.' });
    const account = user.username.toLowerCase();
    const wait = guard.retryAfter(req.ip, account);
    if (wait) return lockedOut(reply, wait);
    if (!twoFactor.verify(user.id, b.data.code)) {
      guard.fail(req.ip, account);
      const left = challenges.miss(b.data.challenge);
      if (left === 0) return reply.code(410).send({ error: 'challenge_expired', message: 'Too many wrong codes. Sign in again.' });
      return reply.code(401).send({ error: 'wrong_code', message: `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.`, attemptsLeft: left });
    }
    challenges.done(b.data.challenge);
    if (b.data.remember) {
      reply.setCookie(TRUSTED_COOKIE, twoFactor.trust(user.id, c.label), {
        httpOnly: true, sameSite: 'lax', path: '/api/auth', secure: req.protocol === 'https', maxAge: TRUSTED_TTL_MS / 1000,
      });
    }
    return signIn(s, req, reply, user, 'two_factor');
  });

  app.post('/api/auth/logout', async (req, reply) => {
    // signing out keeps "Remember this device": the next sign-in still needs the password
    s.users.deleteSession(auth(req).token);
    s.cast.revokeSession(auth(req).token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => s.users.me(auth(req).user, auth(req).token));

  app.get('/api/profiles', async (req) => s.users.profiles(auth(req).user.id, auth(req).token));

  app.post('/api/profiles', async (req, reply) => {
    const b = CreateBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: `A profile name (1-${PROFILE_NAME_MAX} characters) is required` });
    const p = s.users.createProfile(auth(req).user.id, b.data.name, b.data.avatar);
    return s.users.profile(auth(req).user.id, p.id, auth(req).token);
  });

  app.post('/api/profiles/leave', async (req) => {
    const keep = body(req).keep;
    s.users.leave(auth(req).token, typeof keep === 'string' ? keep : undefined);
    return { ok: true as const };
  });

  app.patch<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    const b = PatchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: `A profile name is 1-${PROFILE_NAME_MAX} characters` });
    return s.users.updateProfile(auth(req).user.id, req.params.id, auth(req).token, b.data);
  });

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req) => {
    s.users.deleteProfile(auth(req).user.id, req.params.id, auth(req).token);
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>('/api/profiles/:id/image', async (req) => {
    const b = body(req);
    return s.users.setImage(auth(req).user.id, req.params.id, auth(req).token, b.type, b.data);
  });

  app.delete<{ Params: { id: string } }>('/api/profiles/:id/image', async (req) => s.users.removeImage(auth(req).user.id, req.params.id, auth(req).token));

  // pictures show on the profile picker, so a locked profile's picture is served too
  app.get<{ Params: { id: string } }>('/api/profiles/:id/image', async (req, reply) => {
    const img = s.users.image(auth(req).user.id, req.params.id);
    if (!img) return reply.code(404).send({ error: 'not_found', message: 'No picture' });
    return reply
      .header('content-type', img.mime)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      // the URL carries ?v=<updated_at>, so a new picture is a new URL
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(img.data);
  });

  // wrong PINs are counted per profile (5 per 10 min); this only stops floods
  app.put<{ Params: { id: string } }>('/api/profiles/:id/lock', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const b = body(req);
    return s.users.setLock(auth(req).user, req.params.id, auth(req).token, { pin: b.pin, currentPin: b.currentPin, password: b.password });
  });

  app.post<{ Params: { id: string } }>('/api/profiles/:id/enter', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) =>
    s.users.enter(auth(req).user.id, req.params.id, auth(req).token, body(req).pin),
  );
}
