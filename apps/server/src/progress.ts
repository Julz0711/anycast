/** Watch progress rules (CT-2): finished threshold and "continue watching". */
import { FINISHED_THRESHOLD, type Episode, type Progress } from '@anycast/shared';

export function isFinished(position: number, duration: number): boolean {
  return duration > 0 && position / duration > FINISHED_THRESHOLD;
}

/**
 * Movies: unfinished with some progress. Series: for each series, look at its most recently
 * updated episode; unfinished -> that episode, finished -> the next episode in order (if any and
 * not itself finished). Newest first.
 */
export function continueWatching(
  all: Progress[],
  episodesOf: (seriesId: string) => Episode[],
): { movies: Progress[]; episodes: { episode: Episode; progress: Progress }[] } {
  const movies = all
    .filter((p) => p.kind === 'movie' && !p.finished && p.position > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const latestBySeries = new Map<string, Progress>();
  for (const p of all) {
    if (p.kind !== 'episode' || !p.seriesId) continue;
    const cur = latestBySeries.get(p.seriesId);
    if (!cur || p.updatedAt > cur.updatedAt) latestBySeries.set(p.seriesId, p);
  }
  const byId = new Map(all.filter((p) => p.kind === 'episode').map((p) => [p.id, p]));
  const episodes: { episode: Episode; progress: Progress }[] = [];
  for (const [seriesId, last] of latestBySeries) {
    const list = [...episodesOf(seriesId)].sort((a, b) => a.season - b.season || a.episode - b.episode);
    const idx = list.findIndex((e) => e.id === last.id);
    if (idx < 0) continue;
    if (!last.finished) {
      episodes.push({ episode: list[idx]!, progress: last });
      continue;
    }
    const next = list.slice(idx + 1).find((e) => !byId.get(e.id)?.finished);
    if (!next) continue;
    const saved = byId.get(next.id);
    episodes.push({
      episode: next,
      progress: saved ?? {
        kind: 'episode', id: next.id, seriesId, position: 0, duration: next.duration ?? 0, finished: false, updatedAt: last.updatedAt,
      },
    });
  }
  episodes.sort((a, b) => b.progress.updatedAt - a.progress.updatedAt);
  return { movies, episodes };
}
