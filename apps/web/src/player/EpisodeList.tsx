/**
 * The player's episode section (episodes, stacked layout): every episode of a season with its still
 * (or the series art and its number), length, plot and how much of it was watched. The playing one
 * is marked, the next one says Up next. Opens on the season of the playing episode.
 */
import { useEffect, useState } from 'react';
import type { Episode, SeriesDetail } from '@anycast/shared';
import { progressKey, useApp } from '../store/app';
import { fmtLength } from '../lib/time';
import { IconPlay } from '../components/Icons';

export function EpisodeList(props: {
  series: SeriesDetail;
  currentId: string;
  nextId: string | undefined;
  /** how far the playing episode is (0..1), live from the player */
  currentProgress: number | null;
  onPlay: (e: Episode) => void;
}) {
  const { series, currentId, nextId } = props;
  const progress = useApp((s) => s.progress);
  const showArt = useApp((s) => s.prefs.appearance.showArtwork);
  const current = series.seasons.flatMap((s) => s.episodes).find((e) => e.id === currentId);
  const [season, setSeason] = useState<number>(current?.season ?? series.seasons[0]?.season ?? 1);
  // the next episode can be in the next season: follow the playing one
  useEffect(() => {
    if (current) setSeason(current.season);
  }, [current?.season]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = series.seasons.find((s) => s.season === season)?.episodes ?? [];
  const watched = list.filter((e) => progress[progressKey('episode', e.id)]?.finished).length;

  return (
    <section className="pl-eps" aria-label="Episodes">
      <div className="pl-eps-head">
        <h2 className="pl-eps-title">Episodes</h2>
        <span className="pl-eps-count muted tabnum">
          {list.length} episode{list.length === 1 ? '' : 's'}
          {watched > 0 ? ` · ${watched} watched` : ''}
        </span>
        {series.seasons.length > 1 && (
          <div className="pl-eps-seasons" role="radiogroup" aria-label="Season" data-nav-row="pl-seasons">
            {series.seasons.map((s) => (
              <button
                key={s.season}
                type="button"
                role="radio"
                aria-checked={s.season === season}
                onClick={() => setSeason(s.season)}
              >
                Season {s.season}
                {s.episodes.some((e) => e.isNew) && <span className="pl-eps-dot" aria-label="new episodes" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="pl-eps-grid" role="list">
        {list.map((e) => {
          const isCur = e.id === currentId;
          const isNext = e.id === nextId;
          const p = progress[progressKey('episode', e.id)];
          const frac = isCur ? props.currentProgress : p && p.duration > 0 && !p.finished ? p.position / p.duration : null;
          const done = !isCur && !!p?.finished;
          const img = showArt ? (e.image ?? null) : null;
          const fallback = showArt && !img ? series.poster : null;
          return (
            <div role="listitem" key={e.id}>
              <button
                type="button"
                className="pl-ep"
                data-state={isCur ? 'playing' : isNext ? 'next' : done ? 'watched' : undefined}
                aria-current={isCur ? 'true' : undefined}
                onClick={() => !isCur && props.onPlay(e)}
                aria-label={`${isCur ? 'Playing: ' : isNext ? 'Up next: ' : ''}Episode ${e.episode}, ${e.title}${done ? ', watched' : ''}`}
              >
                <span className="pl-ep-thumb" data-art={img ? 'still' : fallback ? 'poster' : 'none'}>
                  {(img ?? fallback) && <img src={(img ?? fallback)!} alt="" loading="lazy" decoding="async" onError={(ev) => (ev.currentTarget.style.display = 'none')} />}
                  {!img && <span className="pl-ep-num tabnum">{e.episode}</span>}
                  {isCur ? (
                    <span className="pl-ep-flag on">
                      <span className="pl-ep-eq" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      Playing
                    </span>
                  ) : isNext ? (
                    <span className="pl-ep-flag">Up next</span>
                  ) : done ? (
                    <span className="pl-ep-flag">Watched</span>
                  ) : null}
                  {!isCur && (
                    <span className="pl-ep-play" aria-hidden="true">
                      <IconPlay />
                    </span>
                  )}
                  {e.duration ? <span className="pl-ep-len tabnum">{fmtLength(e.duration)}</span> : null}
                  {frac !== null && frac > 0 && (
                    <span className="pl-ep-bar" aria-hidden="true">
                      <i style={{ width: `${Math.min(100, frac * 100).toFixed(1)}%` }} />
                    </span>
                  )}
                  {done && <span className="pl-ep-bar full" aria-hidden="true" />}
                </span>
                <span className="pl-ep-text">
                  <span className="pl-ep-name">
                    <span className="tabnum muted">{e.episode}.</span> {e.isNew && <span className="new-badge">New</span>}
                    {e.title}
                  </span>
                  {e.plot && <span className="pl-ep-plot">{e.plot}</span>}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
