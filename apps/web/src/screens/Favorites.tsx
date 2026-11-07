/**
 * Favorites: one place for every starred channel, movie and series, with a Live / Movies / Series switch.
 * Items come from GET /api/items by id (no paging through lists) and follow the favorites store, which
 * the SSE favorites event keeps in sync across devices. Last tab and sort order are remembered per device.
 */
import { useCallback, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import type { Favorite, LiveChannelWithNow, Movie, Series } from '@anycast/shared';
import { useApp } from '../store/app';
import { setZapList, toggleFavorite } from '../store/actions';
import { errorMessage } from '../api/client';
import { resolveItems, visibleCategories } from '../api/catalog';
import { useAsync, useFormFactor, useNow } from '../lib/hooks';
import { readLocal, writeLocal } from '../lib/storage';
import { ChannelRow, PosterCard } from '../components/cards';
import { Empty, Segmented, Skeleton } from '../components/ui';
import { IconStar } from '../components/Icons';
import { PosterSkeleton } from './Vod';
import { LibraryHead } from '../components/PageHead';
import { catLabel } from './Live';

type Tab = 'live' | 'movies' | 'series';
type Sort = 'recent' | 'az';
const TAB_KIND: Record<Tab, Favorite['kind']> = { live: 'live', movies: 'movie', series: 'series' };
const TAB_LABEL: Record<Tab, string> = { live: 'Live', movies: 'Movies', series: 'Series' };
const TAB_KEY = 'anycast.favTab';
const SORT_KEY = 'anycast.favSort';
const isTab = (t: unknown): t is Tab => t === 'live' || t === 'movies' || t === 'series';

const EMPTY: Record<Tab, { title: string; text: string }> = {
  live: { title: 'No favorite channels yet', text: 'Tap the star on a channel in Live TV, or in the player while you watch, and it will wait for you here.' },
  movies: { title: 'No favorite movies yet', text: 'Open a movie and tap Add favorite, or tap the star in the player, and it will wait for you here.' },
  series: { title: 'No favorite series yet', text: 'Open a series and tap Add favorite, or tap the star in the player while you watch an episode, and it will wait for you here.' },
};

/** /favorites: reopen the tab used last on this device. */
export function FavoritesIndex() {
  const last = readLocal(TAB_KEY);
  return <Navigate to={`/favorites/${isTab(last) ? last : 'live'}`} replace />;
}

export function FavoritesScreen() {
  const { tab: param } = useParams();
  const navigate = useNavigate();
  const version = useApp((s) => s.catalogVersion);
  const favorites = useApp((s) => s.favorites);
  const [sort, setSort] = useState<Sort>(() => (readLocal(SORT_KEY) === 'az' ? 'az' : 'recent'));

  // newest first; this is also the order of the ids we resolve
  const ids = useMemo(() => {
    const by = (k: Favorite['kind']) =>
      favorites
        .filter((f) => f.kind === k)
        .sort((a, b) => b.addedAt - a.addedAt)
        .map((f) => f.id);
    return { live: by('live'), movies: by('movie'), series: by('series') };
  }, [favorites]);
  const key = { live: ids.live.join(','), movies: ids.movies.join(','), series: ids.series.join(',') };

  // live rows refresh their now/next every couple of minutes
  const now = useNow(30_000);
  const slot = Math.floor(now / 120_000);
  const live = useAsync((signal) => (key.live ? resolveItems('live', key.live.split(','), { signal, fresh: true }) : Promise.resolve([])), [key.live, version, slot]);
  const movies = useAsync((signal) => (key.movies ? resolveItems('movie', key.movies.split(','), { signal }) : Promise.resolve([])), [key.movies, version]);
  const series = useAsync((signal) => (key.series ? resolveItems('series', key.series.split(','), { signal }) : Promise.resolve([])), [key.series, version]);
  const state = { live, movies, series };

  // Follow the store right away (an unfavorite removes the item before the refetch lands), in the chosen order.
  const lists = useMemo(() => {
    const arrange = <T extends { id: string; name: string }>(tab: Tab, data: T[] | undefined): T[] | undefined => {
      if (!data) return undefined;
      const byId = new Map(data.map((x) => [x.id, x]));
      const out = ids[tab].map((id) => byId.get(id)).filter((x): x is T => !!x);
      return sort === 'az' ? out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })) : out;
    };
    return {
      live: arrange('live', live.data as LiveChannelWithNow[] | undefined),
      movies: arrange('movies', movies.data as Movie[] | undefined),
      series: arrange('series', series.data as Series[] | undefined),
    };
  }, [ids, sort, live.data, movies.data, series.data]);

  if (!isTab(param)) return <Navigate to="/favorites" replace />;
  const tab = param;
  const pickTab = (t: Tab) => {
    writeLocal(TAB_KEY, t);
    navigate(`/favorites/${t}`, { replace: true });
  };
  const pickSort = (s: Sort) => {
    setSort(s);
    writeLocal(SORT_KEY, s);
  };
  const count = (t: Tab) => lists[t]?.length ?? ids[t].length;
  const cur = lists[tab];
  const err = state[tab].error;

  const sortSeg = (
    <Segmented
      label="Sort favorites"
      value={sort}
      options={[
        { value: 'recent', label: 'Recently added' },
        { value: 'az', label: 'A–Z' },
      ]}
      onChange={pickSort}
    />
  );

  return (
    <div className="fav-screen">
      <LibraryHead />
      <div className="fav-bar">
        <Segmented
          size="lg"
          autoFocus
          label="Favorites type"
          value={tab}
          options={(['live', 'movies', 'series'] as const).map((t) => ({ value: t, label: TAB_LABEL[t], count: count(t) }))}
          onChange={pickTab}
        />
        {sortSeg}
      </div>
      {err && !cur ? (
        <Empty title="Couldn't load favorites">
          <p>{errorMessage(err)}</p>
        </Empty>
      ) : ids[tab].length === 0 || cur?.length === 0 ? (
        <Empty title={EMPTY[tab].title}>
          <p>{ids[tab].length === 0 ? EMPTY[tab].text : 'Your favorites here are hidden by your filters, or your provider removed them.'}</p>
        </Empty>
      ) : tab === 'live' ? (
        <LiveFavorites items={cur as LiveChannelWithNow[] | undefined} skeletons={ids.live.length} now={now} />
      ) : (
        <PosterFavorites kind={TAB_KIND[tab] as 'movie' | 'series'} items={cur as (Movie | Series)[] | undefined} skeletons={ids[tab].length} />
      )}
    </div>
  );
}

