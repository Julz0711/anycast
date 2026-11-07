/** Live TV: Simple (virtualized channel list) or Extended (guide grid), per-form-factor layout preference. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Category, EpgProgram, LiveChannelWithNow } from '@anycast/shared';
import { useApp, useIsFavorite } from '../store/app';
import { setPref, setZapList, toggleFavorite } from '../store/actions';
import { call, errorMessage } from '../api/client';
import { remember, resolveItems, visibleCategories } from '../api/catalog';
import { useAsync, useElementWidth, useFormFactor, useNow, usePagedList, type PagedList } from '../lib/hooks';
import { writeLocal, readLocal } from '../lib/storage';
import { fmtClock, fmtRange } from '../lib/time';
import { ChannelRow } from '../components/cards';
import { Empty, LogoTile, ProgressBar, Segmented, Skeleton } from '../components/ui';
import { CategoryChips } from '../components/CategoryChips';
import { GuideGrid, type ChannelSource } from '../components/GuideGrid';
import { IconListAdd, IconStar } from '../components/Icons';
import { SearchButton } from '../components/PageHead';
import { openAddToList } from '../store/lists';
import type { FormFactor } from '../lib/device';
import { prefetchPlayer } from '../player/prefetch';
import { whenUnlocked } from '../store/parental';

const ListEditorSheet = lazy(() => import('../components/ListEditor').then((m) => ({ default: m.ListEditorSheet })));
const LIST_PREFIX = 'list:';
const menuFor = (ch: LiveChannelWithNow) => openAddToList(ch);

const LAYOUT_KEY = { phone: 'layoutPhone', large: 'layoutLarge', tv: 'layoutTv' } as const;
export const catLabel = (c: Category) => c.name.replace(/\s*\|\s*/, ' · ');

