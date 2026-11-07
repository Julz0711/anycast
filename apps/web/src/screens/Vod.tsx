/** Shared browse screen for Movies and Series: Continue Watching, Favorites, category rows, virtualized poster grid. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { Category, Movie, Series, VodQuery, VodSort } from '@anycast/shared';
import { useApp } from '../store/app';
import { call, cachedGet, errorMessage } from '../api/client';
import { remember, resolveItems, visibleCategories } from '../api/catalog';
import { useAsync, useElementWidth, useFormFactor, useInView, usePagedList } from '../lib/hooks';
import { readLocal, writeLocal } from '../lib/storage';
import { PosterCard } from '../components/cards';
import { Empty, Skeleton } from '../components/ui';
import { CategoryChips } from '../components/CategoryChips';
import { SearchButton } from '../components/PageHead';
import { IconSearch, IconSwipe } from '../components/Icons';
import { catLabel } from './Live';

type Kind = 'movie' | 'series';
/** "home" is the overview of rows (the id predates its label); "all" is every category in one grid */
const HOME = { id: 'home', label: 'Overview' };
const ALL = 'all';
const LIST = { movie: 'GET /api/movies', series: 'GET /api/series' } as const;
const NOUN = { movie: 'movies', series: 'series' } as const;

/** Sort and filters of the poster grid, kept per kind on this device. */
export interface GridView {
  sort: VodSort;
  year: YearRange;
  rating: 0 | 6 | 7 | 8;
}
type YearRange = 'any' | '2020' | '2010' | '2000' | 'older';
const DEFAULT_VIEW: GridView = { sort: 'added', year: 'any', rating: 0 };
const SORTS: { id: VodSort; label: string }[] = [
  { id: 'added', label: 'Recently added' },
  { id: 'name', label: 'A–Z' },
  { id: 'year', label: 'Newest first' },
  { id: 'rating', label: 'Top rated' },
];
const YEARS: { id: YearRange; label: string; from?: number; to?: number }[] = [
  { id: 'any', label: 'Any year' },
  { id: '2020', label: '2020 and later', from: 2020 },
  { id: '2010', label: '2010s', from: 2010, to: 2019 },
  { id: '2000', label: '2000s', from: 2000, to: 2009 },
  { id: 'older', label: 'Before 2000', to: 1999 },
];
const RATINGS: { id: GridView['rating']; label: string }[] = [
  { id: 0, label: 'Any rating' },
  { id: 6, label: 'Rated 6+' },
  { id: 7, label: 'Rated 7+' },
  { id: 8, label: 'Rated 8+' },
];

