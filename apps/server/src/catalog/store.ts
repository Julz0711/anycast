/** Read side of the catalog: row mapping and hide-rule-aware queries. */
import type { Category, Channel, EpgProgram, Episode, HideRules, MediaKind, Movie, Series, VodSort } from '@anycast/shared';
import type { Db } from '../db';
import { cleanEpisodeTitle } from './names';

export const KIND_INDEX: Record<MediaKind, number> = { live: 0, movie: 1, series: 2 };
export const KIND_TABLE: Record<MediaKind, 'channels' | 'movies' | 'series'> = { live: 'channels', movie: 'movies', series: 'series' };

export const EMPTY_RULES: HideRules = { countries: [], languages: [], categoryIds: [] };

export interface ChannelRow {
  id: string; name: string; raw_name: string; number: number; category_id: string; logo: string | null;
  country: string | null; language: string | null; archive_days: number; epg_channel_id: string | null;
  /** 1 when the stored guide has programmes for the channel */
  has_epg: number;
  /** duplicate channels (variants.ts) */
  group_key: string | null; group_name: string | null; group_number: number; quality: string | null; variant_rank: number; group_size: number;
}
export interface MovieRow {
  id: string; name: string; raw_name: string; category_id: string; poster: string | null; year: number | null;
  rating: number | null; plot: string | null; duration: number | null; container: string | null;
  country: string | null; language: string | null; added: number | null;
}
export interface SeriesRow {
  id: string; name: string; raw_name: string; category_id: string; poster: string | null; year: number | null;
  rating: number | null; plot: string | null; country: string | null; language: string | null; episodes_synced_at: number | null;
  added: number | null;
}
export interface EpisodeRow {
  id: string; series_id: string; season: number; episode: number; title: string; plot: string | null;
  duration: number | null; container: string | null; first_seen: number;
}
interface CategoryRow { id: string; kind: MediaKind; name: string; country: string | null; language: string | null; adult: number }
interface EpgRow { epg_id: string; start: number; end: number; title: string; description: string | null }

/** FNV-1a of a string, base 36: a short version tag for artwork URLs. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export type ArtKind = MediaKind | 'backdrop';

/**
 * Provider artwork is served through /api/art so provider hosts never reach the client. `v` changes
 * with the provider URL, so browsers may keep the image for good.
 */
export const artUrl = (kind: ArtKind, id: string, raw: string | null) => (raw ? `/api/art/${kind}/${encodeURIComponent(id)}?v=${shortHash(raw)}` : null);

export const toChannel = (r: ChannelRow): Channel => ({
  id: r.id, name: r.name, rawName: r.raw_name, number: r.number, categoryId: r.category_id, logo: artUrl('live', r.id, r.logo),
  country: r.country, language: r.language, archiveDays: r.archive_days, epgChannelId: r.epg_channel_id, hasEpg: r.has_epg === 1,
  quality: r.quality ?? null, variants: Math.max(0, (r.group_size ?? 1) - 1),
});
/** Panels send unix seconds; 0 or missing means unknown. */
export const addedMs = (v: number | null | undefined): number | null => (v && v > 0 ? (v < 1e12 ? v * 1000 : v) : null);

export const toMovie = (r: MovieRow): Movie => ({
  id: r.id, name: r.name, rawName: r.raw_name, categoryId: r.category_id, poster: artUrl('movie', r.id, r.poster), year: r.year,
  rating: r.rating, plot: r.plot, duration: r.duration, container: r.container, country: r.country, language: r.language,
  added: addedMs(r.added),
});
export const toSeries = (r: SeriesRow): Series => ({
  id: r.id, name: r.name, rawName: r.raw_name, categoryId: r.category_id, poster: artUrl('series', r.id, r.poster), year: r.year,
  rating: r.rating, plot: r.plot, country: r.country, language: r.language, added: addedMs(r.added),
});
export const toEpisode = (r: EpisodeRow): Episode => ({
  id: r.id, seriesId: r.series_id, season: r.season, episode: r.episode, title: cleanEpisodeTitle(r.title, null, r.episode), plot: r.plot,
  duration: r.duration, container: r.container,
});