export function LiveScreen() {
  const form = useFormFactor();
  const live = useApp((s) => s.prefs.live);
  const rules = useApp((s) => s.hideRules);
  const version = useApp((s) => s.catalogVersion);
  const favIds = useApp((s) => s.favorites.filter((f) => f.kind === 'live').map((f) => f.id).join(','));
  const layout = live[LAYOUT_KEY[form]];
  const navigate = useNavigate();
  const [cat, setCat] = useState(() => readLocal('anycast.liveCat') ?? 'all');
  const lists = useApp((s) => s.lists);
  const listsLoaded = useApp((s) => s.listsLoaded);
  const list = cat.startsWith(LIST_PREFIX) ? lists.find((l) => l.id === cat.slice(LIST_PREFIX.length)) : undefined;
  const listKey = list ? `${list.id}:${list.channelIds.join(',')}` : '';
  const [editing, setEditing] = useState(false);
  // every channel of the open list (lists load whole), for zapping in the list's order
  const listChannels = useRef<LiveChannelWithNow[]>([]);
  const cats = useAsync(() => visibleCategories('live', rules), [rules, version]);

  const favs = useAsync(
    (signal) => (favIds ? resolveItems('live', favIds.split(','), { signal, fresh: true }) : Promise.resolve([])),
    [favIds, version, live.mergeVariants],
  );
  const favChannels = ((favs.data ?? []) as LiveChannelWithNow[]).filter((c) => !live.guideOnlyWithEpg || c.hasEpg);

  const onlyEpg = live.guideOnlyWithEpg;
  const listChips = lists.map((l) => `${l.id}\u0000${l.name}`).join('\u0001');
  const lead = useMemo(
    () => [
      { id: 'all', label: 'All' },
      ...(favIds ? [{ id: 'fav', label: 'Favorites' }] : []),
      // the user's own lists, right after Favorites and before the provider's groups
      ...lists.map((l) => ({ id: LIST_PREFIX + l.id, label: l.name })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [favIds, listChips],
  );
  const catChips = useMemo(() => (cats.data ?? []).map((c) => ({ id: c.id, label: catLabel(c), locked: c.locked })), [cats.data]);
  const chips = useMemo(() => [...lead, ...catChips], [lead, catChips]);
  const catNames = useMemo(() => new Map(catChips.map((c) => [c.id, c.label])), [catChips]);
  useEffect(() => {
    if (cats.data && listsLoaded && !chips.some((c) => c.id === cat)) setCat('all');
  }, [chips, cat, cats.data, listsLoaded]);
  const pick = (id: string) => {
    setCat(id);
    writeLocal('anycast.liveCat', id);
  };

  const paged = usePagedList<LiveChannelWithNow>(
    `${cat}|${version}|${cat === 'fav' ? favIds : ''}|${listKey}|${onlyEpg ? 'epg' : ''}|${live.mergeVariants ? 'merge' : ''}`,
    async (offset, limit, signal) => {
      if (cat.startsWith(LIST_PREFIX)) {
        const id = cat.slice(LIST_PREFIX.length);
        if (!useApp.getState().lists.some((l) => l.id === id)) return { items: [], total: 0 };
        const all = await call('GET /api/lists/:id/channels', { params: { id }, signal });
        remember('live', all);
        const items = onlyEpg ? all.filter((c) => c.hasEpg) : all;
        listChannels.current = items;
        return { items: items.slice(offset, offset + limit), total: items.length };
      }
      if (cat === 'fav') {
        const all = (await resolveItems('live', favIds ? favIds.split(',') : [], { signal, fresh: true })) as LiveChannelWithNow[];
        const items = onlyEpg ? all.filter((c) => c.hasEpg) : all;
        return { items: items.slice(offset, offset + limit), total: items.length };
      }
      const res = await call('GET /api/live', { query: { categoryId: cat === 'all' ? undefined : cat, offset, limit, hasEpg: onlyEpg ? '1' : undefined }, signal });
      remember('live', res.items);
      return res;
    },
    100,
  );
  const source: PagedList<LiveChannelWithNow> = paged;

  const open = useCallback(
    (ch: LiveChannelWithNow | string, at?: number) => {
      const id = typeof ch === 'string' ? ch : ch.id;
      if (typeof ch !== 'string' && ch.locked) return whenUnlocked(true, () => open(id, at));
      // zapping follows what the channel was opened from: the open list in its order, or the loaded group
      setZapList((cat.startsWith(LIST_PREFIX) ? listChannels.current : source.loaded()).map((c) => c.id));
      writeLocal('anycast.lastChannel', id);
      navigate(at ? `/play/live/${id}?at=${at}` : `/play/live/${id}`);
    },
    [navigate, source, cat],
  );

  return (
    <div className="live-screen">
      <div className="live-top">
        <div className="page-head page-head--tools">
          <h1 className="h1">Live TV</h1>
          <div className="head-tools">
            <Segmented
              label="Live TV layout"
              value={layout}
              options={[
                { value: 'simple', label: 'Simple' },
                { value: 'extended', label: 'Extended' },
              ]}
              onChange={(v) => setPref('live', { [LAYOUT_KEY[form]]: v })}
            />
            <button
              type="button"
              className="chip epg-filter"
              aria-pressed={onlyEpg}
              title="Show only channels with a programme guide"
              onClick={() => setPref('live', { guideOnlyWithEpg: !onlyEpg })}
            >
              With guide
            </button>
            {form === 'phone' && <SearchButton />}
          </div>
        </div>
        {layout === 'extended' && form !== 'phone' && <Hero source={source} favChannels={list ? [] : favChannels} onPlay={open} />}
        {cats.loading && !cats.data ? (
          <div className="chips" aria-hidden="true">
            {[4, 5, 4, 6, 5].map((w, i) => (
              <Skeleton key={i} w={`${w}rem`} h="2.25rem" r="999px" style={{ flex: 'none' }} />
            ))}
          </div>
        ) : (
          <CategoryChips kind="live" label="Channel groups" noun="groups" lead={lead} categories={catChips} value={cat} onChange={pick} />
        )}
        {list && (
          <div className="list-bar">
            <span className="lb-count tabnum">
              {list.channelIds.length} {list.channelIds.length === 1 ? 'channel' : 'channels'} · your order
            </span>
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)} aria-label={`Edit list ${list.name}`}>
              Edit
            </button>
          </div>
        )}
        {editing && list && (
          <Suspense fallback={null}>
            <ListEditorSheet listId={list.id} onClose={() => setEditing(false)} />
          </Suspense>
        )}
      </div>
      {source.error ? (
        <Empty title="Couldn't load channels">
          <p>{errorMessage(source.error)}</p>
        </Empty>
      ) : source.total === 0 ? (
        <Empty title={cat === 'fav' ? 'No favorite channels yet' : list && !list.channelIds.length ? `${list.name} is empty` : 'No channels here'}>
          <p>
            {list && !list.channelIds.length
              ? 'Add channels with the ⋯ button on a channel (or right-click / long-press it), or from the player.'
              : onlyEpg
              ? 'No channel here has guide data. Turn off "Only channels with a guide" to see them all.'
              : cat === 'fav'
                ? 'Open a channel and tap the star to add it.'
                : 'Everything in this group is hidden by your filters, or the group is empty.'}
          </p>
        </Empty>
      ) : layout === 'extended' ? (
        <GuideGrid source={source as ChannelSource} form={form} onPlay={open} onSelect={heroSelect} onMenu={menuFor} />
      ) : (
        <SimpleList source={source} favorites={cat === 'all' ? favChannels : []} form={form} onOpen={open} catNames={catNames} />
      )}
    </div>
  );
}

