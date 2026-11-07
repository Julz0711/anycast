/**
 * Defensive parsing of player_api.php responses. Real panels send numbers as strings,
 * empty strings for null, `[]` for empty objects, and objects keyed by index for arrays.
 */
import { z } from 'zod';

const toNull = (v: unknown) => (v === '' || v === undefined || v === 'null' ? null : v);

// Field conversions, shared by the zod schemas and the fast list parsers below.
const toNum = (v: unknown): number | null => {
  const x = toNull(v);
  if (x === null) return null;
  const n = typeof x === 'number' ? x : Number(String(x).trim());
  return Number.isFinite(n) ? n : null;
};
const toStr = (v: unknown): string | null => {
  const x = toNull(v);
  return x === null || typeof x === 'object' ? null : String(x);
};
const toName = (v: unknown): string => (v == null ? '' : String(v));
const toId = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v));

const num = z.preprocess(toNum, z.number().nullable()).catch(null);
const str = z.preprocess(toStr, z.string().nullable()).catch(null);
const name = z.preprocess(toName, z.string());

const bool = z.preprocess((v) => v === true || v === 1 || v === '1' || v === 'true', z.boolean()).catch(false);

/** Accepts arrays, index-keyed objects, or garbage; drops entries that fail the schema. */
export function parseList<T extends z.ZodTypeAny>(schema: T, data: unknown): z.output<T>[] {
  const arr = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data) : [];
  const out: z.output<T>[] = [];
  for (const item of arr) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

const id = z.preprocess(toId, z.string());

export const UserInfo = z.object({
  auth: num,
  status: str,
  exp_date: num,
  is_trial: bool,
  active_cons: num,
  max_connections: num,
  created_at: num,
  message: str,
  allowed_output_formats: z.preprocess((v) => (Array.isArray(v) ? v.map(String) : []), z.array(z.string())).catch([]),
});
export type UserInfo = z.output<typeof UserInfo>;

export const ServerInfo = z.object({
  timezone: str,
  timestamp_now: num,
  time_now: str,
});
export type ServerInfo = z.output<typeof ServerInfo>;

export const AuthResponse = z.object({
  user_info: z.preprocess((v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}), UserInfo),
  server_info: z.preprocess((v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}), ServerInfo),
});
export type AuthResponse = z.output<typeof AuthResponse>;

export const XCategory = z.object({
  category_id: id,
  category_name: z.preprocess((v) => (v == null ? '' : String(v)), z.string()),
  parent_id: num,
});
export type XCategory = z.output<typeof XCategory>;

export const XLiveStream = z.object({
  num: num,
  name,
  stream_id: id,
  stream_icon: str,
  epg_channel_id: str,
  added: num,
  category_id: str,
  tv_archive: num,
  tv_archive_duration: num,
});
export type XLiveStream = z.output<typeof XLiveStream>;

export const XVodStream = z.object({
  num: num,
  name,
  stream_id: id,
  stream_icon: str,
  rating: num,
  added: num,
  category_id: str,
  container_extension: str,
  year: num,
  plot: str,
  duration_secs: num,
});
export type XVodStream = z.output<typeof XVodStream>;

export const XSeries = z.object({
  num: num,
  name,
  series_id: id,
  cover: str,
  plot: str,
  releaseDate: str,
  release_date: str,
  year: num,
  last_modified: num,
  rating: num,
  category_id: str,
});
export type XSeries = z.output<typeof XSeries>;

/**
 * Fast equivalents of XLiveStream/XVodStream/XSeries.safeParse for the big streamed lists: the
 * same conversions, without zod's per-field machinery, which was ~20 µs per item (3 s of a
 * 140k movie sync). Return null where safeParse fails (not an object, or no id). A test checks
 * they agree with the schemas.
 */
type Fields = Record<string, 'num' | 'str' | 'name' | 'id'>;
const CONVERT = { num: toNum, str: toStr, name: toName, id: toId };
function fastObject<T>(fields: Fields): (v: unknown) => T | null {
  const entries = Object.entries(fields).map(([k, kind]) => [k, CONVERT[kind], kind === 'id'] as const);
  return (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, convert, required] of entries) {
      const x = convert(src[k]);
      if (required && x === undefined) return null;
      out[k] = x;
    }
    return out as T;
  };
}

