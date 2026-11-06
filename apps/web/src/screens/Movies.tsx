import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Movie } from '@anycast/shared';
import { useApp, useIsFavorite, useProgress } from '../store/app';
import { toggleFavorite } from '../store/actions';
import { cachedGet } from '../api/client';
import { lookup, resolveItems } from '../api/catalog';
import { useAsync, useFormFactor } from '../lib/hooks';
import { fmtDuration, fmtLength } from '../lib/time';
import { ContinueCard, PosterCard } from '../components/cards';
import { Empty, ProgressBar, Skeleton } from '../components/ui';
import { IconBack, IconPlay, IconStar } from '../components/Icons';
import { VodBrowse } from './Vod';
import { prefetchPlayer } from '../player/prefetch';

export function MoviesScreen() {
  return <VodBrowse kind="movie" title="Movies" continueRow={<ContinueMovies />} />;
}

function ContinueMovies() {
  const progressCount = useApp((s) => Object.keys(s.progress).length);
  const cont = useAsync(() => cachedGet('GET /api/continue', {}, 10_000), [progressCount]);
  const items = cont.data?.movies ?? [];
  if (!cont.loading && items.length === 0) return null;
  return (
    <section aria-label="Continue watching">
      <div className="row-title">
        <h2>Continue watching</h2>
      </div>
      <div className="shelf wide" data-nav-row="continue">
        {!cont.data
          ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} h="auto" r="0.75rem" style={{ aspectRatio: '16 / 9' }} />)
          : items.map((m) => (
              <ContinueCard key={m.id} to={`/play/movie/${m.id}`} id={m.id} title={m.name} poster={m.poster} position={m.progress.position} duration={m.progress.duration} locked={m.locked} />
            ))}
      </div>
    </section>
  );
}

export function MovieDetail() {
  const { id = '' } = useParams();
  const form = useFormFactor();
  const navigate = useNavigate();
  const movie = useAsync(async (signal) => lookup('movie', id) ?? (await resolveItems('movie', [id], { signal }))[0] ?? null, [id]);
  const fav = useIsFavorite('movie', id);
  const prog = useProgress('movie', id);
  const m = movie.data as Movie | null | undefined;
  if (movie.loading && !m) {
    return (
      <div className="detail" aria-busy="true">
        <Skeleton h="auto" r="0.625rem" style={{ aspectRatio: '2 / 3' }} />
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <Skeleton w="30%" />
          <Skeleton w="60%" h="2rem" />
          <Skeleton h="4rem" />
        </div>
      </div>
    );
  }
  if (!m) return <Empty title="Movie not found">It may have been removed by your provider or hidden by a filter.</Empty>;
  const resumable = prog && !prog.finished && prog.position > 30;
  return (
    <div>
      <button type="button" className="back-link" onClick={() => navigate(-1)}>
        <IconBack /> Back
      </button>
      <div className="detail">
        <div style={form === 'phone' ? { maxWidth: '8rem' } : undefined}>
          <PosterCard kind="movie" item={m} />
        </div>
        <div>
          <div className="detail-meta tabnum">{[m.year, m.rating?.toFixed(1), m.duration ? fmtLength(m.duration) : null].filter(Boolean).join(' · ')}</div>
          <h1 className="h1">{m.name}</h1>
          {m.plot && <p className="detail-plot">{m.plot}</p>}
          {resumable && (
            <div style={{ maxWidth: '24rem', marginTop: '1rem' }}>
              <ProgressBar value={prog.position / prog.duration} label="Watched" />
              <div className="muted tabnum" style={{ fontSize: '0.8125rem', marginTop: '0.375rem' }}>
                {fmtDuration(prog.position)} of {fmtDuration(prog.duration)}
              </div>
            </div>
          )}
          <div className="actions" data-nav-row="movie-actions">
            <Link to={`/play/movie/${m.id}`} className="btn btn-primary btn-lg" onMouseEnter={prefetchPlayer} data-nav-autofocus="">
              <IconPlay /> {resumable ? `Resume from ${fmtDuration(prog.position)}` : 'Play'}
            </Link>
            {resumable && (
              <Link to={`/play/movie/${m.id}?start=0`} className="btn btn-lg">
                Play from start
              </Link>
            )}
            <button type="button" className={`btn btn-lg${fav ? ' on' : ''}`} aria-pressed={fav} onClick={() => void toggleFavorite('movie', m.id)}>
              <IconStar filled={fav} /> {fav ? 'Favorite' : 'Add favorite'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
