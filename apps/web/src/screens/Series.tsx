import { useApp } from '../store/app';
import { cachedGet } from '../api/client';
import { useAsync } from '../lib/hooks';
import { ContinueCard } from '../components/cards';
import { Skeleton } from '../components/ui';
import { VodBrowse } from './Vod';

export function SeriesScreen() {
  return <VodBrowse kind="series" title="Series" continueRow={<ContinueEpisodes />} />;
}

function ContinueEpisodes() {
  const progressCount = useApp((s) => Object.keys(s.progress).length);
  const cont = useAsync(() => cachedGet('GET /api/continue', {}, 10_000), [progressCount]);
  const items = cont.data?.episodes ?? [];
  if (!cont.loading && items.length === 0) return null;
  return (
    <section aria-label="Continue watching">
      <div className="row-title">
        <h2>Continue watching</h2>
      </div>
      <div className="shelf wide" data-nav-row="continue">
        {!cont.data
          ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} h="auto" r="0.75rem" style={{ aspectRatio: '16 / 9' }} />)
          : items.map((e) => (
              <ContinueCard
                key={e.id}
                to={`/play/episode/${e.id}?series=${e.series.id}`}
                id={e.series.id}
                title={e.series.name}
                subtitle={`S${e.season} E${e.episode} · ${e.title}`}
                poster={e.series.poster}
                position={e.progress.position}
                duration={e.progress.duration}
              />
            ))}
      </div>
    </section>
  );
}
