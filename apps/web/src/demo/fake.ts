/**
 * In-memory fake of the AnyCast server contract for demo mode (dev only; lazy chunk).
 * Routes mirror `Api` in @anycast/shared. Writes emit SyncEvents to subscribers like the real SSE stream.
 */
import {
  DEFAULT_PREFERENCES, FINISHED_THRESHOLD, mergePreferences,
  type Channel, type Favorite, type HideRules, type LiveChannelWithNow, type Me, type Movie, type PlaybackInfo,
  type Preferences, type Profile, type Progress, type Series, type SourceStatus, type SyncEvent, type TagSummary, type TimelineInfo,
} from '@anycast/shared';
import { ApiError } from '../api/client';
import { buildFixtures } from './fixtures';
import clipUrl from './clip.webm?url';

const fx = buildFixtures();
const CLIP_SECONDS = 90;

interface ProfileState {
  favorites: Favorite[];
  progress: Map<string, Progress>;
  prefs: Preferences;
  rules: HideRules;
}

let signedIn = true;
const profiles: Profile[] = [
  { id: 'p1', name: 'Julz' },
  { id: 'p2', name: 'Sam' },
];
const me = (): Me => ({ user: { id: 'u1', username: 'julz', isAdmin: true }, profiles: [...profiles] });

const states = new Map<string, ProfileState>();
function state(pid: string | null): ProfileState {
  const id = pid ?? profiles[0]!.id;
  let s = states.get(id);
  if (!s) {
    const now = Date.now();
    const ch = (n: number) => `ch${n}`;
    s = {
      favorites: [
        ...[ch(101), ch(111), ch(121), ch(131)].map((cid, i) => ({ kind: 'live' as const, id: cid, addedAt: now - i * 1000 })),
        ...['m3', 'm105', 'm207', 'm12', 'm340'].map((m, i) => ({ kind: 'movie' as const, id: m, addedAt: now - i * 1000 })),
        ...['s1', 's102', 's5'].map((x, i) => ({ kind: 'series' as const, id: x, addedAt: now - i * 1000 })),
      ],
      progress: new Map(),
      prefs: mergePreferences(loadSession(`prefs.${id}`) ?? DEFAULT_PREFERENCES),
      rules: { countries: [], languages: ['tr', 'ar'], categoryIds: [] },
    };
    const seed: Progress[] = [
      { kind: 'movie', id: 'm1', position: 4360, duration: 7080, finished: false, updatedAt: now - 3600_000 },
      { kind: 'movie', id: 'm104', position: 5100, duration: 6600, finished: false, updatedAt: now - 7200_000 },
      { kind: 'movie', id: 'm203', position: 1080, duration: 6240, finished: false, updatedAt: now - 86400_000 },
      { kind: 'episode', id: 's1e1x3', seriesId: 's1', position: 1300, duration: 2700, finished: false, updatedAt: now - 1800_000 },
      { kind: 'episode', id: 's1e1x1', seriesId: 's1', position: 2700, duration: 2700, finished: true, updatedAt: now - 9800_000 },
      { kind: 'episode', id: 's1e1x2', seriesId: 's1', position: 2650, duration: 2700, finished: true, updatedAt: now - 9000_000 },
      { kind: 'episode', id: 's102e1x2', seriesId: 's102', position: 600, duration: 2580, finished: false, updatedAt: now - 5400_000 },
    ];
    for (const p of seed) s.progress.set(`${p.kind}:${p.id}`, p);
    states.set(id, s);
  }
  return s;
}