/* ---------- hero (Extended, large screens) ---------- */
type HeroSel = { ch: LiveChannelWithNow; p: EpgProgram | null };
let heroListener: ((s: HeroSel) => void) | null = null;
const heroSelect = (ch: LiveChannelWithNow, p: EpgProgram | null) => heroListener?.({ ch, p });

function Hero(props: { source: ChannelSource & { total: number | null }; favChannels: LiveChannelWithNow[]; onPlay: (ch: LiveChannelWithNow, at?: number) => void }) {
  const [sel, setSel] = useState<HeroSel | null>(null);
  const now = useNow(30_000);
  useEffect(() => {
    heroListener = setSel;
    return () => {
      heroListener = null;
    };
  }, []);
  const fallback = props.favChannels[0] ?? props.source.get(0);
  const ch = sel?.ch ?? fallback;
  const p = sel?.p ?? ch?.now ?? null;
  const fav = useIsFavorite('live', ch?.id ?? '');
  if (!ch) {
    return (
      <div className="hero" aria-hidden="true">
        <Skeleton w="25rem" h="14rem" r="0.875rem" style={{ flex: 'none' }} />
        <div className="hero-info" style={{ gap: '0.75rem' }}>
          <Skeleton w="40%" h="0.875rem" />
          <Skeleton w="70%" h="1.5rem" />
        </div>
      </div>
    );
  }
  const isNow = !!p && p.start <= now && p.end > now;
  const isPast = !!p && p.end <= now;
  const archive = ch.archiveDays > 0 && !!p && p.start >= now - ch.archiveDays * 86_400_000;
  return (
    <section className="hero" aria-label="Selected programme">
      <div className="hero-preview">
        <LogoTile name={ch.name} logo={ch.logo} locked={ch.locked} />
        {isNow && <span className="tag">LIVE</span>}
      </div>
      <div className="hero-info">
        {p ? (
          <>
            <div className="hero-meta tabnum">
              {ch.number} · {ch.name} · {fmtRange(p.start, p.end)}
            </div>
            <div className="hero-title">{p.title}</div>
            {p.description && <p className="hero-desc">{p.description}</p>}
          </>
        ) : (
          // no guide: the channel itself is the subject
          <>
            <div className="hero-meta tabnum">
              {[`No. ${ch.number}`, ch.quality, ch.variants ? `${ch.variants + 1} versions` : null, ch.archiveDays > 0 ? `Catch-up ${ch.archiveDays} ${ch.archiveDays === 1 ? 'day' : 'days'}` : null].filter(Boolean).join(' · ')}
            </div>
            <div className="hero-title">{ch.name}</div>
            <p className="hero-desc muted">This channel has no programme guide. It plays live.</p>
          </>
        )}
        {isNow && p && <ProgressBar value={(now - p.start) / (p.end - p.start)} />}
        <div className="actions">
          {isPast ? (
            archive ? (
              <button type="button" className="btn btn-primary" onClick={() => props.onPlay(ch, p!.start)} onMouseEnter={prefetchPlayer}>
                Play from {fmtClock(p!.start)}
              </button>
            ) : (
              <span className="muted" style={{ alignSelf: 'center', fontSize: '0.875rem' }}>
                No archive on this channel
              </span>
            )
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => props.onPlay(ch)} onMouseEnter={prefetchPlayer}>
              Watch live
            </button>
          )}
          {isNow && ch.archiveDays > 0 && p && (
            <button type="button" className="btn" onClick={() => props.onPlay(ch, p.start)}>
              From start
            </button>
          )}
          <button type="button" className={`btn${fav ? ' on' : ''}`} onClick={() => void toggleFavorite('live', ch.id)} aria-pressed={fav}>
            <IconStar filled={fav} /> {fav ? 'Favorite' : 'Add favorite'}
          </button>
          <button type="button" className="btn" onClick={() => openAddToList(ch)}>
            <IconListAdd /> Add to list
          </button>
        </div>
      </div>
    </section>
  );
}

