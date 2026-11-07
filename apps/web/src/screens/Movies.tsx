import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Movie, MovieDetail as MovieDetailT } from '@anycast/shared';
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
import { MediaListButtons } from '../components/lists';

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

/** Fills the detail from the provider (genre, cast, backdrop…); the list's copy shows meanwhile. */
function useMovieDetail(id: string) {
  const quick = useAsync(async (signal) => lookup('movie', id) ?? (await resolveItems('movie', [id], { signal }))[0] ?? null, [id]);
  const full = useAsync(() => cachedGet('GET /api/movies/:id', { params: { id } }, 300_000), [id]);
  const m = (full.data ?? quick.data) as MovieDetailT | Movie | null | undefined;
  return { m, loading: (quick.loading && !quick.data) && !full.data, detail: full.data ?? null, gone: !full.loading && !quick.loading && !m };
}

const firstNames = (list: string | null, n: number) => {
  if (!list) return null;
  const all = [...new Set(list.split(/\s*,\s*/).filter(Boolean))];
  return all.length > n ? `${all.slice(0, n).join(', ')} and ${all.length - n} more` : all.join(', ');
};

export function MovieDetail() {
  const { id = '' } = useParams();
  const form = useFormFactor();
  const navigate = useNavigate();
  const { m, loading, detail } = useMovieDetail(id);
  const fav = useIsFavorite('movie', id);
  const prog = useProgress('movie', id);
  if (loading && !m) {
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
  const phone = form === 'phone';
  const meta = [m.year, m.duration ? fmtLength(m.duration) : null, detail?.genre && [...new Set(detail.genre.split(/\s*[,/]\s*/).filter(Boolean))].slice(0, 3).join(', ')].filter(Boolean).join(' · ');
  const facts: [string, string | null][] = detail
    ? [
        ['Director', detail.director],
        ['Cast', firstNames(detail.cast, 6)],
        ['Released', detail.releaseDate && !/^\d{4}$/.test(detail.releaseDate) ? fmtDate(detail.releaseDate) : null],
        ['Country', detail.country],
      ]
    : [];
  const shownFacts = facts.filter((f): f is [string, string] => !!f[1]);
  const backdrop = detail?.backdrop;
  return (
    <div className={backdrop ? 'movie-page has-backdrop' : 'movie-page'}>
      {backdrop && (
        <div className="movie-backdrop" aria-hidden="true">
          <img src={backdrop} alt="" onError={(e) => (e.currentTarget.parentElement!.style.display = 'none')} />
        </div>
      )}
      <button type="button" className="back-link" onClick={() => navigate(-1)}>
        <IconBack /> Back
      </button>
      <div className="detail">
        <div className="detail-poster">
          <PosterCard kind="movie" item={m} />
        </div>
        <div className="detail-body">
          {meta && <div className="detail-meta tabnum">{meta}</div>}
          <h1 className="h1">{m.name}</h1>
          {m.rating ? (
            <div className="detail-rating tabnum" aria-label={`Rated ${m.rating.toFixed(1)} out of 10`}>
              <IconStar filled className="ico" /> {m.rating.toFixed(1)} <span className="muted">/ 10</span>
            </div>
          ) : null}
          {m.plot ? <p className="detail-plot">{m.plot}</p> : !detail && <Skeleton h="3rem" style={{ maxWidth: '36rem' }} />}
          {resumable && (
            <div style={{ maxWidth: '24rem', marginTop: '1rem' }}>
              <ProgressBar value={prog.position / prog.duration} label="Watched" />
              <div className="muted tabnum" style={{ fontSize: '0.8125rem', marginTop: '0.375rem' }}>
                {fmtDuration(prog.position)} of {fmtDuration(prog.duration)}
              </div>
            </div>
          )}
          <div className="actions" data-nav-row="movie-actions">
            <Link to={`/play/movie/${m.id}`} className={`btn btn-primary btn-lg${phone ? ' grow' : ''}`} onMouseEnter={prefetchPlayer} data-nav-autofocus="">
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
            <MediaListButtons kind="movie" id={m.id} name={m.name} />
            {detail?.trailer && (
              <a className="btn btn-lg" href={`https://www.youtube.com/watch?v=${encodeURIComponent(detail.trailer)}`} target="_blank" rel="noreferrer noopener">
                Trailer
              </a>
            )}
          </div>
          {shownFacts.length > 0 && (
            <dl className="detail-facts">
              {shownFacts.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtDate(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