/** Demo preferences survive reloads within the tab (handy for screenshots). */
function loadSession(key: string): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(`anycast.demo.${key}`) ?? 'null');
  } catch {
    return null;
  }
}
function saveSession(key: string, v: unknown) {
  try {
    sessionStorage.setItem(`anycast.demo.${key}`, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const listeners = new Set<(e: SyncEvent) => void>();
export function subscribeFake(cb: (e: SyncEvent) => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const emit = (e: SyncEvent) => setTimeout(() => listeners.forEach((l) => l(e)), 30);

/* ---------- helpers ---------- */
function hidden(rules: HideRules, x: { country: string | null; language: string | null; categoryId: string }) {
  return (
    (x.country !== null && rules.countries.includes(x.country)) ||
    (x.language !== null && rules.languages.includes(x.language)) ||
    rules.categoryIds.includes(x.categoryId)
  );
}
function page<T>(items: T[], q: URLSearchParams) {
  const offset = Number(q.get('offset') ?? 0);
  const limit = Number(q.get('limit') ?? 100);
  return { items: items.slice(offset, offset + limit), total: items.length };
}
function withNow(ch: Channel, now: number): LiveChannelWithNow {
  const progs = fx.epgFor(ch);
  const i = progs.findIndex((p) => p.start <= now && p.end > now);
  return { ...ch, now: progs[i] ?? null, next: progs[i + 1] ?? null };
}
const findChannel = (id: string) => {
  const c = fx.channels.find((x) => x.id === id);
  if (!c) throw new ApiError(404, 'Channel not found');
  return c;
};
function timeline(ch: Channel, now: number): TimelineInfo {
  const programs = fx.epgFor(ch).filter((p) => p.end > now - Math.max(ch.archiveDays, 0.25) * 86_400_000 && p.start < now + 3 * 3600_000);
  if (ch.archiveDays > 0) {
    const start = now - ch.archiveDays * 86_400_000;
    // a realistic hole in the provider archive, 5 h ago
    const gapStart = now - 5 * 3600_000;
    const gapEnd = gapStart + 20 * 60_000;
    return {
      channelId: ch.id,
      now,
      ranges: [
        { start, end: gapStart, source: 'archive' },
        { start: gapEnd, end: now - 120_000, source: 'archive' },
        { start: now - 120_000, end: now, source: 'live' },
      ],
      gaps: [{ start: gapStart, end: gapEnd, reason: 'Not recorded', cause: { code: 'not_recorded' } }],
      programs,
    };
  }
  const bufStart = now - 25 * 60_000;
  return {
    channelId: ch.id,
    now,
    ranges: [
      { start: bufStart, end: now - 60_000, source: 'buffer' },
      { start: now - 60_000, end: now, source: 'live' },
    ],
    gaps: [{ start: now - 6 * 3600_000, end: bufStart, reason: 'This channel has no archive', cause: { code: 'no_archive', at: bufStart } }],
    programs,
  };
}
function contains(hay: string, needle: string) {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

/* ---------- router ---------- */
type Handler = (m: RegExpExecArray, q: URLSearchParams, body: unknown, st: ProfileState) => unknown;
const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, version: 'demo' })],
  ['POST', /^\/api\/auth\/login$/, (_m, _q, body) => {
    const b = body as { username: string; password: string };
    if (!b.username || b.password !== 'demo') throw new ApiError(401, 'Wrong username or password. (Demo: any name, password "demo".)');
    signedIn = true;
    return me();
  }],
  ['POST', /^\/api\/auth\/logout$/, () => {
    signedIn = false;
    return { ok: true };
  }],
  ['GET', /^\/api\/me$/, () => me()],
  ['GET', /^\/api\/profiles$/, () => [...profiles]],
  ['POST', /^\/api\/profiles$/, (_m, _q, body) => {
    const p = { id: `p${Date.now()}`, name: (body as { name: string }).name };
    profiles.push(p);
    return p;
  }],
  ['PATCH', /^\/api\/profiles\/([^/]+)$/, (m, _q, body) => {
    const p = profiles.find((x) => x.id === m[1]);
    if (!p) throw new ApiError(404, 'Profile not found');
    p.name = (body as { name: string }).name;
    return p;
  }],
  ['DELETE', /^\/api\/profiles\/([^/]+)$/, (m) => {
    if (profiles.length <= 1) throw new ApiError(400, 'You cannot delete the last profile.');
    const i = profiles.findIndex((x) => x.id === m[1]);
    if (i >= 0) profiles.splice(i, 1);
    return { ok: true };
  }],
  ['GET', /^\/api\/source$/, (): SourceStatus => ({
    configured: true,
    account: { status: 'Active', expiresAt: Date.now() + 142 * 86_400_000, maxConnections: 2, activeConnections: 1 },
    lastSync: { catalog: Date.now() - 3 * 3600_000, epg: Date.now() - 40 * 60_000 },
    syncing: syncingUntil > Date.now(),
    counts: { live: fx.channels.length, movie: fx.movies.length, series: fx.series.length },
  })],
  ['POST', /^\/api\/source\/sync$/, () => {
    syncingUntil = Date.now() + 4000;
    setTimeout(() => emit({ type: 'catalog-updated' }), 4000);
    return { ok: true };
  }],
  ['GET', /^\/api\/categories$/, (_m, q) => {
    const k = q.get('kind');
    return k === 'movie' ? fx.movieCategories : k === 'series' ? fx.seriesCategories : fx.liveCategories;
  }],
  ['GET', /^\/api\/tags$/, () => {
    const all = [...fx.channels, ...fx.movies, ...fx.series];
    const count = (key: 'country' | 'language') => {
      const m = new Map<string | null, number>();
      for (const x of all) m.set(x[key], (m.get(x[key]) ?? 0) + 1);
      return [...m.entries()].map(([v, c]): TagSummary => ({ country: key === 'country' ? v : null, language: key === 'language' ? v : null, count: c })).sort((a, b) => b.count - a.count);
    };
    return { countries: count('country'), languages: count('language') };
  }],
  ['GET', /^\/api\/live$/, (_m, q, _b, st) => {
    const now = Date.now();
    const cat = q.get('categoryId');
    const items = fx.channels.filter((c) => !hidden(st.rules, c) && (!cat || c.categoryId === cat));
    const p = page(items, q);
    return { total: p.total, items: p.items.map((c) => withNow(c, now)) };
  }],
  ['GET', /^\/api\/epg$/, (_m, q) => {
    const ids = (q.get('channelIds') ?? '').split(',').filter(Boolean);
    const from = Number(q.get('from'));
    const to = Number(q.get('to'));
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const ch = fx.channels.find((c) => c.id === id);
      if (ch) out[id] = fx.epgFor(ch).filter((p) => p.end > from && p.start < to);
    }
    return out;
  }],
  ['GET', /^\/api\/movies$/, (_m, q, _b, st) => {
    const cat = q.get('categoryId');
    return page(fx.movies.filter((x) => !hidden(st.rules, x) && (!cat || x.categoryId === cat)), q);
  }],
  ['GET', /^\/api\/series$/, (_m, q, _b, st) => {
    const cat = q.get('categoryId');
    return page(fx.series.filter((x) => !hidden(st.rules, x) && (!cat || x.categoryId === cat)), q);
  }],
  ['GET', /^\/api\/items$/, (_m, q, _b, st) => {
    const ids = (k: string) => (q.get(k) ?? '').split(',').filter(Boolean);
    const pick = <T extends { id: string }>(list: T[], k: string) =>
      ids(k).flatMap((id) => list.filter((x) => x.id === id && !hidden(st.rules, x as unknown as Parameters<typeof hidden>[1])));
    const now = Date.now();
    return { live: pick(fx.channels, 'live').map((c) => withNow(c, now)), movies: pick(fx.movies, 'movie'), series: pick(fx.series, 'series') };
  }],
  ['GET', /^\/api\/buffer\/pins$/, () => ({ channelIds: [...pins], maxPins: 1 })],
  ['PUT', /^\/api\/buffer\/pins$/, (_m, _q, body) => {
    const b = body as { channelId: string; pinned: boolean };
    if (b.pinned && !pins.has(b.channelId) && pins.size >= 1) {
      throw new ApiError(409, 'You can pin at most 1 channel: your subscription allows 2 provider connections and one stays free for watching. Unpin a channel first.', { error: 'pin_limit' });
    }
    if (b.pinned) pins.add(b.channelId);
    else pins.delete(b.channelId);
    return { channelIds: [...pins], maxPins: 1 };
  }],
  ['GET', /^\/api\/buffer\/status$/, () => {
    const now = Date.now();
    return {
      enabled: true,
      totalBytes: pins.size * 420e6,
      caps: { maxHoursPerChannel: 2, maxBytes: 20 * 1024 ** 3, maxPins: 1 },
      channels: [...pins].map((id) => ({
        channelId: id, name: fx.channels.find((c) => c.id === id)?.name ?? null, pinned: true, recording: true,
        ranges: [{ start: now - 5400_000, end: now }], durationMs: 5400_000, bytes: 420e6,
      })),
    };
  }],
  ['GET', /^\/api\/series\/([^/]+)$/, (m) => {
    const d = fx.seriesDetail(m[1]!);
    if (!d) throw new ApiError(404, 'Series not found');
    return d;
  }],
  ['GET', /^\/api\/search$/, (_m, q, _b, st) => {
    const s = (q.get('q') ?? '').trim();
    if (!s) return { live: [], movies: [], series: [] };
    return {
      live: fx.channels.filter((c) => !hidden(st.rules, c) && contains(c.name, s)).slice(0, 20),
      movies: fx.movies.filter((c) => !hidden(st.rules, c) && contains(c.name, s)).slice(0, 30),
      series: fx.series.filter((c) => !hidden(st.rules, c) && contains(c.name, s)).slice(0, 30),
    };
  }],
  ['GET', /^\/api\/play\/live\/([^/]+)$/, (m): PlaybackInfo => {
    findChannel(m[1]!);
    return { url: clipUrl, type: 'file', pipeline: 'passthrough', startsAt: Date.now() };
  }],
  ['GET', /^\/api\/play\/live\/([^/]+)\/at$/, (m, q): PlaybackInfo => {
    const ch = findChannel(m[1]!);
    const at = Number(q.get('at'));
    const tl = timeline(ch, Date.now());
    if (!tl.ranges.some((r) => at >= r.start && at <= r.end)) {
      const gap = tl.gaps.find((g) => at >= g.start && at < g.end);
      const cause = gap?.cause ?? { code: 'not_recorded' as const };
      throw new ApiError(422, gap?.reason ?? 'Not recorded', { error: 'gap', message: gap?.reason, cause });
    }
    return { url: clipUrl, type: 'file', pipeline: 'passthrough', startsAt: at };
  }],
  ['GET', /^\/api\/timeline\/([^/]+)$/, (m) => timeline(findChannel(m[1]!), Date.now())],
  ['GET', /^\/api\/play\/movie\/([^/]+)$/, (m, _q, _b, st): PlaybackInfo => {
    const p = st.progress.get(`movie:${m[1]}`);
    return { url: clipUrl, type: 'file', pipeline: 'passthrough', resumeAt: p && !p.finished ? Math.min(p.position, CLIP_SECONDS - 20) : undefined };
  }],
  ['GET', /^\/api\/play\/episode\/([^/]+)$/, (m, _q, _b, st): PlaybackInfo => {
    const p = st.progress.get(`episode:${m[1]}`);
    return {
      url: clipUrl, type: 'file', pipeline: 'remux', resumeAt: p && !p.finished ? Math.min(p.position, CLIP_SECONDS - 20) : undefined,
      seriesId: /^(s\d+)e/.exec(m[1]!)?.[1],
    };
  }],
  ['GET', /^\/api\/favorites$/, (_m, _q, _b, st) => st.favorites],
  ['PUT', /^\/api\/favorites$/, (_m, _q, body, st) => {
    const b = body as { kind: Favorite['kind']; id: string; favorite: boolean };
    st.favorites = st.favorites.filter((f) => !(f.kind === b.kind && f.id === b.id));
    if (b.favorite) st.favorites.push({ kind: b.kind, id: b.id, addedAt: Date.now() });
    emit({ type: 'favorites', profileId: currentPid, favorites: st.favorites });
    return st.favorites;
  }],
  ['GET', /^\/api\/progress$/, (_m, _q, _b, st) => [...st.progress.values()]],
  ['PUT', /^\/api\/progress$/, (_m, _q, body, st) => {
    const b = body as Omit<Progress, 'updatedAt' | 'finished'>;
    const p: Progress = { ...b, finished: b.duration > 0 && b.position / b.duration > FINISHED_THRESHOLD, updatedAt: Date.now() };
    st.progress.set(`${p.kind}:${p.id}`, p);
    emit({ type: 'progress', profileId: currentPid, progress: p });
    return p;
  }],
  ['GET', /^\/api\/continue$/, (_m, _q, _b, st) => {
    const ps = [...st.progress.values()].filter((p) => !p.finished).sort((a, b) => b.updatedAt - a.updatedAt);
    const movies = ps.filter((p) => p.kind === 'movie').flatMap((p) => {
      const mv = fx.movies.find((x) => x.id === p.id);
      return mv ? [{ ...(mv as Movie), progress: p }] : [];
    });
    const episodes = ps.filter((p) => p.kind === 'episode').flatMap((p) => {
      const d = p.seriesId ? fx.seriesDetail(p.seriesId) : null;
      const ep = d?.seasons.flatMap((s) => s.episodes).find((e) => e.id === p.id);
      if (!d || !ep) return [];
      const { seasons: _s, ...series } = d;
      return [{ ...ep, progress: p, series: series as Series }];
    });
    return { movies, episodes };
  }],
  ['GET', /^\/api\/preferences$/, (_m, _q, _b, st) => st.prefs],
  ['PUT', /^\/api\/preferences$/, (_m, _q, body, st) => {
    st.prefs = mergePreferences({ ...st.prefs, ...(body as object) });
    saveSession(`prefs.${currentPid}`, st.prefs);
    emit({ type: 'preferences', profileId: currentPid, preferences: st.prefs });
    return st.prefs;
  }],
  ['GET', /^\/api\/hide-rules$/, (_m, _q, _b, st) => st.rules],
  ['PUT', /^\/api\/hide-rules$/, (_m, _q, body, st) => {
    st.rules = body as HideRules;
    emit({ type: 'hide-rules', profileId: currentPid, rules: st.rules });
    return st.rules;
  }],
];

let syncingUntil = 0;
const pins = new Set<string>();
let currentPid = 'p1';

export async function fakeFetch(method: string, url: string, body: unknown, signal: AbortSignal | undefined, profileId: string | null) {
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 140));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const u = new URL(url, 'http://demo.local');
  if (!signedIn && !['/api/auth/login', '/api/health'].includes(u.pathname)) throw new ApiError(401, 'Not signed in');
  currentPid = profileId ?? profiles[0]!.id;
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = re.exec(u.pathname);
    if (match) return structuredClone(h(match, u.searchParams, body, state(currentPid)));
  }
  throw new ApiError(404, `Demo: no route for ${method} ${u.pathname}`);
}
