/** Shared browse screen for Movies and Series: Continue Watching, Favorites, category rows, virtualized poster grid. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { Category, Movie, Series } from '@anycast/shared';
import { useApp } from '../store/app';
import { call, cachedGet, errorMessage } from '../api/client';
import { remember, resolveItems, visibleCategories } from '../api/catalog';
import { useAsync, useElementWidth, useFormFactor, useInView, usePagedList } from '../lib/hooks';
import { readLocal, writeLocal } from '../lib/storage';
import { PosterCard } from '../components/cards';
import { Chips, Empty, Skeleton } from '../components/ui';
import { IconSearch } from '../components/Icons';
import { catLabel } from './Live';

type Kind = 'movie' | 'series';
const LIST = { movie: 'GET /api/movies', series: 'GET /api/series' } as const;

export function VodBrowse(props: { kind: Kind; title: string; continueRow: ReactNode }) {
  const { kind } = props;
  const form = useFormFactor();
  const rules = useApp((s) => s.hideRules);
  const version = useApp((s) => s.catalogVersion);
  const favIds = useApp((s) => s.favorites.filter((f) => f.kind === kind).sort((a, b) => b.addedAt - a.addedAt).map((f) => f.id).join(','));
  const cats = useAsync(() => visibleCategories(kind, rules), [kind, rules, version]);
  const hiddenSearch = useApp((s) => s.prefs.start.hiddenTabs.includes('search'));
  const [cat, setCat] = useState(() => readLocal(`anycast.cat.${kind}`) ?? 'home');
  const navigate = useNavigate();
  const pick = (id: string) => {
    setCat(id);
    writeLocal(`anycast.cat.${kind}`, id);
    window.scrollTo({ top: 0 });
  };
  const chips = useMemo(() => [{ id: 'home', label: 'Home' }, ...(cats.data ?? []).map((c) => ({ id: c.id, label: catLabel(c) }))], [cats.data]);
  useEffect(() => {
    if (cats.data && !chips.some((c) => c.id === cat)) setCat('home');
  }, [cats.data, chips, cat]);

  const favs = useAsync((signal) => (favIds ? resolveItems(kind, favIds.split(','), { signal }) : Promise.resolve([])), [favIds, kind, version]);

  return (
    <div>
      <div className="page-head">
        <h1 className="h1">{props.title}</h1>
        {form !== 'large' ? (
          hiddenSearch && <Link to="/search" className="icon-btn" aria-label="Search">
            <IconSearch />
          </Link>
        ) : (
          <label className="search-box">
            <IconSearch />
            <input
              aria-label={`Search ${props.title.toLowerCase()}`}
              placeholder={`Search ${props.title.toLowerCase()}`}
              onChange={(e) => e.target.value && navigate(`/search?q=${encodeURIComponent(e.target.value)}`)}
            />
            {form === 'large' && <kbd>/</kbd>}
          </label>
        )}
      </div>
      {cats.loading && !cats.data ? (
        <div className="chips" aria-hidden="true">
          {[4, 6, 5, 5, 6].map((w, i) => (
            <Skeleton key={i} w={`${w}rem`} h="2.25rem" r="999px" style={{ flex: 'none' }} />
          ))}
        </div>
      ) : (
        <Chips label="Categories" items={chips} value={cat} onChange={pick} />
      )}

      {cat === 'home' ? (
        <>
          {props.continueRow}
          {favIds && (
            <Shelf title="Favorites" kind={kind} items={(favs.data ?? []) as (Movie | Series)[]} loading={favs.loading && !favs.data} />
          )}
          {(cats.data ?? []).slice(0, 14).map((c) => (
            <CategoryShelf key={c.id} kind={kind} cat={c} onAll={() => pick(c.id)} version={version} />
          ))}
          {cats.data?.length === 0 && (
            <Empty title={`No ${props.title.toLowerCase()}`}>
              <p>Everything is hidden by your filters, or your provider has none. Check Settings › Filters.</p>
            </Empty>
          )}
        </>
      ) : (
        <PosterGrid kind={kind} categoryId={cat} version={version} />
      )}
    </div>
  );
}

export function Shelf(props: { title: string; kind: Kind; items: (Movie | Series)[]; loading?: boolean; action?: ReactNode }) {
  if (!props.loading && props.items.length === 0) return null;
  return (
    <section aria-label={props.title}>
      <div className="row-title">
        <h2>{props.title}</h2>
        {props.action}
      </div>
      <div className="shelf" data-nav-row={`shelf-${props.title}`}>
        {props.loading
          ? Array.from({ length: 8 }, (_, i) => <PosterSkeleton key={i} />)
          : props.items.map((it) => <PosterCard key={it.id} kind={props.kind} item={it} />)}
      </div>
    </section>
  );
}

function CategoryShelf(props: { kind: Kind; cat: Category; onAll: () => void; version: number }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const data = useAsync(
    async () => {
      if (!inView) return null;
      const res = await cachedGet(LIST[props.kind], { query: { categoryId: props.cat.id, offset: 0, limit: 20 } }, 120_000);
      remember(props.kind, res.items);
      return res;
    },
    [inView, props.cat.id, props.version],
  );
  if (data.data && data.data.items.length === 0) return null;
  return (
    <div ref={ref}>
      <Shelf
        title={catLabel(props.cat)}
        kind={props.kind}
        items={data.data?.items ?? []}
        loading={!data.data}
        action={
          data.data && data.data.total > data.data.items.length ? (
            <button type="button" onClick={props.onAll}>
              See all {data.data.total}
            </button>
          ) : undefined
        }
      />
    </div>
  );
}

export function PosterSkeleton() {
  return (
    <div aria-hidden="true">
      <Skeleton h="auto" r="0.625rem" style={{ aspectRatio: '2 / 3' }} />
      <Skeleton w="80%" h="0.75rem" style={{ marginTop: '0.625rem' }} />
      <Skeleton w="45%" h="0.625rem" style={{ marginTop: '0.375rem' }} />
    </div>
  );
}

function PosterGrid(props: { kind: Kind; categoryId: string; version: number }) {
  const form = useFormFactor();
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const ref = useRef<HTMLDivElement | null>(null);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const gap = (form === 'phone' ? 0.75 : 1) * rem;
  const inner = form === 'phone' ? width - 2.5 * rem : width;
  const target = (form === 'phone' ? 7 : form === 'tv' ? 9 : 10) * rem;
  const cols = Math.max(form === 'phone' ? 3 : 2, Math.floor((inner + gap) / (target + gap)));
  const colW = (inner - gap * (cols - 1)) / cols;
  const rowH = colW * 1.5 + 3 * rem + gap;
  const list = usePagedList<Movie | Series>(
    `${props.kind}|${props.categoryId}|${props.version}`,
    async (offset, limit, signal) => {
      const res = await call(LIST[props.kind], { query: { categoryId: props.categoryId, offset, limit }, signal });
      remember(props.kind, res.items);
      return res;
    },
    60,
  );
  const [margin, setMargin] = useState(0);
  useEffect(() => setMargin(ref.current ? ref.current.getBoundingClientRect().top + window.scrollY : 0), [width]);
  const total = list.total;
  const v = useWindowVirtualizer({
    count: total === null ? 3 : Math.ceil(total / cols),
    estimateSize: () => rowH,
    overscan: 3,
    scrollMargin: margin,
  });
  useEffect(() => v.measure(), [rowH, v]);
  const items = v.getVirtualItems();
  useEffect(() => {
    if (items.length) list.ensure(items[0]!.index * cols, (items[items.length - 1]!.index + 4) * cols);
  }, [items, cols, list]);

  if (list.error) return <Empty title="Couldn't load this category">{errorMessage(list.error)}</Empty>;
  if (total === 0) return <Empty title="Nothing here">This category is empty.</Empty>;
  return (
    <div
      ref={(el) => {
        ref.current = el;
        measure(el);
      }}
      className="grid-wrap"
      style={{ height: v.getTotalSize(), marginTop: '0.5rem' }}
      role="list"
    >
      {width > 0 &&
        items.map((row) => (
          <div key={row.key} className="poster-grid-row" style={{ top: row.start - margin, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} data-nav-row={`pg${row.index}`}>
            {Array.from({ length: cols }, (_, c) => {
              const i = row.index * cols + c;
              if (total !== null && i >= total) return null;
              const it = list.get(i);
              return it ? (
                <div role="listitem" key={c}>
                  <PosterCard kind={props.kind} item={it} />
                </div>
              ) : (
                <PosterSkeleton key={c} />
              );
            })}
          </div>
        ))}
    </div>
  );
}