/** SQL fragment that removes hidden rows; `alias` must expose country, language, category_id. */
export function hideClause(rules: HideRules, alias: string): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  const notIn = (col: string, values: string[], nullable: boolean) => {
    if (!values.length) return;
    const list = values.map(() => '?').join(',');
    parts.push(nullable ? `(${alias}.${col} IS NULL OR ${alias}.${col} NOT IN (${list}))` : `${alias}.${col} NOT IN (${list})`);
    params.push(...values);
  };
  notIn('country', rules.countries, true);
  notIn('language', rules.languages, true);
  notIn('category_id', rules.categoryIds, false);
  return { sql: parts.length ? parts.join(' AND ') : '1', params };
}

function categoryHidden(rules: HideRules, c: CategoryRow): boolean {
  return (
    rules.categoryIds.includes(c.id) ||
    (c.country !== null && rules.countries.includes(c.country)) ||
    (c.language !== null && rules.languages.includes(c.language))
  );
}

export function listCategories(db: Db, kind: MediaKind, rules: HideRules): Category[] {
  const rows = db.prepare('SELECT id, kind, name, country, language, adult FROM categories WHERE kind = ? ORDER BY sort').all(kind) as CategoryRow[];
  return rows.filter((r) => !categoryHidden(rules, r)).map((r) => ({ ...r, adult: r.adult === 1 }));
}

export interface PageQuery {
  categoryId?: string; offset: number; limit: number; hasEpg?: boolean;
  /** movies and series */
  sort?: VodSort; yearFrom?: number; yearTo?: number; minRating?: number;
  /** channels: one per group of duplicates (variants.ts) */
  merge?: boolean;
}

/**
 * SQL fragment that keeps one channel per group of duplicates: the best ranked one the rules let
 * the profile see (within `categoryId` when browsing one category). `alias` is the outer channel.
 */
export function variantClause(rules: HideRules, alias: string, sameCategory: boolean): { sql: string; params: string[] } {
  const hide = hideClause(rules, 'v');
  return {
    sql: `(${alias}.group_size = 1 OR NOT EXISTS (SELECT 1 FROM channels v WHERE v.group_key = ${alias}.group_key AND v.variant_rank < ${alias}.variant_rank AND ${hide.sql}${sameCategory ? ` AND v.category_id = ${alias}.category_id` : ''}))`,
    params: hide.params,
  };
}

/**
 * Page totals by query. Counting the visible rows of a 140k movie list with hidden categories
 * walks most of an index (~15 ms), and the answer only changes with a sync, so callers can pass
 * a cache that they drop when one runs or finishes.
 */
export type CountCache = Map<string, number>;
const COUNT_CACHE_MAX = 5000;

/** A channel as one row of a merged list: named after its group ("BBC One", not "BBC One FHD"). */
export const asGroup = (r: ChannelRow): ChannelRow => (r.group_size > 1 && r.group_name ? { ...r, name: r.group_name, number: r.group_number || r.number } : r);

