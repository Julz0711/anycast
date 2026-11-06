/**
 * In-memory fake of the AnyCast server contract for demo mode (dev only; lazy chunk).
 * Routes mirror `Api` in @anycast/shared. Writes emit SyncEvents to subscribers like the real SSE stream.
 */
import {
  ADULT_MODE_RANK, DEFAULT_PREFERENCES, FINISHED_THRESHOLD, LOCKED_NAME, mergePreferences, PIN_MAX_ATTEMPTS, PIN_WINDOW_MS,
  type AdultMode, type AdultStatus, type Category, type UnlockMinutes,
  type Channel, type ChannelList, type Favorite, type HideRules, type LiveChannelWithNow, type Me, type Movie, type PlaybackInfo,
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
  lists: ChannelList[];
  adult: { mode: AdultMode; pin: string | null; unlockMinutes: UnlockMinutes; unlockedUntil: number | null; failures: number[] };
}

/* ---------- parental lock: one adult group, locked with the demo PIN 1234 ---------- */
const ADULT_CAT: Category = { id: 'lcx', kind: 'live', name: 'XXX | Late Night', country: null, language: null, adult: true };
fx.liveCategories.push(ADULT_CAT);
['Velvet Room', 'Late Lounge', 'After Dark'].forEach((name, i) =>
  fx.channels.push({
    id: `ch${901 + i}`, name, rawName: `XXX | ${name}`, number: 901 + i, categoryId: ADULT_CAT.id, logo: null,
    country: null, language: null, archiveDays: 0, epgChannelId: null, hasEpg: false,
  }),
);
const isAdult = (categoryId: string) => categoryId === ADULT_CAT.id;
const unlocked = (st: ProfileState) => st.adult.mode === 'locked' && (st.adult.unlockedUntil ?? 0) > Date.now();
const lockedCat = (st: ProfileState, categoryId: string) => isAdult(categoryId) && st.adult.mode === 'locked' && !unlocked(st);
/** hide rules plus the hidden adult group (and locked ones for search) */
const rulesOf = (st: ProfileState, search = false): HideRules =>
  st.adult.mode === 'hidden' || (search && lockedCat(st, ADULT_CAT.id)) ? { ...st.rules, categoryIds: [...st.rules.categoryIds, ADULT_CAT.id] } : st.rules;
