/** Series page: seasons, per-episode progress, resume/next-up, favorite. */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Episode } from '@anycast/shared';
import { useApp, useIsFavorite, progressKey } from '../store/app';
import { toggleFavorite } from '../store/actions';
import { cachedGet, errorMessage } from '../api/client';
import { remember } from '../api/catalog';
import { useAsync, useFormFactor } from '../lib/hooks';
import { fmtDuration, fmtLength } from '../lib/time';
import { PosterCard } from '../components/cards';
import { Empty, ProgressBar, Segmented, Skeleton } from '../components/ui';
import { IconBack, IconPlay, IconStar } from '../components/Icons';
import { prefetchPlayer } from '../player/prefetch';
import { MediaListButtons } from '../components/lists';

export function SeriesDetailScreen() {
  const { id = '' } = useParams();
  const form = useFormFactor();
  const navigate = useNavigate();
  const detail = useAsync(() => cachedGet('GET /api/series/:id', { params: { id } }, 120_000), [id]);
  const progress = useApp((s) => s.progress);
  const fav = useIsFavorite('series', id);
  const d = detail.data;
  useEffect(() => {
    if (d) remember('series', [d]);
  }, [d]);

  // Next up: the episode after the most recently watched one (or the in-progress one).
  const nextUp = useMemo(() => {
    if (!d) return null;
    const eps = d.seasons.flatMap((s) => s.episodes);
    let lastIdx = -1;
    let lastAt = 0;
    eps.forEach((e, i) => {
      const p = progress[progressKey('episode', e.id)];
      if (p && p.updatedAt > lastAt) {
        lastAt = p.updatedAt;
        lastIdx = i;
      }
    });
    if (lastIdx < 0) return { ep: eps[0] ?? null, resume: false };
    const last = eps[lastIdx]!;
    const p = progress[progressKey('episode', last.id)]!;
    if (!p.finished) return { ep: last, resume: true };
    return { ep: eps[lastIdx + 1] ?? null, resume: false };
  }, [d, progress]);

  const [season, setSeason] = useState<number | null>(null);
  const curSeason = season ?? nextUp?.ep?.season ?? d?.seasons[0]?.season ?? 1;

  if (detail.error) return <Empty title="Couldn't load this series">{errorMessage(detail.error)}</Empty>;
  if (!d) {
    return (
      <div className="detail" aria-busy="true">
        <Skeleton h="auto" r="0.625rem" style={{ aspectRatio: '2 / 3' }} />
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <Skeleton w="30%" />
          <Skeleton w="60%" h="2rem" />
          <Skeleton h="4rem" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} h="3.5rem" r="0.75rem" />
          ))}
        </div>
      </div>
    );
  }
  const seasonEps = d.seasons.find((s) => s.season === curSeason)?.episodes ?? [];
  const playPath = (e: Episode) => `/play/episode/${e.id}?series=${d.id}`;
  const nextProg = nextUp?.ep ? progress[progressKey('episode', nextUp.ep.id)] : undefined;

  return (
    <div>
      <button type="button" className="back-link" onClick={() => navigate(-1)}>
        <IconBack /> Back
      </button>
      <div className="detail">
        <div style={form === 'phone' ? { maxWidth: '8rem' } : undefined}>
          <PosterCard kind="series" item={d} />
        </div>
        <div>
          <div className="detail-meta tabnum">
            {[d.year, d.rating?.toFixed(1), `${d.seasons.length} season${d.seasons.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
          </div>
          <h1 className="h1">{d.name}</h1>
          {d.plot && <p className="detail-plot">{d.plot}</p>}
          <div className="actions" data-nav-row="series-actions">
            {nextUp?.ep && (
              <Link to={playPath(nextUp.ep)} className="btn btn-primary btn-lg" onMouseEnter={prefetchPlayer} data-nav-autofocus="">
                <IconPlay />
                {nextUp.resume
                  ? `Resume S${nextUp.ep.season} E${nextUp.ep.episode}${nextProg ? ' · ' + fmtDuration(nextProg.position) : ''}`
                  : `Play S${nextUp.ep.season} E${nextUp.ep.episode}`}
              </Link>
            )}
            <button type="button" className={`btn btn-lg${fav ? ' on' : ''}`} aria-pressed={fav} onClick={() => void toggleFavorite('series', d.id)}>
              <IconStar filled={fav} /> {fav ? 'Favorite' : 'Add favorite'}
            </button>
            <MediaListButtons kind="series" id={d.id} name={d.name} />
          </div>

          <div style={{ marginTop: '2rem' }}>
            {d.seasons.length > 1 ? (
              <Segmented
                label="Season"
                size="lg"
                value={curSeason}
                options={d.seasons.map((s) => ({ value: s.season, label: `Season ${s.season}` }))}
                onChange={setSeason}
              />
            ) : (
              <h2 className="label">Season {curSeason}</h2>
            )}
          </div>
          <div className="episodes" role="list" aria-label={`Season ${curSeason} episodes`}>
            {seasonEps.map((e) => {
              const p = progress[progressKey('episode', e.id)];
              return (
                <Link key={e.id} to={playPath(e)} className="episode" role="listitem" onMouseEnter={prefetchPlayer}>
                  <span className="n">{e.episode}</span>
                  <span style={{ minWidth: 0 }}>
                    <span className="t ellipsis" style={{ display: 'block' }}>
                      {e.title}
                    </span>
                    {e.plot && <span className="p">{e.plot}</span>}
                    {p && !p.finished && p.position > 0 && <ProgressBar value={p.position / p.duration} label={`${Math.round((p.position / p.duration) * 100)}% watched`} />}
                  </span>
                  <span className="d tabnum">{p?.finished ? <span className="done">Watched</span> : e.duration ? fmtLength(e.duration) : ''}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
