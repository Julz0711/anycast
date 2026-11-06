import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE, SESSION_TTL_MS } from '../auth/users';
import { auth, type Services } from '../context';

const LoginBody = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500) });
const ProfileBody = z.object({ name: z.string().trim().min(1).max(40) });

const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/health']);

/** Resolves the session cookie and the profile (header x-anycast-profile, or ?profile= for EventSource). */
export function registerAuthHook(app: FastifyInstance, s: Services): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/') || PUBLIC_ROUTES.has(url)) return;
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? s.users.userForSession(token) : null;
    if (!token || !user) return reply.code(401).send({ error: 'unauthorized', message: 'Please sign in' });
    const profiles = s.users.profiles(user.id);
    const q = req.query as Record<string, unknown>;
    const wanted = (req.headers['x-anycast-profile'] as string | undefined) ?? (typeof q.profile === 'string' ? q.profile : undefined);
    const profile = wanted ? profiles.find((p) => p.id === wanted) : profiles[0];
    if (!profile) return reply.code(403).send({ error: 'profile', message: 'This profile does not belong to you' });
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
    return s.users.me(user);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    s.users.deleteSession(auth(req).token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => s.users.me(auth(req).user));

  app.get('/api/profiles', async (req) => s.users.profiles(auth(req).user.id));

  app.post('/api/profiles', async (req, reply) => {
    const body = ProfileBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'A profile name (1-40 characters) is required' });
    return s.users.createProfile(auth(req).user.id, body.data.name);
  });

  app.patch<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    const body = ProfileBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'A profile name (1-40 characters) is required' });
    return s.users.renameProfile(auth(req).user.id, req.params.id, body.data.name);
  });

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req) => {
    s.users.deleteProfile(auth(req).user.id, req.params.id);
    return { ok: true };
  });
}