function mask<T extends { categoryId: string; name: string }>(st: ProfileState, x: T): T {
  if (!lockedCat(st, x.categoryId)) return x;
  const out = { ...x, name: LOCKED_NAME, rawName: LOCKED_NAME, locked: true } as Record<string, unknown>;
  if ('now' in out) out.now = out.now ? { ...(out.now as object), title: LOCKED_NAME, description: null } : null;
  if ('next' in out) out.next = out.next ? { ...(out.next as object), title: LOCKED_NAME, description: null } : null;
  return out as T;
}
function gate(st: ProfileState, categoryId: string) {
  if (!isAdult(categoryId) || st.adult.mode === 'shown' || unlocked(st)) return;
  const msg = st.adult.mode === 'locked' ? 'This is locked. Enter the PIN to open it.' : 'This is not available on this profile.';
  throw new ApiError(403, msg, { error: 'adult_locked', mode: st.adult.mode, message: msg });
}
function adultStatus(st: ProfileState): AdultStatus {
  const recent = st.adult.failures.filter((t) => t > Date.now() - PIN_WINDOW_MS);
  const attemptsLeft = Math.max(0, PIN_MAX_ATTEMPTS - recent.length);
  return {
    mode: st.adult.mode, hasPin: st.adult.pin !== null, unlockMinutes: st.adult.unlockMinutes, unlocked: unlocked(st),
    unlockedUntil: unlocked(st) ? st.adult.unlockedUntil : null, attemptsLeft,
    lockedOutUntil: attemptsLeft === 0 ? recent[recent.length - PIN_MAX_ATTEMPTS]! + PIN_WINDOW_MS : null,
  };
}
function pinErr(st: ProfileState, status: number, error: string, message: string): ApiError {
  const s = adultStatus(st);
  return new ApiError(status, message, { error, message, attemptsLeft: s.attemptsLeft, lockedOutUntil: s.lockedOutUntil });
}
function checkPin(st: ProfileState, pin: unknown) {
  if (!st.adult.pin) throw pinErr(st, 409, 'no_pin', 'Set a PIN first.');
  if (!pin) throw pinErr(st, 409, 'pin_required', 'Enter the PIN to change this.');
  if (adultStatus(st).lockedOutUntil) throw pinErr(st, 429, 'pin_locked_out', 'Too many wrong attempts.');
  if (pin !== st.adult.pin) {
    st.adult.failures.push(Date.now());
    const s = adultStatus(st);
    throw s.lockedOutUntil ? pinErr(st, 429, 'pin_locked_out', 'Too many wrong attempts.') : pinErr(st, 403, 'wrong_pin', `Wrong PIN. ${s.attemptsLeft} attempts left.`);
  }
  st.adult.failures = [];
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
      lists: [
        { id: 'l1', name: 'News', channelIds: [ch(131), ch(134), ch(132), ch(133), ch(136)] },
        { id: 'l2', name: 'Sport', channelIds: [ch(111), ch(113), ch(112), ch(115)] },
        { id: 'l3', name: 'Kids', channelIds: [ch(141), ch(143)] },
      ].filter(() => id === 'p1'),
      adult: { mode: 'locked', pin: '1234', unlockMinutes: 30, unlockedUntil: null, failures: [] },
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
  ['GET', /^\/api\/diagnostics$/, () => ({
    version: 'demo', uptimeSeconds: Math.round(performance.now() / 1000), node: 'demo', platform: 'browser',
    ffmpeg: { available: true, version: 'demo' }, ffprobe: { available: true, version: 'demo' }, hwEncoders: [],
    videoEncoder: {
      active: 'libx264', method: 'software', label: 'Software', reason: 'Hardware encoding is turned off.', setting: 'off', source: 'env', envSetting: 'off',
      probes: [], checkedAt: null, unhealthyUntil: null,
    },
    connections: { active: 0, max: 2, byKind: {} }, hlsSessions: 0,
    buffer: { enabled: true, bytes: 0, maxBytes: 20 * 1024 ** 3, recording: 0 }, thumbnails: { bytes: 0 },
  })],
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
  ['GET', /^\/api\/categories$/, (_m, q, _b, st) => {
    const k = q.get('kind');
    const list = k === 'movie' ? fx.movieCategories : k === 'series' ? fx.seriesCategories : fx.liveCategories;
    return list.filter((c) => !(c.adult && st.adult.mode === 'hidden')).map((c) => (lockedCat(st, c.id) ? { ...c, locked: true } : c));
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
    const withEpg = q.get('hasEpg') === '1';
    const items = fx.channels.filter((c) => !hidden(rulesOf(st), c) && (!cat || c.categoryId === cat) && (!withEpg || c.hasEpg));
    const p = page(items, q);
    return { total: p.total, items: p.items.map((c) => mask(st, withNow(c, now))) };
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
    const res = page(fx.movies.filter((x) => !hidden(rulesOf(st), x) && (!cat || x.categoryId === cat)), q);
    return { ...res, items: res.items.map((x) => mask(st, x)) };
  }],
  ['GET', /^\/api\/series$/, (_m, q, _b, st) => {
    const cat = q.get('categoryId');
    return page(fx.series.filter((x) => !hidden(rulesOf(st), x) && (!cat || x.categoryId === cat)), q);
  }],
  ['GET', /^\/api\/items$/, (_m, q, _b, st) => {
    const ids = (k: string) => (q.get(k) ?? '').split(',').filter(Boolean);
    const pick = <T extends { id: string }>(list: T[], k: string) =>
      ids(k).flatMap((id) => list.filter((x) => x.id === id && !hidden(rulesOf(st), x as unknown as Parameters<typeof hidden>[1])));
    const now = Date.now();
    return { live: pick(fx.channels, 'live').map((c) => mask(st, withNow(c, now))), movies: pick(fx.movies, 'movie').map((x) => mask(st, x)), series: pick(fx.series, 'series') };
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
      live: fx.channels.filter((c) => !hidden(rulesOf(st, true), c) && contains(c.name, s)).slice(0, 20),
      movies: fx.movies.filter((c) => !hidden(rulesOf(st, true), c) && contains(c.name, s)).slice(0, 30),
      series: fx.series.filter((c) => !hidden(rulesOf(st, true), c) && contains(c.name, s)).slice(0, 30),
    };
  }],
  ['GET', /^\/api\/play\/live\/([^/]+)$/, (m, _q, _b, st): PlaybackInfo => {
    gate(st, findChannel(m[1]!).categoryId);
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
  ['GET', /^\/api\/timeline\/([^/]+)$/, (m, _q, _b, st) => {
    const ch = findChannel(m[1]!);
    gate(st, ch.categoryId);
    return timeline(ch, Date.now());
  }],
  ['GET', /^\/api\/adult$/, (_m, _q, _b, st) => adultStatus(st)],
  ['POST', /^\/api\/adult\/unlock$/, (_m, _q, body, st) => {
    if (st.adult.mode !== 'locked') throw pinErr(st, 409, 'not_locked', 'Adult content is not locked on this profile.');
    checkPin(st, (body as { pin?: string }).pin);
    st.adult.unlockedUntil = Date.now() + st.adult.unlockMinutes * 60_000;
    return adultStatus(st);
  }],
  ['POST', /^\/api\/adult\/lock$/, (_m, _q, _b, st) => {
    st.adult.unlockedUntil = null;
    return adultStatus(st);
  }],
  ['PUT', /^\/api\/adult\/settings$/, (_m, _q, body, st) => {
    const b = body as { mode?: AdultMode; unlockMinutes?: UnlockMinutes; pin?: string };
    const mode = b.mode ?? st.adult.mode;
    const minutes = b.unlockMinutes ?? st.adult.unlockMinutes;
    const longer = minutes !== st.adult.unlockMinutes && st.adult.pin !== null && st.adult.mode !== 'shown';
    if (ADULT_MODE_RANK[mode] > ADULT_MODE_RANK[st.adult.mode] || longer || b.pin !== undefined) checkPin(st, b.pin);
    if (mode !== 'locked') st.adult.unlockedUntil = null;
    st.adult = { ...st.adult, mode, unlockMinutes: minutes };
    emit({ type: 'parental', profileId: currentPid });
    return adultStatus(st);
  }],
  ['PUT', /^\/api\/adult\/pin$/, (_m, _q, body, st) => {
    const b = body as { pin: string; currentPin?: string; password?: string };
    if (!/^\d{4,6}$/.test(b.pin)) throw pinErr(st, 400, 'bad_pin', 'The PIN is 4 to 6 digits.');
    if (b.password) {
      if (b.password !== 'demo') throw pinErr(st, 403, 'wrong_password', 'Wrong password. (Demo: "demo".)');
    } else if (st.adult.pin) checkPin(st, b.currentPin);
    else throw pinErr(st, 409, 'pin_required', 'Enter your account password to set the first PIN.');
    st.adult = { ...st.adult, pin: b.pin, unlockedUntil: null };
    emit({ type: 'parental', profileId: currentPid });
    return adultStatus(st);
  }],
  ['POST', /^\/api\/adult\/reset$/, (_m, _q, body) => {
    const t = state((body as { profileId: string }).profileId);
    t.adult = { ...t.adult, mode: 'hidden', pin: null, unlockedUntil: null, failures: [] };
    return { ok: true };
  }],
  // the demo has no provider connections to share
  ['POST', /^\/api\/play\/takeover$/, () => ({ ok: true, stopped: false })],
  ['POST', /^\/api\/play\/stop$/, () => ({ ok: true })],
  ['GET', /^\/api\/play\/movie\/([^/]+)$/, (m, _q, _b, st): PlaybackInfo => {
    const p = st.progress.get(`movie:${m[1]}`);
    return {
      url: clipUrl, type: 'file', pipeline: 'passthrough', resumeAt: p && !p.finished ? Math.min(p.position, CLIP_SECONDS - 20) : undefined,
      diagnostics: {
        source: 'movie', reason: 'Demo: a small WebM clip plays directly.', assumed: false,
        probe: { container: 'webm', duration: CLIP_SECONDS, video: { codec: 'vp8', width: 320, height: 180, fps: 12 }, audio: [], subtitles: [] },
      },
    };
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
  ['GET', /^\/api\/lists$/, (_m, _q, _b, st) => st.lists],
  ['POST', /^\/api\/lists$/, (_m, _q, body, st) => {
    const b = body as { name: string; channelIds?: string[] };
    const l: ChannelList = { id: `l${Date.now()}`, name: b.name.trim(), channelIds: [...new Set(b.channelIds ?? [])] };
    st.lists.push(l);
    emitLists(st);
    return l;
  }],
  ['PUT', /^\/api\/lists\/order$/, (_m, _q, body, st) => {
    const ids = (body as { ids: string[] }).ids;
    const named = ids.flatMap((id) => st.lists.filter((l) => l.id === id));
    st.lists = [...named, ...st.lists.filter((l) => !named.includes(l))];
    emitLists(st);
    return st.lists;
  }],
  ['PATCH', /^\/api\/lists\/([^/]+)$/, (m, _q, body, st) => {
    const l = findList(st, m[1]!);
    l.name = (body as { name: string }).name.trim();
    emitLists(st);
    return l;
  }],
  ['DELETE', /^\/api\/lists\/([^/]+)$/, (m, _q, _b, st) => {
    findList(st, m[1]!);
    st.lists = st.lists.filter((l) => l.id !== m[1]);
    emitLists(st);
    return { ok: true };
  }],
  ['PUT', /^\/api\/lists\/([^/]+)\/channels$/, (m, _q, body, st) => {
    const l = findList(st, m[1]!);
    l.channelIds = [...new Set((body as { channelIds: string[] }).channelIds)];
    emitLists(st);
    return l;
  }],
  // like the server, lists ignore hide rules
  ['GET', /^\/api\/lists\/([^/]+)\/channels$/, (m, _q, _b, st) => {
    const now = Date.now();
    return findList(st, m[1]!).channelIds.flatMap((id) => fx.channels.filter((c) => c.id === id)).map((c) => withNow(c, now));
  }],
  ['GET', /^\/api\/hide-rules$/, (_m, _q, _b, st) => st.rules],
  ['PUT', /^\/api\/hide-rules$/, (_m, _q, body, st) => {
    st.rules = body as HideRules;
    emit({ type: 'hide-rules', profileId: currentPid, rules: st.rules });
    return st.rules;
  }],
];

function findList(st: ProfileState, id: string) {
  const l = st.lists.find((x) => x.id === id);
  if (!l) throw new ApiError(404, 'List not found');
  return l;
}
const emitLists = (st: ProfileState) => emit({ type: 'lists', profileId: currentPid, lists: structuredClone(st.lists) });

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