/* ---------- simple list ---------- */
function SimpleList(props: { source: PagedList<LiveChannelWithNow>; favorites: LiveChannelWithNow[]; form: FormFactor; onOpen: (id: string) => void; catNames: Map<string, string> }) {
  const { source, form } = props;
  const now = useNow(30_000);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [measureRef, width] = useElementWidth<HTMLDivElement>();
  const density = useApp((s) => s.prefs.appearance.density);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const cols = form === 'phone' ? 1 : Math.max(1, Math.floor(width / (24 * rem)));
  const rowH = Math.round((density === 'compact' ? 4.25 : 5.25) * rem + (form === 'phone' ? 0 : 1.25 * rem));
  const total = source.total ?? 0;
  const rows = Math.ceil(total / cols);
  const [margin, setMargin] = useState(0);
  useEffect(() => setMargin(listRef.current?.offsetTop ?? 0), [props.favorites.length, width]);

  const v = useVirtualizer({
    count: source.total === null ? 8 : rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 5,
    scrollMargin: margin,
  });
  useEffect(() => v.measure(), [rowH, cols, v]);
  const items = v.getVirtualItems();
  useEffect(() => {
    if (items.length) source.ensure(items[0]!.index * cols, (items[items.length - 1]!.index + 6) * cols);
  }, [items, cols, source]);

  return (
    <div className="live-scroll" ref={scrollRef}>
      <div ref={measureRef}>
        {props.favorites.length > 0 && (
          <section aria-label="Favorite channels">
            <h2 className="label" style={{ padding: form === 'phone' ? '0.25rem var(--gutter) 0.5rem' : '0.25rem 0.75rem 0.5rem' }}>
              Favorites
            </h2>
            <div className="fav-row" data-nav-row="favs" style={form === 'phone' ? undefined : { padding: '0.25rem 0.75rem 0.75rem' }}>
              {props.favorites.map((ch) => (
                <button key={ch.id} type="button" className="fav-tile" onClick={() => props.onOpen(ch.id)} onMouseEnter={prefetchPlayer}>
                  <LogoTile name={ch.name} logo={ch.logo} locked={ch.locked} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>
                      {ch.name}
                    </span>
                    <span className="ellipsis ch-now" style={{ display: 'block' }}>
                      {ch.now?.title ?? (ch.hasEpg ? '—' : (props.catNames.get(ch.categoryId) ?? '—'))}
                    </span>
                    {ch.now && (
                      <span style={{ display: 'block', marginTop: '0.375rem' }}>
                        <ProgressBar value={(now - ch.now.start) / (ch.now.end - ch.now.start)} />
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
            <h2 className="label" style={{ padding: form === 'phone' ? '1rem var(--gutter) 0.25rem' : '1rem 0.75rem 0.25rem' }}>
              Channels
            </h2>
          </section>
        )}
        <div className="live-list" ref={listRef} style={{ height: v.getTotalSize() }} role="list" aria-label="Channels">
          {items.map((row) => (
            <div
              key={row.key}
              className="live-list-row"
              style={{ top: row.start - margin, height: rowH, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              role="presentation"
            >
              {Array.from({ length: cols }, (_, c) => {
                const i = row.index * cols + c;
                if (source.total !== null && i >= source.total) return <div key={c} />;
                const ch = source.get(i);
                return ch ? (
                  <div role="listitem" key={c} className="ch-cell">
                    <ChannelRow ch={ch} now={now} onOpen={props.onOpen} showNext={form !== 'phone'} category={props.catNames.get(ch.categoryId)} onMenu={menuFor} />
                  </div>
                ) : (
                  <RowSkeleton key={c} />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="ch-row" aria-hidden="true">
      <Skeleton w="3.25rem" h="3.25rem" r="0.875rem" style={{ flex: 'none' }} />
      <div className="ch-main" style={{ display: 'grid', gap: '0.5rem' }}>
        <Skeleton w="55%" h="0.875rem" />
        <Skeleton w="80%" h="0.75rem" />
      </div>
    </div>
  );
}