function page<R, T>(db: Db, table: string, order: string, rules: HideRules, q: PageQuery, map: (r: R) => T, counts?: CountCache) {
  const hide = hideClause(rules, 't');
  const where = [hide.sql];
  const params: (string | number)[] = [...hide.params];
  if (q.categoryId) {
    where.push('t.category_id = ?');
    params.push(q.categoryId);
  }
  // "+ 0": an equality on an index column makes SQLite sort the ties itself instead of walking the index in order
  if (q.hasEpg && table === 'channels') where.push('t.has_epg + 0 = 1');
  if (table !== 'channels') {
    if (q.yearFrom !== undefined) { where.push('t.year >= ?'); params.push(q.yearFrom); }
    if (q.yearTo !== undefined) { where.push('t.year <= ?'); params.push(q.yearTo); }
    if (q.minRating !== undefined && q.minRating > 0) { where.push('t.rating >= ?'); params.push(q.minRating); }
  }
  if (q.merge && table === 'channels') {
    const v = variantClause(rules, 't', Boolean(q.categoryId));
    where.push(v.sql);
    params.push(...v.params);
  }
  const w = where.join(' AND ');
  const countSql = `SELECT count(*) AS n FROM ${table} t WHERE ${w}`;
  const key = counts && `${countSql}\n${JSON.stringify(params)}`;
  let total = key ? counts.get(key) : undefined;
  if (total === undefined) {
    total = (db.prepare(countSql).get(...params) as { n: number }).n;
    if (key) {
      if (counts.size >= COUNT_CACHE_MAX) counts.clear();
      counts.set(key, total);
    }
  }
  const rows = db.prepare(`SELECT t.* FROM ${table} t WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, q.limit, q.offset) as R[];
  return { items: rows.map(map), total };
}

// Orders spell out the list index columns (see migrations) so pages are a plain walk of the index,
// even deep into a 140k item list; the trailing rowid makes the order total.
const CHANNEL_ORDER = 't.number, t.country, t.language, t.category_id, t.has_epg, t.rowid';
/** merged lists: a group sits at the place of its lowest numbered version */
const GROUP_ORDER = 't.group_number, t.country, t.language, t.category_id, t.has_epg, t.rowid';
const ADDED_ORDER = 't.added DESC, t.country, t.language, t.category_id, t.rowid';
export const pageChannels = (db: Db, rules: HideRules, q: PageQuery, counts?: CountCache) =>
  page(db, 'channels', q.merge ? GROUP_ORDER : CHANNEL_ORDER, rules, q, (r: ChannelRow) => toChannel(q.merge ? asGroup(r) : r), counts);
const VOD_ORDER: Record<VodSort, string> = {
  added: ADDED_ORDER,
  name: 't.name COLLATE NOCASE, t.country, t.language, t.category_id, t.rowid',
  year: 't.year DESC, t.country, t.language, t.category_id, t.rowid',
  rating: 't.rating DESC, t.country, t.language, t.category_id, t.rowid',
};
export const pageMovies = (db: Db, rules: HideRules, q: PageQuery, counts?: CountCache) =>
  page(db, 'movies', VOD_ORDER[q.sort ?? 'added'], rules, q, toMovie, counts);
export const pageSeries = (db: Db, rules: HideRules, q: PageQuery, counts?: CountCache) =>
  page(db, 'series', VOD_ORDER[q.sort ?? 'added'], rules, q, toSeries, counts);

/** Every version of a channel visible under the rules, best first (the channel itself included). */
export function channelVariants(db: Db, id: string, rules: HideRules): ChannelRow[] {
  const c = getChannel(db, id);
  if (!c) return [];
  if (!c.group_key || c.group_size <= 1) return [c];
  const hide = hideClause(rules, 't');
  return db
    .prepare(`SELECT t.* FROM channels t WHERE t.group_key = ? AND ${hide.sql} ORDER BY t.variant_rank`)
    .all(c.group_key, ...hide.params) as ChannelRow[];
}

export const getChannel = (db: Db, id: string) => db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
export const getMovie = (db: Db, id: string) => db.prepare('SELECT * FROM movies WHERE id = ?').get(id) as MovieRow | undefined;
export const getSeries = (db: Db, id: string) => db.prepare('SELECT * FROM series WHERE id = ?').get(id) as SeriesRow | undefined;
export const getEpisode = (db: Db, id: string) => db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow | undefined;
export const listEpisodes = (db: Db, seriesId: string) =>
  db.prepare('SELECT * FROM episodes WHERE series_id = ? ORDER BY season, episode').all(seriesId) as EpisodeRow[];

/** Recomputes channels.has_epg from the stored guide (after a catalog or EPG sync). */
export function refreshHasEpg(db: Db): void {
  db.prepare(
    `UPDATE channels SET has_epg = EXISTS (SELECT 1 FROM epg WHERE epg.epg_id = channels.epg_channel_id)
     WHERE has_epg != EXISTS (SELECT 1 FROM epg WHERE epg.epg_id = channels.epg_channel_id)`,
  ).run();
}

/** Programs overlapping [from, to) for the given channels, keyed by AnyCast channel id. */
export function epgFor(db: Db, channels: Pick<ChannelRow, 'id' | 'epg_channel_id'>[], from: number, to: number): Record<string, EpgProgram[]> {
  const out: Record<string, EpgProgram[]> = {};
  const byEpg = new Map<string, string[]>();
  for (const c of channels) {
    out[c.id] = [];
    if (!c.epg_channel_id) continue;
    const ids = byEpg.get(c.epg_channel_id) ?? [];
    ids.push(c.id);
    byEpg.set(c.epg_channel_id, ids);
  }
  const stmt = db.prepare('SELECT * FROM epg WHERE epg_id = ? AND start < ? AND end > ? ORDER BY start');
  for (const [epgId, ids] of byEpg) {
    const rows = stmt.all(epgId, to, from) as EpgRow[];
    for (const id of ids) {
      out[id] = rows.map((r) => ({ channelId: id, title: r.title, description: r.description, start: r.start, end: r.end }));
    }
  }
  return out;
}

export function nowNext(db: Db, channel: Pick<ChannelRow, 'id' | 'epg_channel_id'>, now: number): { now: EpgProgram | null; next: EpgProgram | null } {
  if (!channel.epg_channel_id) return { now: null, next: null };
  const rows = db
    .prepare('SELECT * FROM epg WHERE epg_id = ? AND end > ? ORDER BY start LIMIT 2')
    .all(channel.epg_channel_id, now) as EpgRow[];
  const map = (r: EpgRow | undefined): EpgProgram | null =>
    r ? { channelId: channel.id, title: r.title, description: r.description, start: r.start, end: r.end } : null;
  const first = rows[0];
  if (first && first.start <= now) return { now: map(first), next: map(rows[1]) };
  return { now: null, next: map(first) };
}

/** Rows of `kind` with the given ids that are visible under the rules, in the order of `ids`. */
export function itemsByIds(db: Db, kind: 'live', ids: string[], rules: HideRules): ChannelRow[];
export function itemsByIds(db: Db, kind: 'movie', ids: string[], rules: HideRules): MovieRow[];
export function itemsByIds(db: Db, kind: 'series', ids: string[], rules: HideRules): SeriesRow[];
export function itemsByIds(db: Db, kind: MediaKind, ids: string[], rules: HideRules): (ChannelRow | MovieRow | SeriesRow)[] {
  if (!ids.length) return [];
  const hide = hideClause(rules, 't');
  const list = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT t.* FROM ${KIND_TABLE[kind]} t WHERE t.id IN (${list}) AND ${hide.sql}`)
    .all(...ids, ...hide.params) as { id: string }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) as (ChannelRow | MovieRow | SeriesRow)[];
}

/** Channels visible under the rules, among the given ids. */
export function visibleChannels(db: Db, ids: string[], rules: HideRules): ChannelRow[] {
  if (!ids.length) return [];
  const hide = hideClause(rules, 't');
  const list = ids.map(() => '?').join(',');
  return db.prepare(`SELECT t.* FROM channels t WHERE t.id IN (${list}) AND ${hide.sql}`).all(...ids, ...hide.params) as ChannelRow[];
}

export function rawArtUrl(db: Db, kind: MediaKind, id: string): string | null {
  const col = kind === 'live' ? 'logo' : 'poster';
  const row = db.prepare(`SELECT ${col} AS u FROM ${KIND_TABLE[kind]} WHERE id = ?`).get(id) as { u: string | null } | undefined;
  return row?.u ?? null;
}

export function countsByKind(db: Db): { live: number; movie: number; series: number } {
  const n = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { live: n('channels'), movie: n('movies'), series: n('series') };
}
