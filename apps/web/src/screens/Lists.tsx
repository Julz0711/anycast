/**
 * Lists: every list of the profile as a tab. Watch Later comes first, then the user's movie and
 * series lists, then their channel lists (the same lists Live TV shows as chips). Lists come from
 * the store, which the SSE 'lists' and 'media-lists' events keep in sync across devices; the open
 * tab and the sort order are remembered per device.
 */
import { useCallback, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { CHANNEL_LIST_LIMITS, MEDIA_LIST_LIMITS, type ChannelList, type LiveChannelWithNow, type MediaList, type Movie, type Series } from '@anycast/shared';
import { useApp } from '../store/app';
import { setZapList } from '../store/actions';
import { createList, createMediaList, deleteMediaList, openAddToList, renameMediaList, toggleInMediaList } from '../store/lists';
import { call, errorMessage } from '../api/client';
import { remember, resolveItems } from '../api/catalog';
import { useAsync, useFormFactor, useNow } from '../lib/hooks';
import { readLocal, writeLocal } from '../lib/storage';
import { ChannelRow, PosterCard } from '../components/cards';
import { Empty, Segmented, Skeleton } from '../components/ui';
import { IconBookmark, IconClose, IconLive, IconMovie } from '../components/Icons';
import { Sheet } from '../components/lists';
import { ListEditorSheet } from '../components/ListEditor';
import { PosterSkeleton } from './Vod';
import '../theme/lists.css';

type Tab = { type: 'media'; list: MediaList } | { type: 'channels'; list: ChannelList };
type Sort = 'recent' | 'az';
const TAB_KEY = 'anycast.listsTab';
const SORT_KEY = 'anycast.listsSort';

const tabsOf = (media: MediaList[], channels: ChannelList[]): Tab[] => [
  ...media.map((list) => ({ type: 'media' as const, list })),
  ...channels.map((list) => ({ type: 'channels' as const, list })),
];
const countOf = (t: Tab) => (t.type === 'media' ? t.list.items.length : t.list.channelIds.length);

/** /lists: reopen the list used last on this device, or the first one (Watch Later). */
export function ListsIndex() {
  const media = useApp((s) => s.mediaLists);
  const channels = useApp((s) => s.lists);
  const loaded = useApp((s) => s.mediaListsLoaded && s.listsLoaded);
  if (!loaded) return <ListsSkeleton />;
  const tabs = tabsOf(media, channels);
  const last = readLocal(TAB_KEY);
  const pick = tabs.find((t) => t.list.id === last) ?? tabs[0];
  return pick ? <Navigate to={`/lists/${pick.list.id}`} replace /> : <ListsShell tabs={[]} />;
}

export function ListsScreen() {
  const { id } = useParams();
  const media = useApp((s) => s.mediaLists);
  const channels = useApp((s) => s.lists);
  const loaded = useApp((s) => s.mediaListsLoaded && s.listsLoaded);
  const tabs = useMemo(() => tabsOf(media, channels), [media, channels]);
  if (!loaded) return <ListsSkeleton />;
  const tab = tabs.find((t) => t.list.id === id);
  // a list deleted here or on another device: go to the first one
  if (!tab) return <Navigate to={tabs[0] ? `/lists/${tabs[0].list.id}` : '/lists'} replace />;
  return <ListsShell tabs={tabs} current={tab} />;
}

function ListsSkeleton() {
  return (
    <div className="lists-screen" aria-busy="true">
      <div className="page-head">
        <h1 className="h1">Lists</h1>
      </div>
      <div className="lt-tabs" aria-hidden="true">
        {[7, 5, 6].map((w, i) => (
          <Skeleton key={i} w={`${w}rem`} h="2.5rem" r="999px" style={{ flex: 'none' }} />
        ))}
      </div>
    </div>
  );
}

function ListsShell(props: { tabs: Tab[]; current?: Tab }) {
  const navigate = useNavigate();
  const form = useFormFactor();
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useState<Sort>(() => (readLocal(SORT_KEY) === 'az' ? 'az' : 'recent'));
  const cur = props.current;
  const open = (t: Tab) => {
    writeLocal(TAB_KEY, t.list.id);
    navigate(`/lists/${t.list.id}`, { replace: true });
  };
  const pickSort = (s: Sort) => {
    setSort(s);
    writeLocal(SORT_KEY, s);
  };
  return (
    <div className="lists-screen">
      <div className="page-head">
        <h1 className="h1">Lists</h1>
        <button type="button" className="btn" onClick={() => setCreating(true)}>
          + New list
        </button>
      </div>
      <div className="lt-tabs" role="tablist" aria-label="Your lists" data-nav-row="list-tabs">
        {props.tabs.map((t, i) => {
          const prev = props.tabs[i - 1];
          const Icon = t.type === 'channels' ? IconLive : t.list.builtin ? IconBookmark : IconMovie;
          return (
            <button
              key={t.list.id}
              type="button"
              role="tab"
              id={`lt-${t.list.id}`}
              aria-selected={t === cur}
              aria-controls="lt-panel"
              className={`lt-tab${prev && prev.type !== t.type ? ' lt-split' : ''}`}
              data-nav-autofocus={t === cur ? '' : undefined}
              onClick={() => open(t)}
            >
              <Icon className="ico" />
              <span className="lt-name">{t.list.name}</span>
              <span className="lt-count tabnum">{countOf(t)}</span>
            </button>
          );
        })}
      </div>
      {cur && (
        <div id="lt-panel" role="tabpanel" aria-labelledby={`lt-${cur.list.id}`}>
          {cur.type === 'media' ? (
            <MediaPanel key={cur.list.id} list={cur.list} sort={sort} sortControl={<SortControl sort={sort} onChange={pickSort} phone={form === 'phone'} />} />
          ) : (
            <ChannelPanel key={cur.list.id} list={cur.list} />
          )}
        </div>
      )}
      {creating && (
        <NewListSheet
          onClose={() => setCreating(false)}
          onMade={(listId) => {
            setCreating(false);
            writeLocal(TAB_KEY, listId);
            navigate(`/lists/${listId}`, { replace: true });
          }}
        />
      )}
    </div>
  );
}

function SortControl(props: { sort: Sort; onChange: (s: Sort) => void; phone: boolean }) {
  return (
    <Segmented
      label="Sort list"
      value={props.sort}
      options={[
        { value: 'recent', label: props.phone ? 'Recent' : 'Recently added' },
        { value: 'az', label: 'A–Z' },
      ]}
      onChange={props.onChange}
    />
  );
}

/* ---------------- movies and series ---------------- */

function MediaPanel(props: { list: MediaList; sort: Sort; sortControl: React.ReactNode }) {
  const { list } = props;
  const version = useApp((s) => s.catalogVersion);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState(false);
  const movieKey = list.items.filter((x) => x.kind === 'movie').map((x) => x.id).join(',');
  const seriesKey = list.items.filter((x) => x.kind === 'series').map((x) => x.id).join(',');
  const movies = useAsync((signal) => (movieKey ? resolveItems('movie', movieKey.split(','), { signal }) : Promise.resolve([] as Movie[])), [movieKey, version]);
  const series = useAsync((signal) => (seriesKey ? resolveItems('series', seriesKey.split(','), { signal }) : Promise.resolve([] as Series[])), [seriesKey, version]);

  // follow the store right away (a removal drops the poster before any refetch), newest first or A–Z
  const items = useMemo(() => {
    if (!movies.data || !series.data) return undefined;
    const m = new Map(movies.data.map((x) => [x.id, x]));
    const s = new Map(series.data.map((x) => [x.id, x]));
    const out = [...list.items]
      .reverse()
      .map((x) => {
        const item = x.kind === 'movie' ? m.get(x.id) : s.get(x.id);
        return item ? { kind: x.kind, item } : null;
      })
      .filter((x): x is { kind: 'movie' | 'series'; item: Movie | Series } => !!x);
    return props.sort === 'az' ? out.sort((a, b) => a.item.name.localeCompare(b.item.name, undefined, { numeric: true, sensitivity: 'base' })) : out;
  }, [list.items, movies.data, series.data, props.sort]);
  const err = movies.error ?? series.error;
  const n = list.items.length;
  const missing = items ? n - items.length : 0;

  return (
    <>
      {renaming ? (
        <form
          className="lst-form lt-bar"
          onSubmit={(e) => {
            e.preventDefault();
            const name = draft.trim();
            if (name && name !== list.name) void renameMediaList(list.id, name);
            setRenaming(false);
          }}
        >
          <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="List name" maxLength={MEDIA_LIST_LIMITS.name} autoFocus />
          <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => setRenaming(false)}>
            Cancel
          </button>
        </form>
      ) : confirm ? (
        <div className="lt-bar">
          <span className="muted">Delete “{list.name}”? The movies and series stay in your library.</span>
          <button type="button" className="btn btn-danger" autoFocus onClick={() => (setConfirm(false), void deleteMediaList(list.id))}>
            Delete list
          </button>
          <button type="button" className="btn" onClick={() => setConfirm(false)}>
            Keep
          </button>
        </div>
      ) : (
        <div className="lt-bar" data-nav-row="list-bar">
          <span className="lt-info tabnum">
            {n} {n === 1 ? 'title' : 'titles'}
          </span>
          {!list.builtin && (
            <>
              <button type="button" className="btn" onClick={() => (setDraft(list.name), setRenaming(true))}>
                Rename
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setConfirm(true)}>
                Delete…
              </button>
            </>
          )}
          <span className="lt-grow" />
          {n > 1 && props.sortControl}
        </div>
      )}
      {err && !items ? (
        <Empty title="Couldn't load this list">
          <p>{errorMessage(err)}</p>
        </Empty>
      ) : n === 0 ? (
        list.builtin ? (
          <Empty title="Nothing to watch later yet">
            <p>Open a movie or a series and tap Watch later, and it will wait for you here.</p>
          </Empty>
        ) : (
          <Empty title="This list is empty">
            <p>Open a movie or a series and tap Add to list, or right-click or long-press its poster.</p>
          </Empty>
        )
      ) : !items ? (
        <div className="poster-grid fav-grid" aria-hidden="true">
          {Array.from({ length: Math.min(n, 12) }, (_, i) => (
            <PosterSkeleton key={i} />
          ))}
        </div>
      ) : (
        <>
          <ul className="poster-grid fav-grid" aria-label={`Titles in ${list.name}`}>
            {items.map(({ kind, item }) => (
              <li key={`${kind}:${item.id}`} className="fav-poster">
                <PosterCard kind={kind} item={item} />
                <button
                  type="button"
                  className="fav-star on-art lt-remove"
                  aria-label={`Remove ${item.name} from ${list.name}`}
                  title={`Remove from ${list.name}`}
                  onClick={() => void toggleInMediaList(list.id, kind, item.id, false)}
                >
                  <IconClose />
                </button>
              </li>
            ))}
          </ul>
          {missing > 0 && (
            <p className="lst-hint lt-note">
              {missing} {missing === 1 ? 'title is' : 'titles are'} hidden by your filters or no longer offered by your provider.
            </p>
          )}
        </>
      )}
    </>
  );
}

