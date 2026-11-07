/**
 * New episodes of followed series. A profile follows a series when it is a favorite, in one of
 * its lists (Watch Later included) or has an episode in progress or watched. Episodes keep the
 * time AnyCast first saw them (episodes.first_seen, 0 for the series' first fetch); an episode is
 * new for a profile when it was first seen after the profile last opened the series or played
 * one of its episodes (series_seen, progress), and after the profile started following it.
 */
import type { Episode, HideRules, NewEpisodes, Series } from '@anycast/shared';
import type { Db } from '../db';
import { hideClause, toEpisode, toSeries, type EpisodeRow, type SeriesRow } from './store';

/** Series ids some profile follows (for the after-sync episode refresh). */
export function followedByAnyone(db: Db): string[] {
  return (
    db
      .prepare(
        `SELECT item_id AS id FROM favorites WHERE kind = 'series'
         UNION SELECT i.item_id FROM media_list_items i WHERE i.kind = 'series'
         UNION SELECT series_id FROM progress WHERE kind = 'episode' AND series_id IS NOT NULL`,
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
}

/** Series the profile follows, with the time it started following (ms). */
function followed(db: Db, profileId: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT item_id AS id, added_at AS since FROM favorites WHERE profile_id = ? AND kind = 'series'
       UNION ALL SELECT i.item_id, i.added_at FROM media_list_items i JOIN media_lists l ON l.id = i.list_id WHERE l.profile_id = ? AND i.kind = 'series'
       UNION ALL SELECT series_id, min(updated_at) FROM progress WHERE profile_id = ? AND kind = 'episode' AND series_id IS NOT NULL GROUP BY series_id`,
    )
    .all(profileId, profileId, profileId) as { id: string; since: number }[];
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.id, Math.min(out.get(r.id) ?? Infinity, r.since));
  return out;
}

/** When the profile last looked at the series: opened its page or played one of its episodes. */
export function seenAt(db: Db, profileId: string, seriesId: string): number {
  const r = db
    .prepare(
      `SELECT max(t) AS t FROM (
         SELECT seen_at AS t FROM series_seen WHERE profile_id = ? AND series_id = ?
         UNION ALL SELECT max(updated_at) FROM progress WHERE profile_id = ? AND kind = 'episode' AND series_id = ?
       )`,
    )
    .get(profileId, seriesId, profileId, seriesId) as { t: number | null };
  return r.t ?? 0;
}

export function markSeen(db: Db, profileId: string, seriesId: string, at = Date.now()): void {
  db.prepare(
    `INSERT INTO series_seen (profile_id, series_id, seen_at) VALUES (?, ?, ?)
     ON CONFLICT(profile_id, series_id) DO UPDATE SET seen_at = excluded.seen_at`,
  ).run(profileId, seriesId, at);
}

/** Ids of the series' episodes that are new for the profile (for the series page). */
export function newEpisodeIds(db: Db, profileId: string, seriesId: string, before: number): Set<string> {
  const since = followed(db, profileId).get(seriesId);
  if (since === undefined) return new Set();
  const after = Math.max(since, before);
  const rows = db.prepare('SELECT id FROM episodes WHERE series_id = ? AND first_seen > ?').all(seriesId, after) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export function newEpisodes(db: Db, profileId: string, rules: HideRules, mapSeries: (s: Series) => Series = (s) => s): NewEpisodes[] {
  const follows = followed(db, profileId);
  if (!follows.size) return [];
  const ids = [...follows.keys()];
  const hide = hideClause(rules, 't');
  const series = db
    .prepare(`SELECT t.* FROM series t WHERE t.id IN (${ids.map(() => '?').join(',')}) AND ${hide.sql}`)
    .all(...ids, ...hide.params) as SeriesRow[];
  const eps = db.prepare('SELECT * FROM episodes WHERE series_id = ? AND first_seen > ? ORDER BY season, episode');
  const out: (NewEpisodes & { latest: number })[] = [];
  for (const s of series) {
    const after = Math.max(follows.get(s.id) ?? 0, seenAt(db, profileId, s.id));
    const rows = eps.all(s.id, after) as EpisodeRow[];
    if (!rows.length) continue;
    const episodes: Episode[] = rows.map((r) => ({ ...toEpisode(r), isNew: true }));
    out.push({ series: mapSeries(toSeries(s)), episodes, latest: Math.max(...rows.map((r) => r.first_seen)) });
  }
  return out.sort((a, b) => b.latest - a.latest).map(({ latest: _latest, ...rest }) => rest);
}