function StarToggle(props: { kind: Favorite['kind']; id: string; name: string; className: string }) {
  return (
    <button
      type="button"
      className={props.className}
      aria-pressed="true"
      aria-label={`Remove ${props.name} from favorites`}
      title="Remove from favorites"
      onClick={() => void toggleFavorite(props.kind, props.id)}
    >
      <IconStar filled />
    </button>
  );
}

function LiveFavorites(props: { items: LiveChannelWithNow[] | undefined; skeletons: number; now: number }) {
  const form = useFormFactor();
  const navigate = useNavigate();
  const rules = useApp((s) => s.hideRules);
  const version = useApp((s) => s.catalogVersion);
  const cats = useAsync(() => visibleCategories('live', rules), [rules, version]);
  const catNames = useMemo(() => new Map((cats.data ?? []).map((c) => [c.id, catLabel(c)])), [cats.data]);
  const items = props.items;
  const open = useCallback(
    (id: string) => {
      setZapList((items ?? []).map((c) => c.id));
      writeLocal('anycast.lastChannel', id);
      navigate(`/play/live/${id}`);
    },
    [items, navigate],
  );
  if (!items) {
    return (
      <div className="fav-live" aria-hidden="true">
        {Array.from({ length: Math.min(props.skeletons, 8) }, (_, i) => (
          <div key={i} className="ch-row">
            <Skeleton w="3.25rem" h="3.25rem" r="0.875rem" style={{ flex: 'none' }} />
            <div className="ch-main" style={{ display: 'grid', gap: '0.5rem' }}>
              <Skeleton w="55%" h="0.875rem" />
              <Skeleton w="80%" h="0.75rem" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <ul className="fav-live" aria-label="Favorite channels">
      {items.map((ch) => (
        <li key={ch.id} className="fav-live-item" data-nav-row={`fav-${ch.id}`}>
          <ChannelRow ch={ch} now={props.now} onOpen={open} showNext={form !== 'phone'} category={catNames.get(ch.categoryId)} noFavMark />
          <StarToggle kind="live" id={ch.id} name={ch.name} className="fav-star" />
        </li>
      ))}
    </ul>
  );
}

function PosterFavorites(props: { kind: 'movie' | 'series'; items: (Movie | Series)[] | undefined; skeletons: number }) {
  if (!props.items) {
    return (
      <div className="poster-grid fav-grid" aria-hidden="true">
        {Array.from({ length: Math.min(props.skeletons, 12) }, (_, i) => (
          <PosterSkeleton key={i} />
        ))}
      </div>
    );
  }
  return (
    <ul className="poster-grid fav-grid" aria-label={props.kind === 'movie' ? 'Favorite movies' : 'Favorite series'}>
      {props.items.map((it) => (
        <li key={it.id} className="fav-poster">
          <PosterCard kind={props.kind} item={it} noBadge />
          <StarToggle kind={props.kind} id={it.id} name={it.name} className="fav-star on-art" />
        </li>
      ))}
    </ul>
  );
}