export function readView(kind: Kind): GridView {
  try {
    const v = JSON.parse(readLocal(`anycast.view.${kind}`) ?? '{}') as Partial<GridView>;
    return {
      sort: SORTS.some((x) => x.id === v.sort) ? v.sort! : DEFAULT_VIEW.sort,
      year: YEARS.some((x) => x.id === v.year) ? v.year! : DEFAULT_VIEW.year,
      rating: RATINGS.some((x) => x.id === v.rating) ? v.rating! : DEFAULT_VIEW.rating,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

/** The list query of a grid view. */
export function viewQuery(v: GridView): Pick<VodQuery, 'sort' | 'yearFrom' | 'yearTo' | 'minRating'> {
  const y = YEARS.find((x) => x.id === v.year);
  return {
    ...(v.sort !== 'added' ? { sort: v.sort } : {}),
    ...(y?.from ? { yearFrom: y.from } : {}),
    ...(y?.to ? { yearTo: y.to } : {}),
    ...(v.rating ? { minRating: v.rating } : {}),
  };
}

export function VodBrowse(props: { kind: Kind; title: string; continueRow: ReactNode; extraRows?: ReactNode }) {
  const { kind } = props;
  const form = useFormFactor();
  const rules = useApp((s) => s.hideRules);
  const version = useApp((s) => s.catalogVersion);
  const favIds = useApp((s) => s.favorites.filter((f) => f.kind === kind).sort((a, b) => b.addedAt - a.addedAt).map((f) => f.id).join(','));
  const cats = useAsync(() => visibleCategories(kind, rules), [kind, rules, version]);
  const [cat, setCat] = useState(() => readLocal(`anycast.cat.${kind}`) ?? 'home');
  const navigate = useNavigate();
  const pick = (id: string) => {
    setCat(id);
    writeLocal(`anycast.cat.${kind}`, id);
    window.scrollTo({ top: 0 });
  };
  const [view, setViewState] = useState(() => readView(kind));
  const setView = (v: GridView) => {
    setViewState(v);
    writeLocal(`anycast.view.${kind}`, JSON.stringify(v));
  };
  const lead = useMemo(() => [HOME, { id: ALL, label: kind === 'movie' ? 'All movies' : 'All series' }], [kind]);
  const catChips = useMemo(() => (cats.data ?? []).map((c) => ({ id: c.id, label: catLabel(c), locked: c.locked })), [cats.data]);
  const chips = useMemo(() => [...lead, ...catChips], [lead, catChips]);
  useEffect(() => {
    if (cats.data && !chips.some((c) => c.id === cat)) setCat('home');
  }, [cats.data, chips, cat]);

  const favs = useAsync((signal) => (favIds ? resolveItems(kind, favIds.split(','), { signal, fresh: true }) : Promise.resolve([])), [favIds, kind, version]);

  return (
    <div>
      <div className="page-head">
        <h1 className="h1">{props.title}</h1>
        <div className="head-actions">
          {form === 'phone' ? (
            <Link to={`/swipe?kind=${kind}`} className="icon-btn" aria-label={`Swipe through ${NOUN[kind]}`}>
              <IconSwipe />
            </Link>
          ) : (
            <Link to={`/swipe?kind=${kind}`} className="btn">
              <IconSwipe /> Swipe
            </Link>
          )}
          {form !== 'large' ? (
            <SearchButton />
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
      </div>
      {cats.loading && !cats.data ? (
        <div className="chips" aria-hidden="true">
          {[4, 6, 5, 5, 6].map((w, i) => (
            <Skeleton key={i} w={`${w}rem`} h="2.25rem" r="999px" style={{ flex: 'none' }} />
          ))}
        </div>
      ) : (
        <CategoryChips kind={kind} label="Categories" noun="categories" lead={lead} categories={catChips} value={cat} onChange={pick} />
      )}

      {cat === 'home' ? (
        <>
          {props.continueRow}
          {props.extraRows}
          <RecentShelf
            kind={kind}
            version={version}
            onAll={() => {
              setView({ ...view, sort: 'added' });
              pick(ALL);
            }}
          />
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
        <>
          <GridTools kind={kind} view={view} onChange={setView} />
          <PosterGrid kind={kind} categoryId={cat === ALL ? undefined : cat} version={version} view={view} onReset={() => setView(DEFAULT_VIEW)} />
        </>
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

/** The newest additions over every category. */
function RecentShelf(props: { kind: Kind; version: number; onAll: () => void }) {
  const data = useAsync(async () => {
    const res = await cachedGet(LIST[props.kind], { query: { offset: 0, limit: 20 } }, 120_000);
    remember(props.kind, res.items);
    return res;
  }, [props.kind, props.version]);
  if (data.data && data.data.items.length === 0) return null;
  return (
    <Shelf
      title="Recently added"
      kind={props.kind}
      items={data.data?.items ?? []}
      loading={!data.data}
      action={
        <button type="button" onClick={props.onAll}>
          See all
        </button>
      }
    />
  );
}

function GridTools(props: { kind: Kind; view: GridView; onChange: (v: GridView) => void }) {
  const { view } = props;
  const changed = view.year !== 'any' || view.rating !== 0;
  return (
    <div className="vod-tools" role="group" aria-label={`Sort and filter ${NOUN[props.kind]}`} data-nav-row="vod-tools">
      <select className="input vod-select" aria-label="Sort by" value={view.sort} onChange={(e) => props.onChange({ ...view, sort: e.target.value as VodSort })}>
        {SORTS.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </select>
      <select className={`input vod-select${view.year !== 'any' ? ' on' : ''}`} aria-label="Year" value={view.year} onChange={(e) => props.onChange({ ...view, year: e.target.value as YearRange })}>
        {YEARS.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </select>
      <select
        className={`input vod-select${view.rating ? ' on' : ''}`}
        aria-label="Rating"
        value={view.rating}
        onChange={(e) => props.onChange({ ...view, rating: Number(e.target.value) as GridView['rating'] })}
      >
        {RATINGS.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </select>
      {changed && (
        <button type="button" className="btn small" onClick={() => props.onChange({ ...view, year: 'any', rating: 0 })}>
          Clear filters
        </button>
      )}
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

function PosterGrid(props: { kind: Kind; categoryId: string | undefined; version: number; view: GridView; onReset: () => void }) {
  const q = viewQuery(props.view);
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
    `${props.kind}|${props.categoryId ?? ''}|${props.version}|${JSON.stringify(q)}`,
    async (offset, limit, signal) => {
      const res = await call(LIST[props.kind], { query: { ...(props.categoryId ? { categoryId: props.categoryId } : {}), ...q, offset, limit }, signal });
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
  const filtered = props.view.year !== 'any' || props.view.rating !== 0;
  if (total === 0) {
    return filtered ? (
      <Empty title="Nothing matches these filters">
        <button type="button" className="btn" onClick={props.onReset}>
          Clear filters
        </button>
      </Empty>
    ) : (
      <Empty title="Nothing here">This category is empty.</Empty>
    );
  }
  return (
    <div
      ref={(el) => {
        ref.current = el;
        measure(el);
      }}
      className="grid-wrap"
      style={{ height: v.getTotalSize(), marginTop: '0.5rem' }}
      role="list"
      aria-label={total !== null ? `${total.toLocaleString()} ${NOUN[props.kind]}` : undefined}
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
