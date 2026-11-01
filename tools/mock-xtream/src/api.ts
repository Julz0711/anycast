/**
 * player_api.php: the Xtream Codes JSON API. Field types follow what real panels return:
 * many numbers are strings, some fields switch between string and number, missing values are
 * "" or null.
 */
import type { Episode, LiveChannel, Movie, Series } from './catalog.js';
import { checkCredentials, nowSec, type MockContext } from './context.js';
import { programmesBetween, type Programme } from './epg.js';
import { PROFILES } from './formats.js';
import { formatLocal } from './tz.js';

export interface RequestInfo {
  /** Host as the client used it, without port. */
  hostname: string;
  port: number;
  /** "http://host:port", used for icon URLs. */
  baseUrl: string;
}

/** Raw (already serialised) body, used to return malformed JSON on purpose. */
export class RawJson {
  constructor(readonly body: string) {}
}

export type ApiResult = unknown;

const DAY = 86400;
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const hms = (secs: number): string =>
  [Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60].map((n) => String(n).padStart(2, '0')).join(':');

export function userInfo(ctx: MockContext, req: RequestInfo) {
  const now = nowSec(ctx);
  const expired = ctx.faults.get().expired;
  return {
    user_info: {
      username: ctx.username,
      password: ctx.password,
      message: 'Welcome to AnyCast Mock',
      auth: 1,
      status: expired ? 'Expired' : 'Active',
      exp_date: String(expired ? now - 2 * DAY : Math.floor(now / DAY) * DAY + 365 * DAY),
      is_trial: '0',
      active_cons: String(ctx.connections.count(ctx.username)),
      created_at: String(ctx.createdAt),
      max_connections: String(ctx.maxConnections),
      allowed_output_formats: ['m3u8', 'ts'],
    },
    server_info: {
      url: req.hostname,
      port: String(req.port),
      https_port: '443',
      server_protocol: 'http',
      rtmp_port: '8880',
      timezone: ctx.timezone,
      timestamp_now: now,
      time_now: formatLocal(now, ctx.timezone),
      process: true,
    },
  };
}

const icon = (req: RequestInfo, slug: string | null): string => (slug ? `${req.baseUrl}/images/${slug}.png` : '');
const rating5 = (r: string | number): number => {
  const n = Number(r);
  return Number.isFinite(n) && r !== '' ? Math.round((n / 2) * 10) / 10 : 0;
};

function liveStream(c: LiveChannel, req: RequestInfo) {
  return {
    num: c.num,
    name: c.name,
    stream_type: 'live',
    stream_id: c.id,
    stream_icon: icon(req, c.icon),
    epg_channel_id: c.epgChannelId,
    added: String(c.added),
    is_adult: c.tags.adult ? 1 : 0,
    category_id: c.categoryId,
    category_ids: [Number(c.categoryId)],
    custom_sid: c.customSid,
    tv_archive: c.archive ? 1 : 0,
    direct_source: '',
    // Real panels are inconsistent here: sometimes a string, sometimes a number.
    tv_archive_duration: c.id % 2 === 0 ? String(c.archiveDays) : c.archiveDays,
  };
}

function vodStream(m: Movie, req: RequestInfo) {
  return {
    num: m.num,
    name: m.name,
    stream_type: 'movie',
    stream_id: m.id,
    stream_icon: icon(req, m.icon),
    rating: m.rating,
    rating_5based: rating5(m.rating),
    added: String(m.added),
    is_adult: m.tags.adult ? 1 : 0,
    category_id: m.categoryId,
    category_ids: [Number(m.categoryId)],
    container_extension: PROFILES[m.profile].container,
    custom_sid: '',
    direct_source: '',
  };
}

function seriesInfoBlock(s: Series, req: RequestInfo) {
  return {
    name: s.name,
    cover: icon(req, s.icon),
    plot: s.plot,
    cast: s.cast,
    director: s.director,
    genre: s.genre,
    releaseDate: s.releaseDate,
    release_date: s.releaseDate,
    last_modified: String(s.lastModified),
    rating: s.rating,
    rating_5based: rating5(s.rating),
    backdrop_path: s.icon ? [icon(req, `${s.icon}-backdrop`)] : [],
    youtube_trailer: '',
    episode_run_time: '3',
    category_id: s.categoryId,
    category_ids: [Number(s.categoryId)],
  };
}

function seriesListItem(s: Series, req: RequestInfo) {
  return { ...seriesInfoBlock(s, req), num: s.num, name: s.name, series_id: s.id };
}

function mediaInfo(e: { profile: Movie['profile']; durationSecs: number }) {
  const p = PROFILES[e.profile];
  return {
    duration_secs: e.durationSecs,
    duration: hms(e.durationSecs),
    video: { codec_name: p.video, width: 640, height: 360, r_frame_rate: '10/1' },
    audio: { codec_name: p.audio[0]?.codec ?? 'aac', channels: 2, sample_rate: '48000' },
    bitrate: 350,
  };
}

function episodeEntry(e: Episode, s: Series, req: RequestInfo) {
  return {
    id: String(e.id),
    episode_num: e.episodeNum,
    title: e.title,
    container_extension: PROFILES[e.profile].container,
    info: {
      movie_image: icon(req, s.icon),
      plot: e.plot,
      releasedate: s.releaseDate,
      rating: s.rating,
      name: e.title,
      season: e.season,
      ...mediaInfo(e),
    },
    custom_sid: '',
    added: String(e.added),
    season: e.season,
    direct_source: '',
  };
}

