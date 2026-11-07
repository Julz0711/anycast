/**
 * Movie details from the provider's get_vod_info (plot, genre, cast, backdrop, trailer), fetched
 * when a movie page opens and kept in movie_info for a week. A movie row without plot or duration
 * gets them from the details, so lists and the player know them too.
 */
import type { MovieDetail } from '@anycast/shared';
import type { Db } from '../db';
import type { XtreamClient } from '../xtream/client';
import type { XVodInfo } from '../xtream/schemas';
import { artUrl, toMovie, type MovieRow } from './store';

const TTL_MS = 7 * 86400_000;
/** a failed fetch is retried after this long */
const RETRY_MS = 10 * 60_000;

const inflight = new Map<string, Promise<XVodInfo | null>>();
const failedAt = new Map<string, number>();

function cached(db: Db, id: string): { info: XVodInfo; fresh: boolean } | null {
  const r = db.prepare('SELECT data, fetched_at FROM movie_info WHERE movie_id = ?').get(id) as { data: string; fetched_at: number } | undefined;
  if (!r) return null;
  try {
    return { info: JSON.parse(r.data) as XVodInfo, fresh: Date.now() - r.fetched_at < TTL_MS };
  } catch {
    return null;
  }
}

async function fetchInfo(db: Db, client: XtreamClient, id: string): Promise<XVodInfo | null> {
  const failed = failedAt.get(id);
  if (failed && Date.now() - failed < RETRY_MS) return null;
  let p = inflight.get(id);
  if (!p) {
    p = client
      .vodInfo(id)
      .then((info) => {
        failedAt.delete(id);
        db.transaction(() => {
          db.prepare(
            `INSERT INTO movie_info (movie_id, data, fetched_at) VALUES (?, ?, ?)
             ON CONFLICT(movie_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
          ).run(id, JSON.stringify(info), Date.now());
          db.prepare('UPDATE movies SET plot = coalesce(plot, ?), duration = coalesce(duration, ?) WHERE id = ?').run(info.plot, info.durationSecs, id);
        })();
        return info;
      })
      .catch(() => {
        failedAt.set(id, Date.now());
        return null;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

/** The movie's details: cached ones while fresh, else fetched (falling back to stale ones, or none). */
export async function movieDetail(db: Db, client: XtreamClient | null, row: MovieRow): Promise<MovieDetail> {
  let hit = cached(db, row.id);
  if ((!hit || !hit.fresh) && client) {
    const info = await fetchInfo(db, client, row.id);
    if (info) hit = { info, fresh: true };
  }
  const fresh = (db.prepare('SELECT * FROM movies WHERE id = ?').get(row.id) as MovieRow | undefined) ?? row;
  const info = hit?.info;
  const movie = toMovie(fresh);
  return {
    ...movie,
    plot: movie.plot ?? info?.plot ?? null,
    duration: movie.duration ?? info?.durationSecs ?? null,
    rating: movie.rating ?? (info?.rating && info.rating > 0 ? Math.round(info.rating * 10) / 10 : null),
    genre: info?.genre ?? null,
    cast: info?.cast ?? null,
    director: info?.director ?? null,
    releaseDate: info?.releaseDate ?? null,
    country: movie.country ?? null,
    backdrop: artUrl('backdrop', row.id, info?.backdrop ?? null),
    trailer: info?.trailer ?? null,
  };
}

/** The provider URL of a movie's backdrop, from the cached details. */
export function rawBackdropUrl(db: Db, id: string): string | null {
  return cached(db, id)?.info.backdrop ?? null;
}
