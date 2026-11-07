/**
 * Casting (Chromecast, AirPlay): a TV fetches the stream itself, without the browser's session
 * cookie. A cast link is a stream URL with a random token in its path,
 *   /cast/<token>/api/stream/live/123/remux/index.m3u8
 * which the server rewrites to the plain stream URL (rewriteUrl in app.ts) and authenticates as
 * the sign-in session that made the link. Segment URLs in playlists are relative, so they keep
 * the token. A token opens only the streams of one item (a channel's live, archive and buffer
 * streams, or one movie or episode), ends with its sign-in session, and lapses after a day unused.
 *
 * It is the same stream the phone or computer asked for (same claim, same server session), so
 * casting never needs a second provider connection.
 */
import type { CastScope } from '@anycast/shared';
import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Users } from './auth/users';
import type { AuthContext } from './context';
import { kvGet, kvSet, type Db } from './db';

const TOKEN = /^\/cast\/([A-Za-z0-9_-]{43})(\/api\/stream\/[^?#]*)(\?.*)?$/;
const IDLE_MS = 24 * 3600_000;
const MAX_LINKS = 500;
const BASE_KEY = 'castBaseUrl';

type RawWithCast = IncomingMessage & { anycastCast?: string };

/** rewriteUrl for Fastify: /cast/<token>/api/stream/... -> /api/stream/..., remembering the token. */
export function rewriteCastUrl(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const m = TOKEN.exec(url);
  if (!m) return url;
  (req as RawWithCast).anycastCast = m[1];
  return m[2]! + (m[3] ?? '');
}

/** The cast token of a request that came in through a cast link, else null. */
export function castTokenOf(raw: IncomingMessage): string | null {
  return (raw as RawWithCast).anycastCast ?? null;
}

/** The TV's player (Chromecast's receiver page) reads streams cross-origin. */
export const CAST_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range, content-type',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges, content-type',
  'access-control-max-age': '600',
};

/** Path prefixes of the streams an item plays, with the id as the stream URLs encode it. */
export function scopePrefixes(scope: CastScope): string[] {
  const e = encodeURIComponent(scope.id);
  if (scope.kind === 'live') {
    return [`/api/stream/live/${e}/`, `/api/stream/live/${e}.ts`, `/api/stream/timeshift/${e}/`, `/api/stream/timeshift/${e}.ts`, `/api/stream/buffer/${e}/`];
  }
  return [`/api/stream/${scope.kind}/${e}/`];
}

/** The item a stream URL plays, or null when it is not a stream URL. */
export function scopeOfPath(path: string): CastScope | null {
  const m = /^\/api\/stream\/(live|timeshift|buffer|movie|episode)\/([^/?#]+?)(?:\.ts)?(?:[/?#]|$)/.exec(path);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  const kind = m[1] === 'movie' || m[1] === 'episode' ? m[1] : 'live';
  return { kind, id };
}

export function allows(scope: CastScope, path: string): boolean {
  const p = path.split('?')[0]!;
  if (p.includes('/../') || p.includes('/./')) return false;
  return scopePrefixes(scope).some((pre) => p.startsWith(pre));
}

/** An address the TV can open: http(s)://host[:port], no path, credentials or query. */
export function normalizeBaseUrl(raw: string): string | null {
  const v = raw.trim().replace(/\/+$/, '');
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return null;
  return u.origin;
}

interface Link {
  userId: string;
  session: string;
  profileId: string;
  scope: CastScope;
  lastUsed: number;
}

export class CastLinks {
  private readonly links = new Map<string, Link>();

  constructor(
    private readonly users: Users,
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** A token for `scope` made from this sign-in session (the same one again while it is in use). */
  create(a: AuthContext, scope: CastScope): string {
    const t = this.now();
    for (const [token, l] of this.links) {
      if (t - l.lastUsed > IDLE_MS) this.links.delete(token);
      else if (l.session === a.token && l.profileId === a.profileId && l.scope.kind === scope.kind && l.scope.id === scope.id) {
        l.lastUsed = t;
        return token;
      }
    }
    if (this.links.size >= MAX_LINKS) {
      const oldest = [...this.links.entries()].sort((x, y) => x[1].lastUsed - y[1].lastUsed)[0];
      if (oldest) this.links.delete(oldest[0]);
    }
    const token = randomBytes(32).toString('base64url');
    this.links.set(token, { userId: a.user.id, session: a.token, profileId: a.profileId, scope, lastUsed: t });
    return token;
  }

  /** Who a cast request acts as, or null (unknown or lapsed token, ended session, or a stream of another item). */
  resolve(token: string, path: string): AuthContext | null {
    const l = this.links.get(token);
    if (!l) return null;
    const t = this.now();
    if (t - l.lastUsed > IDLE_MS) {
      this.links.delete(token);
      return null;
    }
    if (!allows(l.scope, path)) return null;
    const user = this.users.userForSession(l.session);
    if (!user || user.id !== l.userId) {
      this.links.delete(token);
      return null;
    }
    l.lastUsed = t;
    return { user, profileId: l.profileId, token: l.session };
  }

  /** Ends the links of a sign-in session (sign out). */
  revokeSession(session: string): void {
    for (const [token, l] of this.links) if (l.session === session) this.links.delete(token);
  }

  /** The address TVs reach the server at, when set (Settings > Casting). */
  baseUrl(): string | null {
    return kvGet(this.db, BASE_KEY) || null;
  }

  setBaseUrl(url: string | null): void {
    kvSet(this.db, BASE_KEY, url ?? '');
  }
}