function seriesInfo(s: Series, req: RequestInfo) {
  const episodes: Record<string, unknown[]> = {};
  for (const season of s.seasons) {
    const first = season[0];
    if (first) episodes[String(first.season)] = season.map((e) => episodeEntry(e, s, req));
  }
  // Half the series come without a seasons array, like many real panels.
  const seasons =
    s.id % 2 === 0
      ? []
      : s.seasons.map((season, i) => ({
          air_date: s.releaseDate,
          episode_count: season.length,
          id: s.id * 10 + i + 1,
          name: `Season ${i + 1}`,
          overview: '',
          season_number: i + 1,
          cover: icon(req, s.icon),
          cover_big: icon(req, s.icon),
        }));
  return { seasons, info: seriesInfoBlock(s, req), episodes };
}

function vodInfo(m: Movie, req: RequestInfo) {
  return {
    info: {
      tmdb_id: m.tmdbId,
      name: m.title,
      o_name: m.title,
      cover_big: icon(req, m.icon),
      movie_image: icon(req, m.icon),
      releasedate: `${m.year}-01-01`,
      youtube_trailer: '',
      director: m.director,
      actors: m.cast,
      cast: m.cast,
      description: m.plot,
      plot: m.plot,
      age: '',
      country: '',
      genre: m.genre,
      backdrop_path: m.icon ? [icon(req, `${m.icon}-backdrop`)] : [],
      rating: m.rating,
      ...mediaInfo(m),
    },
    movie_data: {
      stream_id: m.id,
      name: m.name,
      added: String(m.added),
      category_id: m.categoryId,
      category_ids: [Number(m.categoryId)],
      container_extension: PROFILES[m.profile].container,
      custom_sid: '',
      direct_source: '',
    },
  };
}

function listing(ctx: MockContext, c: LiveChannel, p: Programme, now: number, withArchive: boolean) {
  const entry: Record<string, unknown> = {
    id: p.id,
    epg_id: String(c.num),
    title: b64(p.title),
    lang: '',
    start: formatLocal(p.start, ctx.timezone),
    end: formatLocal(p.stop, ctx.timezone),
    description: b64(p.description),
    channel_id: c.epgChannelId,
    start_timestamp: String(p.start),
    stop_timestamp: String(p.stop),
    stream_id: String(c.id),
  };
  if (withArchive) {
    entry.now_playing = p.start <= now && now < p.stop ? 1 : 0;
    entry.has_archive = c.archive && p.stop <= now && p.start >= now - c.archiveDays * DAY ? 1 : 0;
  }
  return entry;
}

function shortEpg(ctx: MockContext, c: LiveChannel, limit: number) {
  if (!c.epgChannelId || !c.epgListed) return { epg_listings: [] };
  const now = nowSec(ctx);
  const progs = programmesBetween(c.epgChannelId, now, now + 2 * DAY).slice(0, limit);
  return { epg_listings: progs.map((p) => listing(ctx, c, p, now, false)) };
}

function simpleDataTable(ctx: MockContext, c: LiveChannel) {
  if (!c.epgChannelId || !c.epgListed) return { epg_listings: [] };
  const now = nowSec(ctx);
  const from = now - Math.max(c.archiveDays, 1) * DAY;
  const progs = programmesBetween(c.epgChannelId, from, now + 2 * DAY);
  return { epg_listings: progs.map((p) => listing(ctx, c, p, now, true)) };
}

const byCategory = <T extends { categoryId: string }>(items: T[], categoryId: unknown): T[] =>
  typeof categoryId === 'string' && categoryId !== '' ? items.filter((i) => i.categoryId === categoryId) : items;

const categoryList = (cats: { category_id: string; category_name: string; parent_id: 0 }[]) =>
  cats.map(({ category_id, category_name, parent_id }) => ({ category_id, category_name, parent_id }));

export function handlePlayerApi(ctx: MockContext, query: Record<string, unknown>, req: RequestInfo): ApiResult {
  if (!checkCredentials(ctx, query.username, query.password)) return { user_info: { auth: 0 } };
  const { catalog } = ctx;
  const num = (v: unknown): number => (typeof v === 'string' ? Number(v) : NaN);
  const brokenEpg = ctx.faults.get().brokenEpg;

  switch (query.action) {
    case undefined:
    case '':
      return userInfo(ctx, req);
    case 'get_live_categories':
      return categoryList(catalog.liveCategories);
    case 'get_vod_categories':
      return categoryList(catalog.vodCategories);
    case 'get_series_categories':
      return categoryList(catalog.seriesCategories);
    case 'get_live_streams':
      return byCategory(catalog.live, query.category_id).map((c) => liveStream(c, req));
    case 'get_vod_streams':
      return byCategory(catalog.movies, query.category_id).map((m) => vodStream(m, req));
    case 'get_series':
      return byCategory(catalog.series, query.category_id).map((s) => seriesListItem(s, req));
    case 'get_series_info': {
      const s = catalog.seriesById.get(num(query.series_id));
      return s ? seriesInfo(s, req) : { seasons: [], info: [], episodes: [] };
    }
    case 'get_vod_info': {
      const m = catalog.movieById.get(num(query.vod_id));
      return m ? vodInfo(m, req) : { info: [], movie_data: [] };
    }
    case 'get_short_epg': {
      if (brokenEpg) return new RawJson('{"epg_listings":[{"id":"1","title":"QnJva2Vu","start":"2024-');
      const c = catalog.liveById.get(num(query.stream_id));
      const limit = Number.isFinite(num(query.limit)) && num(query.limit) > 0 ? num(query.limit) : 4;
      return c ? shortEpg(ctx, c, limit) : { epg_listings: [] };
    }
    case 'get_simple_data_table': {
      // Broken panels answer with an array instead of the object.
      if (brokenEpg) return [];
      const c = catalog.liveById.get(num(query.stream_id));
      return c ? simpleDataTable(ctx, c) : { epg_listings: [] };
    }
    default:
      return [];
  }
}
