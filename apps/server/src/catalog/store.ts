/** Read side of the catalog: row mapping and hide-rule-aware queries. */
import type { Category, Channel, EpgProgram, Episode, HideRules, MediaKind, Movie, Series } from '@anycast/shared';
import type { Db } from '../db';

export const KIND_INDEX: Record<MediaKind, number> = { live: 0, movie: 1, series: 2 };
export const KIND_TABLE: Record<MediaKind, 'channels' | 'movies' | 'series'> = { live: 'channels', movie: 'movies', series: 'series' };

export const EMPTY_RULES: HideRules = { countries: [], languages: [], categoryIds: [] };

export interface ChannelRow {
  id: string; name: string; raw_name: string; number: number; category_id: string; logo: string | null;
  country: string | null; language: string | null; archive_days: number; epg_channel_id: string | null;
}
export interface MovieRow {
  id: string; name: string; raw_name: string; category_id: string; poster: string | null; year: number | null;
  rating: number | null; plot: string | null; duration: number | null; container: string | null;
  country: string | null; language: string | null;
}
export interface SeriesRow {
  id: string; name: string; raw_name: string; category_id: string; poster: string | null; year: number | null;
  rating: number | null; plot: string | null; country: string | null; language: string | null; episodes_synced_at: number | null;
}
export interface EpisodeRow {
  id: string; series_id: string; season: number; episode: number; title: string; plot: string | null;
  duration: number | null; container: string | null;
}
interface CategoryRow { id: string; kind: MediaKind; name: string; country: string | null; language: string | null; adult: number }
interface EpgRow { epg_id: string; start: number; end: number; title: string; description: string | null }

/** Provider artwork is served through /api/art so provider hosts never reach the client. */
export const artUrl = (kind: MediaKind, id: string, raw: string | null) => (raw ? `/api/art/${kind}/${encodeURIComponent(id)}` : null);

export const toChannel = (r: ChannelRow): Channel => ({
  id: r.id, name: r.name, rawName: r.raw_name, number: r.number, categoryId: r.category_id, logo: artUrl('live', r.id, r.logo),
  country: r.country, language: r.language, archiveDays: r.archive_days, epgChannelId: r.epg_channel_id,
});
export const toMovie = (r: MovieRow): Movie => ({
  id: r.id, name: r.name, rawName: r.raw_name, categoryId: r.category_id, poster: artUrl('movie', r.id, r.poster), year: r.year,
  rating: r.rating, plot: r.plot, duration: r.duration, container: r.container, country: r.country, language: r.language,
});
export const toSeries = (r: SeriesRow): Series => ({
  id: r.id, name: r.name, rawName: r.raw_name, categoryId: r.category_id, poster: artUrl('series', r.id, r.poster), year: r.year,
  rating: r.rating, plot: r.plot, country: r.country, language: r.language,
});
export const toEpisode = (r: EpisodeRow): Episode => ({
  id: r.id, seriesId: r.series_id, season: r.season, episode: r.episode, title: r.title, plot: r.plot,
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

export interface PageQuery { categoryId?: string; offset: number; limit: number }

function page<R, T>(db: Db, table: string, order: string, rules: HideRules, q: PageQuery, map: (r: R) => T) {
  const hide = hideClause(rules, 't');
  const where = [hide.sql];
  const params: (string | number)[] = [...hide.params];
  if (q.categoryId) {
    where.push('t.category_id = ?');
    params.push(q.categoryId);
  }
  const w = where.join(' AND ');
  const total = (db.prepare(`SELECT count(*) AS n FROM ${table} t WHERE ${w}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`SELECT t.* FROM ${table} t WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, q.limit, q.offset) as R[];
  return { items: rows.map(map), total };
}

export const pageChannels = (db: Db, rules: HideRules, q: PageQuery) => page(db, 'channels', 't.number, t.rowid', rules, q, toChannel);
export const pageMovies = (db: Db, rules: HideRules, q: PageQuery) => page(db, 'movies', 't.added DESC, t.rowid', rules, q, toMovie);
export const pageSeries = (db: Db, rules: HideRules, q: PageQuery) => page(db, 'series', 't.added DESC, t.rowid', rules, q, toSeries);

export const getChannel = (db: Db, id: string) => db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
export const getMovie = (db: Db, id: string) => db.prepare('SELECT * FROM movies WHERE id = ?').get(id) as MovieRow | undefined;
export const getSeries = (db: Db, id: string) => db.prepare('SELECT * FROM series WHERE id = ?').get(id) as SeriesRow | undefined;
export const getEpisode = (db: Db, id: string) => db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow | undefined;
export const listEpisodes = (db: Db, seriesId: string) =>
  db.prepare('SELECT * FROM episodes WHERE series_id = ? ORDER BY season, episode').all(seriesId) as EpisodeRow[];

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