export const parseLiveStream = fastObject<XLiveStream>({
  num: 'num', name: 'name', stream_id: 'id', stream_icon: 'str', epg_channel_id: 'str', added: 'num', category_id: 'str',
  tv_archive: 'num', tv_archive_duration: 'num',
});
export const parseVodStream = fastObject<XVodStream>({
  num: 'num', name: 'name', stream_id: 'id', stream_icon: 'str', rating: 'num', added: 'num', category_id: 'str',
  container_extension: 'str', year: 'num', plot: 'str', duration_secs: 'num',
});
export const parseSeries = fastObject<XSeries>({
  num: 'num', name: 'name', series_id: 'id', cover: 'str', plot: 'str', releaseDate: 'str', release_date: 'str', year: 'num',
  last_modified: 'num', rating: 'num', category_id: 'str',
});

const EpisodeInfo = z
  .preprocess(
    (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
    z.object({ duration_secs: num, duration: str, plot: str, movie_image: str }),
  )
  .catch({ duration_secs: null, duration: null, plot: null, movie_image: null });

export const XEpisode = z.object({
  id: id,
  episode_num: num,
  title: str,
  container_extension: str,
  season: num,
  info: EpisodeInfo,
});
export type XEpisode = z.output<typeof XEpisode>;

export interface XSeriesInfo {
  episodes: (XEpisode & { season: number })[];
  info: { name: string | null; plot: string | null; cover: string | null };
}

/** episodes come as {"1":[...],"2":[...]}, as an array of arrays, or as a flat array */
export function parseSeriesInfo(data: unknown): XSeriesInfo {
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const rawEpisodes = obj.episodes;
  const groups: [string | null, unknown][] = Array.isArray(rawEpisodes)
    ? rawEpisodes.map((g) => [null, g] as [null, unknown])
    : rawEpisodes && typeof rawEpisodes === 'object'
      ? Object.entries(rawEpisodes)
      : [];
  const episodes: XSeriesInfo['episodes'] = [];
  for (const [key, group] of groups) {
    const items = Array.isArray(group) || (group && typeof group === 'object' && !('id' in group)) ? group : [group];
    for (const ep of parseList(XEpisode, items)) {
      const season = ep.season ?? (key !== null && Number.isFinite(Number(key)) ? Number(key) : 1);
      episodes.push({ ...ep, season });
    }
  }
  const info = obj.info && typeof obj.info === 'object' && !Array.isArray(obj.info) ? (obj.info as Record<string, unknown>) : {};
  return {
    episodes,
    info: { name: str.parse(info.name), plot: str.parse(info.plot), cover: str.parse(info.cover) },
  };
}

/** get_vod_info: the movie's details. Panels fill these fields very unevenly; every field may be null. */
export interface XVodInfo {
  plot: string | null;
  genre: string | null;
  cast: string | null;
  director: string | null;
  releaseDate: string | null;
  durationSecs: number | null;
  rating: number | null;
  country: string | null;
  /** provider image URLs: a wide backdrop and the big cover */
  backdrop: string | null;
  cover: string | null;
  /** YouTube video id */
  trailer: string | null;
}

export function parseVodInfo(data: unknown): XVodInfo {
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const info = obj.info && typeof obj.info === 'object' && !Array.isArray(obj.info) ? (obj.info as Record<string, unknown>) : {};
  const s = (v: unknown) => {
    const x = str.parse(v);
    return x && x.trim() ? x.trim() : null;
  };
  const backdrops = Array.isArray(info.backdrop_path) ? info.backdrop_path : [info.backdrop_path];
  const url = (v: unknown) => {
    const x = s(v);
    return x && /^https?:\/\//i.test(x) ? x : null;
  };
  const trailer = s(info.youtube_trailer);
  const duration = num.parse(info.duration_secs) ?? (() => {
    const d = s(info.duration);
    if (!d || !/^\d+(:\d+){1,2}$/.test(d)) return null;
    return d.split(':').map(Number).reduce((a, n) => a * 60 + n, 0) || null;
  })();
  return {
    plot: s(info.plot) ?? s(info.description),
    genre: s(info.genre),
    cast: s(info.cast) ?? s(info.actors),
    director: s(info.director),
    releaseDate: s(info.releasedate) ?? s(info.release_date),
    durationSecs: duration,
    rating: num.parse(info.rating),
    country: s(info.country),
    backdrop: backdrops.map(url).find(Boolean) ?? null,
    cover: url(info.cover_big) ?? url(info.movie_image),
    trailer: trailer && /^[\w-]{6,20}$/.test(trailer) ? trailer : null,
  };
}
