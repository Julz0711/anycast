/**
 * Defensive parsing of player_api.php responses. Real panels send numbers as strings,
 * empty strings for null, `[]` for empty objects, and objects keyed by index for arrays.
 */
import { z } from 'zod';

const toNull = (v: unknown) => (v === '' || v === undefined || v === 'null' ? null : v);

const num = z
  .preprocess((v) => {
    const x = toNull(v);
    if (x === null) return null;
    const n = typeof x === 'number' ? x : Number(String(x).trim());
    return Number.isFinite(n) ? n : null;
  }, z.number().nullable())
  .catch(null);

const str = z
  .preprocess((v) => {
    const x = toNull(v);
    return x === null || typeof x === 'object' ? null : String(x);
  }, z.string().nullable())
  .catch(null);

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

const id = z.preprocess((v) => (v === null || v === undefined || v === '' ? undefined : String(v)), z.string());

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
  name: z.preprocess((v) => (v == null ? '' : String(v)), z.string()),
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
  name: z.preprocess((v) => (v == null ? '' : String(v)), z.string()),
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
  name: z.preprocess((v) => (v == null ? '' : String(v)), z.string()),
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
