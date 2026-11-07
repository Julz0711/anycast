import { PROFILE_NAME_MAX } from '@anycast/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE, SESSION_TTL_MS } from '../auth/users';
import { auth, type Services } from '../context';

const LoginBody = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500) });
const Name = z.string().trim().min(1).max(PROFILE_NAME_MAX);
const CreateBody = z.object({ name: Name, avatar: z.string().max(40).nullable().optional() });
const PatchBody = z.object({ name: Name.optional(), avatar: z.string().max(40).nullable().optional() });

const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/health']);
/**
 * Routes that work before a profile is open (the profile picker and profile management): they are
 * not refused for a locked profile, and check what they touch themselves.
 */
const PROFILE_FREE = (url: string) => url === '/api/me' || url === '/api/auth/logout' || url === '/api/profiles' || url.startsWith('/api/profiles/');

const body = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});

/** Resolves the session cookie and the profile (header x-anycast-profile, or ?profile= for EventSource). */
export function registerAuthHook(app: FastifyInstance, s: Services): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/') || PUBLIC_ROUTES.has(url)) return;
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? s.users.userForSession(token) : null;
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
    const user = await s.users.verifyLogin(body.data.username, body.data.password);
    if (!user) return reply.code(401).send({ error: 'invalid_login', message: 'Wrong username or password' });
    const token = s.users.createSession(user.id);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', path: '/', secure: req.protocol === 'https', maxAge: SESSION_TTL_MS / 1000,
    });
    return s.users.me(user, token);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    s.users.deleteSession(auth(req).token);
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
