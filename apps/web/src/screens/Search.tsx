/** One box, instant results grouped Live / Movies / Series. Debounced; stale requests are aborted. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { isOffAir, type SearchResults } from '@anycast/shared';
import { call, errorMessage, isAbort } from '../api/client';
import { remember, visibleCategories } from '../api/catalog';
import { setZapList } from '../store/actions';
import { useAsync, useFormFactor, useNow } from '../lib/hooks';
import { useApp } from '../store/app';
import { writeLocal } from '../lib/storage';
import { ChannelRow, PosterCard } from '../components/cards';
import { Empty, Skeleton } from '../components/ui';
import { catLabel } from './Live';
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
  const now = useNow(30_000);
  const rules = useApp((s) => s.hideRules);
  const version = useApp((s) => s.catalogVersion);
  /** shown under a channel without guide data */
  const cats = useAsync(() => visibleCategories('live', rules), [rules, version]);
  const hideOffAir = useApp((s) => s.prefs.live.hideOffAir);
  const [showOffAir, setShowOffAir] = useState(false);
  useEffect(() => setShowOffAir(false), [q]);
  const catNames = useMemo(() => new Map((cats.data ?? []).map((c) => [c.id, catLabel(c)])), [cats.data]);

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
  /** channels whose guide says nothing is on ("Sendepause") go out unless asked for */
  const offAir = res && hideOffAir && !showOffAir ? res.live.filter((c) => c.now && c.now.end > now && isOffAir(c.now.title)).length : 0;
  const live = res ? (offAir ? res.live.filter((c) => !(c.now && c.now.end > now && isOffAir(c.now.title))) : res.live) : [];

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
        {res && res.live.length > 0 && (live.length > 0 || offAir > 0) && (
          <section className="search-group" aria-label="Live channels">
            <div className="row-title">
              <h2>Live</h2>
            </div>
            <div className="search-live">
              {live.map((ch) => (
                <ChannelRow
                  key={ch.id}
                  ch={ch}
                  now={now}
                  showNext={form !== 'phone'}
                  category={catNames.get(ch.categoryId)}
                  onOpen={(id) => {
                    setZapList(live.map((c) => c.id));
                    writeLocal('anycast.lastChannel', id);
                    navigate(`/play/live/${id}`);
                  }}
                />
              ))}
            </div>
            {offAir > 0 && (
              <p className="search-offair muted">
                {offAir === 1 ? '1 channel' : `${offAir} channels`} off air right now{' '}
                <button type="button" className="link-btn" onClick={() => setShowOffAir(true)}>
                  Show
                </button>
              </p>
            )}
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
