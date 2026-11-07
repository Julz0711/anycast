/**
 * In-memory fake of the AnyCast server contract for demo mode (dev only; lazy chunk).
 * Routes mirror `Api` in @anycast/shared. Writes emit SyncEvents to subscribers like the real SSE stream.
 */
import {
  ADULT_MODE_RANK, BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, DEFAULT_PREFERENCES, FINISHED_THRESHOLD, LOCKED_NAME, mergePreferences, PIN_MAX_ATTEMPTS, summarizeBackup, PIN_WINDOW_MS,
  defaultAvatar, type AdultMode, type AdultStatus, type BackupFile, type Category, type RestoreMode, type UnlockMinutes,
  type Channel, type ChannelList, type Favorite, type MediaList, type HideRules, type LiveChannelWithNow, type Me, type Movie, type PlaybackInfo,
  type Preferences, type Profile, type Progress, type RecentChannel, RECENT_CHANNELS_MAX, type Series, type SourceStatus, type SyncEvent, type TagSummary, type TimelineInfo,
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
  mediaLists: MediaList[];
  recent: RecentChannel[];
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
  { id: 'p1', name: 'Julz', avatar: 'orbit.amber', image: null, locked: false, needsPin: false },
  { id: 'p2', name: 'Sam', avatar: 'wave.sky', image: null, locked: false, needsPin: false },
  { id: 'p3', name: 'Kids', avatar: 'bloom.mint', image: null, locked: false, needsPin: false },
];
/** demo profile locks: PIN per profile id, and the ones opened in this tab */
const profilePins = new Map<string, string>([['p2', '1234']]);
const entered = new Set<string>(['p1', 'p3']);
const view = (p: Profile): Profile => ({ ...p, locked: profilePins.has(p.id), needsPin: profilePins.has(p.id) && !entered.has(p.id) });
const findProfile = (id: string | undefined) => {
  const p = profiles.find((x) => x.id === id);
  if (!p) throw new ApiError(404, 'Profile not found');
  return p;
};
const me = (): Me => ({ user: { id: 'u1', username: 'julz', isAdmin: true }, profiles: profiles.map(view) });

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
      mediaLists: [
        {
          id: `wl-${id}`, name: 'Watch Later', builtin: 'watch-later' as const,
          items: id === 'p1' ? [{ kind: 'movie' as const, id: 'm21', addedAt: now }, { kind: 'series' as const, id: 's8', addedAt: now }, { kind: 'movie' as const, id: 'm5', addedAt: now }] : [],
        },
        ...(id === 'p1' ? [{ id: 'ml1', name: 'Date night', builtin: null, items: [{ kind: 'movie' as const, id: 'm7', addedAt: now }, { kind: 'movie' as const, id: 'm108', addedAt: now }] }] : []),
      ],
      recent: id === 'p1' ? [ch(104), ch(131), ch(112), ch(121), ch(107), ch(141)].map((cid, i) => ({ id: cid, watchedAt: now - (i + 1) * 2_400_000 })) : [],
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
      // finished: Up next shows the episode after it
      { kind: 'episode', id: 's5e1x4', seriesId: 's5', position: 2580, duration: 2600, finished: true, updatedAt: now - 20_000_000 },
      { kind: 'episode', id: 's8e1x1', seriesId: 's8', position: 2500, duration: 2550, finished: true, updatedAt: now - 90_000_000 },
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
/** Sort and filters of GET /api/movies and /api/series (VodQuery). */
function vodView<T extends { name: string; year: number | null; rating: number | null }>(list: T[], q: URLSearchParams): T[] {
  const from = Number(q.get('yearFrom') ?? 0);
  const to = Number(q.get('yearTo') ?? 0);
  const min = Number(q.get('minRating') ?? 0);
  const out = list.filter((x) => (!from || (x.year ?? 0) >= from) && (!to || (x.year !== null && x.year <= to)) && (!min || (x.rating ?? 0) >= min));
  const sort = q.get('sort');
  if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'year') out.sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
  else if (sort === 'rating') out.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  return out;
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
  ['GET', /^\/api\/admin\/backup$/, () => demoBackup()],
  ['GET', /^\/api\/admin\/backups$/, () => ({ keep: 7, files: demoAutoBackups() })],
  ['GET', /^\/api\/admin\/backups\/([^/]+)$/, () => demoBackup()],
  ['POST', /^\/api\/admin\/restore$/, (_m, _q, body) => demoRestore(body as Parameters<typeof demoRestore>[0])],
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
  ['GET', /^\/api\/profiles$/, () => profiles.map(view)],
  ['POST', /^\/api\/profiles$/, (_m, _q, body) => {
    const b = body as { name: string; avatar?: string | null };
    const p: Profile = { id: `p${Date.now()}`, name: b.name, avatar: b.avatar === undefined ? defaultAvatar(profiles.length) : b.avatar, image: null, locked: false, needsPin: false };
    profiles.push(p);
    return view(p);
  }],
  ['POST', /^\/api\/profiles\/leave$/, (_m, _q, body) => {
    const keep = (body as { keep?: string } | undefined)?.keep;
    for (const id of [...entered]) if (id !== keep && profilePins.has(id)) entered.delete(id);
    return { ok: true };
  }],
  ['POST', /^\/api\/profiles\/([^/]+)\/enter$/, (m, _q, body) => {
    const p = findProfile(m[1]);
    const pin = (body as { pin?: string } | undefined)?.pin;
    if (profilePins.has(p.id) && (pin || !entered.has(p.id))) {
      if (pin !== profilePins.get(p.id)) throw new ApiError(403, 'Wrong PIN. The demo PIN is 1234.', { error: 'wrong_pin', message: 'Wrong PIN. The demo PIN is 1234.', attemptsLeft: 4, lockedOutUntil: null });
      entered.add(p.id);
    }
    return view(p);
  }],
  ['PUT', /^\/api\/profiles\/([^/]+)\/lock$/, (m, _q, body) => {
    const p = findProfile(m[1]);
    const b = body as { pin: string | null; currentPin?: string; password?: string };
    if (profilePins.has(p.id) && !b.password && b.currentPin !== profilePins.get(p.id)) {
      throw new ApiError(403, 'Wrong PIN.', { error: 'wrong_pin', message: 'Wrong PIN.', attemptsLeft: 4, lockedOutUntil: null });
    }
    if (b.pin === null) profilePins.delete(p.id);
    else profilePins.set(p.id, b.pin);
    entered.add(p.id);
    return view(p);
  }],
  ['PUT', /^\/api\/profiles\/([^/]+)\/image$/, (m, _q, body) => {
    const p = findProfile(m[1]);
    const b = body as { type: string; data: string };
    p.image = `data:${b.type};base64,${b.data}`;
    return view(p);
  }],
  ['DELETE', /^\/api\/profiles\/([^/]+)\/image$/, (m) => {
    const p = findProfile(m[1]);
    p.image = null;
    return view(p);
  }],
  ['PATCH', /^\/api\/profiles\/([^/]+)$/, (m, _q, body) => {
    const p = findProfile(m[1]);
    const b = body as { name?: string; avatar?: string | null };
    if (b.name !== undefined) p.name = b.name;
    if (b.avatar !== undefined) {
      p.avatar = b.avatar;
      p.image = null;
    }
    return view(p);
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
  ['GET', /^\/api\/channels\/([^/]+)\/variants$/, (m, _q, _b, st) => [mask(st, withNow(findChannel(decodeURIComponent(m[1]!)), Date.now()))]],
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
    const res = page(vodView(fx.movies.filter((x) => !hidden(rulesOf(st), x) && (!cat || x.categoryId === cat)), q), q);
    return { ...res, items: res.items.map((x) => mask(st, x)) };
  }],
  ['GET', /^\/api\/movies\/([^/]+)$/, (m, _q, _b, st) => {
    const mv = fx.movies.find((x) => x.id === decodeURIComponent(m[1]!));
    if (!mv) throw new ApiError(404, 'Movie not found');
    return mask(st, { ...mv, genre: 'Drama, Mystery', cast: 'Ada Brooks, Sam Okafor, Lena Varga', director: 'Mira Holt', releaseDate: mv.year ? `${mv.year}-03-14` : null, backdrop: null, trailer: null });
  }],
  ['GET', /^\/api\/new-episodes$/, () => []],
  ['PUT', /^\/api\/series\/[^/]+\/seen$/, () => ({ ok: true })],
  ['GET', /^\/api\/series$/, (_m, q, _b, st) => {
    const cat = q.get('categoryId');
    return page(vodView(fx.series.filter((x) => !hidden(rulesOf(st), x) && (!cat || x.categoryId === cat)), q), q);
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
    const all = [...st.progress.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const movies = all.filter((p) => p.kind === 'movie' && !p.finished && p.position > 0).flatMap((p) => {
      const mv = fx.movies.find((x) => x.id === p.id);
      return mv ? [{ ...(mv as Movie), progress: p }] : [];
    });
    // like the server: per series its latest episode; finished -> the next one, as "up next" (position 0)
    const latest = new Map<string, Progress>();
    for (const p of all) if (p.kind === 'episode' && p.seriesId && !latest.has(p.seriesId)) latest.set(p.seriesId, p);
    const episodes = [...latest.values()].flatMap((p) => {
      const d = fx.seriesDetail(p.seriesId!);
      if (!d) return [];
      const eps = d.seasons.flatMap((s) => s.episodes);
      const idx = eps.findIndex((e) => e.id === p.id);
      if (idx < 0) return [];
      const { seasons: _s, ...series } = d;
      if (!p.finished) return [{ ...eps[idx]!, progress: p, series: series as Series }];
      const next = eps.slice(idx + 1).find((e) => !st.progress.get(`episode:${e.id}`)?.finished);
      if (!next) return [];
      const progress: Progress = st.progress.get(`episode:${next.id}`) ?? { kind: 'episode', id: next.id, seriesId: d.id, position: 0, duration: next.duration ?? 0, finished: false, updatedAt: p.updatedAt };
      return [{ ...next, progress, series: series as Series }];
    });
    return { movies, episodes };
  }],
  ['GET', /^\/api\/recent-channels$/, (_m, _q, _b, st) => st.recent],
  ['PUT', /^\/api\/recent-channels$/, (_m, _q, body, st) => {
    const id = (body as { channelId: string }).channelId;
    st.recent = [{ id, watchedAt: Date.now() }, ...st.recent.filter((r) => r.id !== id)].slice(0, RECENT_CHANNELS_MAX);
    emit({ type: 'recent-channels', profileId: currentPid, recent: structuredClone(st.recent) });
    return st.recent;
  }],
  ['DELETE', /^\/api\/recent-channels(?:\/([^/]+))?$/, (_m, _q, _b, st) => {
    const id = _m[1];
    st.recent = id ? st.recent.filter((r) => r.id !== decodeURIComponent(id)) : [];
    emit({ type: 'recent-channels', profileId: currentPid, recent: structuredClone(st.recent) });
    return st.recent;
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
  ['GET', /^\/api\/media-lists$/, (_m, _q, _b, st) => st.mediaLists],
  ['POST', /^\/api\/media-lists$/, (_m, _q, body, st) => {
    const b = body as { name: string; items?: { kind: 'movie' | 'series'; id: string }[] };
    const now = Date.now();
    const l: MediaList = { id: `ml${now}`, name: b.name.trim(), builtin: null, items: (b.items ?? []).map((x) => ({ ...x, addedAt: now })) };
    st.mediaLists.push(l);
    emitMediaLists(st);
    return l;
  }],
  ['PUT', /^\/api\/media-lists\/order$/, (_m, _q, body, st) => {
    const ids = (body as { ids: string[] }).ids;
    const own = st.mediaLists.filter((l) => !l.builtin);
    const named = ids.flatMap((id) => own.filter((l) => l.id === id));
    st.mediaLists = [...st.mediaLists.filter((l) => l.builtin), ...named, ...own.filter((l) => !named.includes(l))];
    emitMediaLists(st);
    return st.mediaLists;
  }],
  ['PATCH', /^\/api\/media-lists\/([^/]+)$/, (m, _q, body, st) => {
    const l = findMediaList(st, m[1]!, true);
    l.name = (body as { name: string }).name.trim();
    emitMediaLists(st);
    return l;
  }],
  ['DELETE', /^\/api\/media-lists\/([^/]+)$/, (m, _q, _b, st) => {
    findMediaList(st, m[1]!, true);
    st.mediaLists = st.mediaLists.filter((l) => l.id !== m[1]);
    emitMediaLists(st);
    return { ok: true };
  }],
  ['PUT', /^\/api\/media-lists\/([^/]+)\/items$/, (m, _q, body, st) => {
    const l = findMediaList(st, m[1]!, false);
    const before = new Map(l.items.map((x) => [`${x.kind}:${x.id}`, x.addedAt]));
    const seen = new Set<string>();
    l.items = (body as { items: { kind: 'movie' | 'series'; id: string }[] }).items
      .filter((x) => !seen.has(`${x.kind}:${x.id}`) && !!seen.add(`${x.kind}:${x.id}`))
      .map((x) => ({ kind: x.kind, id: x.id, addedAt: before.get(`${x.kind}:${x.id}`) ?? Date.now() }));
    emitMediaLists(st);
    return l;
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
function findMediaList(st: ProfileState, id: string, own: boolean) {
  const l = st.mediaLists.find((x) => x.id === id);
  if (!l) throw new ApiError(404, 'List not found');
  if (own && l.builtin) throw new ApiError(409, "Watch Later can't be renamed or deleted.");
  return l;
}
/* ---------- backup & restore: the demo's own state as a backup file ---------- */
function demoBackup(): BackupFile {
  const user = me().user;
  return {
    format: BACKUP_FORMAT, schemaVersion: BACKUP_SCHEMA_VERSION, appVersion: 'demo', createdAt: Date.now(),
    users: [{
      id: user.id, username: user.username, passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$demo$demo', isAdmin: true, createdAt: 0,
      profiles: profiles.map((p, i) => {
        const st = state(p.id);
        return {
          id: p.id, name: p.name, createdAt: i, preferences: { ...st.prefs }, hideRules: st.rules,
          parental: { mode: st.adult.mode, unlockMinutes: st.adult.unlockMinutes, pinHash: st.adult.pin ? '$argon2id$v=19$m=19456,t=2,p=1$demo$pin' : null, updatedAt: 0 },
          favorites: st.favorites,
          progress: [...st.progress.values()].map((x) => ({ kind: x.kind, id: x.id, seriesId: x.seriesId ?? null, position: x.position, duration: x.duration, finished: x.finished, updatedAt: x.updatedAt })),
          trackChoices: [],
          lists: st.lists.map((l, position) => ({ ...l, position, createdAt: position })),
          mediaLists: st.mediaLists.map((l, position) => ({ ...l, position: l.builtin ? -1 : position, createdAt: position })),
        };
      }),
    }],
    pinnedChannels: [...pins].map((channelId) => ({ channelId, pinnedAt: 0 })),
  };
}
const day = (n: number) => new Date(Date.now() - n * 86_400_000);
const demoAutoBackups = () => [0, 1, 2].map((n) => ({ name: `anycast-backup-${day(n).toISOString().slice(0, 10)}.json`, bytes: 48_000 + n * 900, createdAt: day(n).setUTCHours(3, 0, 0, 0) }));

function demoRestore(body: { backup: BackupFile; mode?: RestoreMode; password: string }) {
  if (body.password !== 'demo') throw new ApiError(403, 'Wrong password. (Demo: "demo".)', { error: 'wrong_password' });
  const b = body.backup;
  if (b?.format !== BACKUP_FORMAT || !Array.isArray(b.users)) throw new ApiError(400, 'This is not an AnyCast backup file.', { error: 'bad_backup' });
  const merge = body.mode === 'merge';
  for (const bp of b.users.flatMap((u) => u.profiles)) {
    // the demo has fixed profiles: data of profiles it doesn't know is skipped
    if (!profiles.some((p) => p.id === bp.id)) continue;
    const st = state(bp.id);
    const has = (kind: string, id: string) => st.favorites.some((f) => f.kind === kind && f.id === id);
    st.favorites = merge ? [...st.favorites, ...bp.favorites.filter((f) => !has(f.kind, f.id))] : [...bp.favorites];
    if (!merge) st.progress.clear();
    for (const x of bp.progress) {
      const key = `${x.kind}:${x.id}`;
      if (!merge || !st.progress.has(key)) st.progress.set(key, { kind: x.kind, id: x.id, position: x.position, duration: x.duration, finished: x.finished, updatedAt: x.updatedAt, ...(x.seriesId ? { seriesId: x.seriesId } : {}) });
    }
    if (!merge && bp.preferences) st.prefs = mergePreferences(bp.preferences);
    if (!merge && bp.hideRules) st.rules = bp.hideRules;
    const lists = bp.lists.map((l) => ({ id: l.id, name: l.name, channelIds: l.channelIds }));
    st.lists = merge ? [...st.lists, ...lists.filter((l) => !st.lists.some((x) => x.id === l.id))] : lists;
    const media = (bp.mediaLists ?? []).filter((l) => !l.builtin).map((l) => ({ id: l.id, name: l.name, builtin: null, items: l.items }));
    st.mediaLists = [st.mediaLists[0]!, ...(merge ? [...st.mediaLists.slice(1), ...media.filter((l) => !st.mediaLists.some((x) => x.id === l.id))] : media)];
    emit({ type: 'restored', profileId: bp.id });
  }
  return { ok: true, mode: body.mode ?? 'replace', summary: summarizeBackup(b), keptCurrentAccount: false, safetyBackup: demoAutoBackups()[0]!.name };
}

const emitMediaLists = (st: ProfileState) => emit({ type: 'media-lists', profileId: currentPid, lists: structuredClone(st.mediaLists) });
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
