/**
 * The provider login (admins only, since every profile shares it): GET shows the address and
 * user (never the password), POST /test tries a login, PUT tests then saves it and starts a sync.
 */
import { parseProviderUrl, PROVIDER_LIMITS, type ProviderTestResult } from '@anycast/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { XtreamCredentials } from '../config';
import { auth, type Services } from '../context';
import { XtreamClient, XtreamError, type ClientOptions } from '../xtream/client';

const Body = z.object({
  url: z.string().trim().min(1).max(PROVIDER_LIMITS.url),
  username: z.string().trim().min(1).max(PROVIDER_LIMITS.username),
  password: z.string().max(PROVIDER_LIMITS.password).optional(),
});

class LoginInputError extends Error {}

function adminOnly(req: FastifyRequest, reply: FastifyReply, what: string): boolean {
  if (auth(req).user.is_admin === 1) return true;
  void reply.code(403).send({ error: 'forbidden', message: `Only an admin can ${what}` });
  return false;
}

/**
 * The login to try. Without a password the saved one is used, but only for the saved address:
 * the saved password is never sent to a different server.
 */
function loginFrom(body: unknown, saved: XtreamCredentials | null): XtreamCredentials {
  const b = Body.safeParse(body);
  if (!b.success) throw new LoginInputError('Enter the server address and username.');
  const parsed = parseProviderUrl(b.data.url);
  if (!parsed) throw new LoginInputError('The server address should look like http://provider.example:8080');
  const password = b.data.password?.trim() ? b.data.password.trim() : null;
  if (password) return { url: parsed.url, username: b.data.username, password };
  if (!saved) throw new LoginInputError('Enter the password.');
  if (saved.url !== parsed.url) throw new LoginInputError('Enter the password again for a new server address.');
  return { url: parsed.url, username: b.data.username, password: saved.password };
}

/** Logs in once (no retries, short timeout); the message never contains the login. */
export async function tryLogin(creds: XtreamCredentials, opts: ClientOptions = {}): Promise<ProviderTestResult> {
  try {
    const auth = await new XtreamClient(creds, { timeoutMs: 20_000, retries: 0, ...opts }).authenticate();
    const u = auth.user_info;
    return {
      ok: true,
      account: { status: u.status ?? 'Unknown', expiresAt: u.exp_date ? u.exp_date * 1000 : null, maxConnections: u.max_connections && u.max_connections > 0 ? u.max_connections : null },
    };
  } catch (err) {
    const code = err instanceof XtreamError ? err.code : 'network';
    const message =
      code === 'auth'
        ? 'The provider rejected this username or password.'
        : code === 'network'
          ? "Couldn't reach the server. Check the address and port."
          : code === 'parse'
            ? "That address answered, but not like an Xtream Codes server. Check the address and port."
            : `The server answered with an error: ${(err as Error).message}`;
    return { ok: false, message };
  }
}

export function providerRoutes(app: FastifyInstance, s: Services, clientOptions: ClientOptions = {}): void {
  app.get('/api/provider', async (req, reply) => {
    if (!adminOnly(req, reply, 'see the provider login')) return reply;
    reply.header('cache-control', 'no-store');
    return s.source.settings();
  });

  const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.post('/api/provider/test', limited, async (req, reply) => {
    if (!adminOnly(req, reply, 'test the provider login')) return reply;
    let creds: XtreamCredentials;
    try {
      creds = loginFrom(req.body, s.source.credentials());
    } catch (err) {
      if (err instanceof LoginInputError) return reply.code(400).send({ error: 'bad_request', message: err.message });
      throw err;
    }
    return tryLogin(creds, clientOptions);
  });

  app.put('/api/provider', limited, async (req, reply) => {
    if (!adminOnly(req, reply, 'change the provider login')) return reply;
    let creds: XtreamCredentials;
    try {
      creds = loginFrom(req.body, s.source.credentials());
    } catch (err) {
      if (err instanceof LoginInputError) return reply.code(400).send({ error: 'bad_request', message: err.message });
      throw err;
    }
    const test = await tryLogin(creds, clientOptions);
    if (!test.ok) return reply.code(400).send({ error: 'provider_login', message: test.message });
    const before = s.source.credentials();
    s.source.save(creds);
    req.log.info('provider login changed in the app');
    // a new login: load the catalog with it now (the scheduler would only in a while)
    if (!before || before.url !== creds.url || before.username !== creds.username || before.password !== creds.password) {
      // a sync that already runs keeps the old login; sync again after it
      void (async () => {
        if (s.sync.syncing) await s.sync.syncAll().catch(() => undefined);
        await s.sync.syncAll();
      })().catch(() => undefined);
    }
    return s.source.settings();
  });
}
