/** One box, instant results grouped Live / Movies / Series. Debounced; stale requests are aborted. */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { SearchResults } from '@anycast/shared';
import { call, errorMessage, isAbort } from '../api/client';
import { remember } from '../api/catalog';
import { setZapList } from '../store/actions';
import { useFormFactor } from '../lib/hooks';
import { writeLocal } from '../lib/storage';
import { PosterCard } from '../components/cards';
import { Empty, LogoTile, Skeleton } from '../components/ui';
import { IconSearch } from '../components/Icons';
import { PosterSkeleton } from './Vod';

export function SearchScreen() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [res, setRes] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useFormFactor();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const term = q.trim();
    setParams(term ? { q: term } : {}, { replace: true });
    if (!term) {
      setRes(null);
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      call('GET /api/search', { query: { q: term }, signal: ac.signal }).then(
        (r) => {
          remember('live', r.live);
          remember('movie', r.movies);
          remember('series', r.series);
          setRes(r);
          setError(null);
          setLoading(false);
        },
        (e) => {
          if (isAbort(e)) return;
          setError(errorMessage(e));
          setLoading(false);
        },
      );
    }, 220);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q, setParams]);

  const empty = res && res.live.length + res.movies.length + res.series.length === 0;

  return (
    <div>
      <div className="page-head">
        <h1 className="h1">Search</h1>
      </div>
      <div className="pad-x">
        <label className="search-box search-big">
          <IconSearch />
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Channels, movies, series"
            aria-label="Search channels, movies and series"
            autoFocus={form !== 'tv'}
            enterKeyHint="search"
          />
        </label>
      </div>
      <div aria-live="polite" aria-busy={loading}>
        {error && <p className="notice error" style={{ marginTop: '1rem' }}>{error}</p>}
        {!q.trim() && <Empty title="Find anything">Type a channel, movie or series name. Results appear as you type.</Empty>}
        {empty && !loading && <Empty title={`Nothing found for "${q.trim()}"`}>Check the spelling, or it may be hidden by your filters.</Empty>}
        {loading && !res && <ResultsSkeleton />}
        {res && res.live.length > 0 && (
          <section className="search-group" aria-label="Live channels">
            <div className="row-title">
              <h2>Live</h2>
            </div>
            <div className="search-live">
              {res.live.map((ch) => (
                <button
                  key={ch.id}
                  type="button"
                  className="ch-row"
                  onClick={() => {
                    setZapList(res.live.map((c) => c.id));
                    writeLocal('anycast.lastChannel', ch.id);
                    navigate(`/play/live/${ch.id}`);
                  }}
                >
                  <LogoTile name={ch.name} logo={ch.logo} />
                  <span className="ch-main">
                    <span className="ch-top">
                      <span className="name">{ch.name}</span>
                      <span className="ch-num tabnum">{ch.number}</span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        {res && res.movies.length > 0 && (
          <section className="search-group" aria-label="Movies">
            <div className="row-title">
              <h2>Movies</h2>
            </div>
            <div className="poster-grid">
              {res.movies.map((m) => (
                <PosterCard key={m.id} kind="movie" item={m} />
              ))}
            </div>
          </section>
        )}
        {res && res.series.length > 0 && (
          <section className="search-group" aria-label="Series">
            <div className="row-title">
              <h2>Series</h2>
            </div>
            <div className="poster-grid">
              {res.series.map((s) => (
                <PosterCard key={s.id} kind="series" item={s} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="search-group" aria-hidden="true">
      <div className="row-title">
        <Skeleton w="4rem" />
      </div>
      <div className="poster-grid">
        {Array.from({ length: 6 }, (_, i) => (
          <PosterSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
