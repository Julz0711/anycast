/** New episodes of followed series (favorites, lists, being watched): Home and the Series overview. */
import type { NewEpisodes } from '@anycast/shared';
import { useApp } from '../store/app';
import { cachedGet } from '../api/client';
import { useAsync } from '../lib/hooks';
import { UpNextCard } from './cards';
import { Skeleton } from './ui';

export function useNewEpisodes(enabled = true) {
  const version = useApp((s) => s.catalogVersion);
  const progressCount = useApp((s) => Object.keys(s.progress).length);
  return useAsync(() => (enabled ? cachedGet('GET /api/new-episodes', {}, 30_000) : Promise.resolve([] as NewEpisodes[])), [enabled, version, progressCount]);
}

const ep = (e: { season: number; episode: number }) => `S${e.season} · E${e.episode}`;

export function NewEpisodeCards(props: { items: NewEpisodes[] | undefined; limit?: number; row: string }) {
  return (
    <div className="shelf wide" data-nav-row={props.row}>
      {!props.items
        ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} h="auto" r="0.75rem" style={{ aspectRatio: '16 / 9' }} />)
        : props.items.slice(0, props.limit ?? 24).map(({ series, episodes }) => {
            const first = episodes[0]!;
            const one = episodes.length === 1;
            return (
              <UpNextCard
                key={series.id}
                to={`/series/${series.id}`}
                id={series.id}
                title={series.name}
                label={one ? `New · ${ep(first)}` : `${episodes.length} new episodes`}
                subtitle={one ? first.title : `From ${ep(first)}`}
                poster={series.poster}
                locked={series.locked}
              />
            );
          })}
    </div>
  );
}

/** The Series overview's row; nothing when there is nothing new. */
export function NewEpisodesShelf() {
  const data = useNewEpisodes();
  if (!data.data?.length) return null;
  return (
    <section aria-label="New episodes">
      <div className="row-title">
        <h2>New episodes</h2>
      </div>
      <NewEpisodeCards items={data.data} row="new-episodes" />
    </section>
  );
}