/* ---------------- channels ---------------- */

const menuFor = (ch: LiveChannelWithNow) => openAddToList({ id: ch.id, name: ch.name });

function ChannelPanel(props: { list: ChannelList }) {
  const { list } = props;
  const form = useFormFactor();
  const navigate = useNavigate();
  const version = useApp((s) => s.catalogVersion);
  const [editing, setEditing] = useState(false);
  // now/next refresh every couple of minutes
  const now = useNow(30_000);
  const slot = Math.floor(now / 120_000);
  const key = list.channelIds.join(',');
  const chans = useAsync(
    async (signal) => {
      if (!key) return [] as LiveChannelWithNow[];
      const res = await call('GET /api/lists/:id/channels', { params: { id: list.id }, signal });
      remember('live', res);
      return res;
    },
    [list.id, key, version, slot],
  );
  // follow the store's order right away
  const items = useMemo(() => {
    if (!chans.data) return undefined;
    const byId = new Map(chans.data.map((c) => [c.id, c]));
    return list.channelIds.map((id) => byId.get(id)).filter((c): c is LiveChannelWithNow => !!c);
  }, [chans.data, list.channelIds]);
  const open = useCallback(
    (id: string) => {
      setZapList((items ?? []).map((c) => c.id));
      writeLocal('anycast.lastChannel', id);
      navigate(`/play/live/${id}`);
    },
    [items, navigate],
  );
  const n = list.channelIds.length;
  return (
    <>
      <div className="lt-bar" data-nav-row="list-bar">
        <span className="lt-info tabnum">
          {n} {n === 1 ? 'channel' : 'channels'}
        </span>
        <button type="button" className="btn" onClick={() => setEditing(true)} aria-label={`Edit list ${list.name}`}>
          Edit
        </button>
      </div>
      {chans.error && !items ? (
        <Empty title="Couldn't load this list">
          <p>{errorMessage(chans.error)}</p>
        </Empty>
      ) : n === 0 ? (
        <Empty title="This list is empty">
          <p>Add channels with ⋯ on a channel in Live TV (or right-click or long-press it), or from the player.</p>
        </Empty>
      ) : !items ? (
        <div className="fav-live" aria-hidden="true">
          {Array.from({ length: Math.min(n, 8) }, (_, i) => (
            <div key={i} className="ch-row">
              <Skeleton w="3.25rem" h="3.25rem" r="0.875rem" style={{ flex: 'none' }} />
              <div className="ch-main" style={{ display: 'grid', gap: '0.5rem' }}>
                <Skeleton w="55%" h="0.875rem" />
                <Skeleton w="80%" h="0.75rem" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <ul className="fav-live" aria-label={`Channels in ${list.name}`}>
          {items.map((ch) => (
            <li key={ch.id} className="fav-live-item" data-nav-row={`lt-${ch.id}`}>
              <ChannelRow ch={ch} now={now} onOpen={open} showNext={form !== 'phone'} onMenu={menuFor} />
            </li>
          ))}
        </ul>
      )}
      {editing && <ListEditorSheet listId={list.id} onClose={() => setEditing(false)} />}
    </>
  );
}

/* ---------------- new list ---------------- */

function NewListSheet(props: { onClose: () => void; onMade: (id: string) => void }) {
  const [type, setType] = useState<'media' | 'channels'>('media');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const made = type === 'media' ? await createMediaList(n) : await createList(n);
    setBusy(false);
    if (made) props.onMade(made.id);
  };
  return (
    <Sheet title="New list" onClose={props.onClose} className="atl-sheet">
      <form
        className="lt-new"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Segmented
          label="List type"
          value={type}
          options={[
            { value: 'media', label: 'Movies & series' },
            { value: 'channels', label: 'Channels' },
          ]}
          onChange={setType}
        />
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={type === 'media' ? 'List name, e.g. Date night' : 'List name, e.g. News'}
          aria-label="New list name"
          maxLength={type === 'media' ? MEDIA_LIST_LIMITS.name : CHANNEL_LIST_LIMITS.name}
          data-autofocus=""
        />
        <p className="lst-hint">
          {type === 'media'
            ? 'Add movies and series with Add to list on their page, or right-click or long-press a poster.'
            : 'Channel lists also show up as chips in Live TV, and zapping follows their order.'}
        </p>
        <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>
          Create list
        </button>
      </form>
    </Sheet>
  );
}
