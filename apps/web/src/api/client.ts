/**
 * Typed API client generated from the shared `Api` route table.
 *   call('GET /api/live', { query: { categoryId } })
 *   call('PATCH /api/profiles/:id', { params: { id }, body: { name } })
 */
import type { Api } from '@anycast/shared';
import { isDemo } from '../demo/flag';

export type Route = keyof Api;
type Def<R extends Route> = Api[R];
export type ResOf<R extends Route> = Def<R>['res'];
export type QueryOf<R extends Route> = Def<R> extends { query: infer Q } ? Q : never;
export type BodyOf<R extends Route> = Def<R> extends { body: infer B } ? B : never;

export interface CallOpts<R extends Route> {
  params?: Record<string, string>;
  query?: QueryOf<R>;
  body?: BodyOf<R>;
  signal?: AbortSignal;
  /** survives page unload (used for progress on pagehide) */
  keepalive?: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get offline() {
    return this.status === 0;
  }
}

interface ClientHooks {
  profileId: () => string | null;
  caps: () => string | null;
  onUnauthorized: () => void;
  /** 403 {error:'profile'}: the stored profile is gone or not ours */
  onProfileInvalid: () => void;
}
let hooks: ClientHooks = { profileId: () => null, caps: () => null, onUnauthorized: () => {}, onProfileInvalid: () => {} };
export function configureClient(h: Partial<ClientHooks>) {
  hooks = { ...hooks, ...h };
}

export function buildPath(route: string, params?: Record<string, string>, query?: object): string {
  const [, path = ''] = route.split(' ');
  const filled = path.replace(/:([A-Za-z]+)/g, (_, k: string) => {
    const v = params?.[k];
    if (v === undefined) throw new Error(`Missing path param ${k} for ${route}`);
    return encodeURIComponent(v);
  });
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${filled}?${s}` : filled;
}

export function requestHeaders(json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['content-type'] = 'application/json';
  const p = hooks.profileId();
  if (p) h['x-anycast-profile'] = p;
  const c = hooks.caps();
  if (c) h['x-anycast-caps'] = c;
  return h;
}

export async function call<R extends Route>(route: R, opts: CallOpts<R> = {}): Promise<ResOf<R>> {
  const method = route.split(' ')[0]!;
  const url = buildPath(route, opts.params, opts.query as object | undefined);

  if (__DEMO_ALLOWED__ && isDemo()) {
    const { fakeFetch } = await import('../demo/fake');
    try {
      return (await fakeFetch(method, url, opts.body, opts.signal, hooks.profileId())) as ResOf<R>;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && route !== 'POST /api/auth/login') hooks.onUnauthorized();
      throw e;
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: requestHeaders(opts.body !== undefined),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      signal: opts.signal,
      keepalive: opts.keepalive,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, "Can't reach the AnyCast server. Check that it is running and that you are online.");
  }
  if (res.status === 401 && route !== 'POST /api/auth/login') hooks.onUnauthorized();
  if (!res.ok) {
    let body: unknown;
    let msg = `${res.status} ${res.statusText}`;
    try {
      body = await res.json();
      const m = (body as { message?: string; error?: string }).message ?? (body as { error?: string }).error;
      if (m) msg = m;
    } catch {
      /* not JSON */
    }
    if (res.status === 403 && (body as { error?: string } | undefined)?.error === 'profile') hooks.onProfileInvalid();
    throw new ApiError(res.status, msg, body);
  }
  if (res.status === 204) return undefined as unknown as ResOf<R>;
  return (await res.json()) as ResOf<R>;
}

/* ---------- tiny GET cache: dedupes in-flight requests, used for prefetch-on-hover ---------- */
const cache = new Map<string, { at: number; p: Promise<unknown> }>();

export function cachedGet<R extends Route>(route: R, opts: CallOpts<R> = {}, ttlMs = 30_000): Promise<ResOf<R>> {
  const key = buildPath(route, opts.params, opts.query as object | undefined) + '|' + (hooks.profileId() ?? '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<ResOf<R>>;
  const p = call(route, { ...opts, signal: undefined });
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

export function prefetch<R extends Route>(route: R, opts: CallOpts<R> = {}) {
  cachedGet(route, opts).catch(() => {});
}

export function clearApiCache(prefix?: string) {
  if (!prefix) return cache.clear();
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
