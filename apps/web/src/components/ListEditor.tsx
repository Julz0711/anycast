/**
 * Channel list editing (LB-3, lazy chunk): the editor sheet for one list and the "Channel lists"
 * group in Settings. Rows reorder with SortableList (drag, arrows, or Move mode on the TV).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CHANNEL_LIST_LIMITS, type LiveChannelWithNow } from '@anycast/shared';
import { call } from '../api/client';
import { remember } from '../api/catalog';
import { useAsync } from '../lib/hooks';
import { moveItem } from '../lib/reorder';
import { useApp } from '../store/app';
import { createList, deleteList, renameList, setListChannels, setListOrder } from '../store/lists';
import { Sheet } from './lists';
import { IconClose } from './Icons';
import { SortableList } from './Sortable';
import { LogoTile, Skeleton } from './ui';

/* ---------------- editor for one list ---------------- */

export function ListEditorSheet(props: { listId: string; onClose: () => void }) {
  const list = useApp((s) => s.lists.find((l) => l.id === props.listId));
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState(false);
  // names and logos; refetched only when channels are added (removals and moves reuse what we have)
  const known = useRef(new Map<string, LiveChannelWithNow>());
  const missing = (list?.channelIds ?? []).filter((id) => !known.current.has(id));
  const fetchKey = missing.join(',');
  const chans = useAsync(async (signal) => {
    if (!list) return known.current;
    if (fetchKey || known.current.size === 0) {
      const res = await call('GET /api/lists/:id/channels', { params: { id: list.id }, signal });
      remember('live', res);
      for (const c of res) known.current.set(c.id, c);
    }
    return known.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey, list?.id]);

  useEffect(() => {
    if (!list) props.onClose();
  }, [list, props]);
  if (!list) return null;
  const ids = list.channelIds;
  const loading = !chans.data && chans.loading;
  return (
    <Sheet title={`Edit ${list.name}`} onClose={props.onClose} className="list-editor" head={<h2 className="h2 ellipsis">Edit list</h2>}>
      {renaming ? (
        <form
          className="lst-form"
          onSubmit={(e) => {
            e.preventDefault();
            const n = draft.trim();
            if (n && n !== list.name) void renameList(list.id, n);
            setRenaming(false);
          }}
        >
          <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="List name" maxLength={CHANNEL_LIST_LIMITS.name} autoFocus />
          <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => setRenaming(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="le-name">
          <div style={{ minWidth: 0 }}>
            <div className="le-title ellipsis">{list.name}</div>
            <div className="lst-hint tabnum">
              {ids.length} {ids.length === 1 ? 'channel' : 'channels'}
            </div>
          </div>
          <button type="button" className="btn" data-autofocus="" onClick={() => (setDraft(list.name), setRenaming(true))}>
            Rename
          </button>
        </div>
      )}
      <div className="le-body">
        {ids.length === 0 ? (
          <p className="muted le-empty">This list is empty. Add channels with “Add to list” in a channel’s ⋯ menu (or right-click / long-press it), or from the player.</p>
        ) : loading ? (
          <div aria-hidden="true" style={{ display: 'grid', gap: '0.5rem' }}>
            {ids.slice(0, 6).map((id) => (
              <Skeleton key={id} h="3.25rem" r="0.75rem" />
            ))}
          </div>
        ) : (
          <SortableList
            label={`Channels in ${list.name}`}
            items={ids}
            keyOf={(id) => id}
            nameOf={(id) => chans.data?.get(id)?.name ?? 'Unavailable channel'}
            onMove={(from, to) => void setListChannels(list.id, moveItem(ids, from, to))}
            onRemove={(i) => void setListChannels(list.id, ids.filter((_, j) => j !== i))}
            removeLabel={`Remove from ${list.name}:`}
            render={(id) => {
              const c = chans.data?.get(id);
              return c ? (
                <span className="le-ch">
                  <LogoTile name={c.name} logo={c.logo} small />
                  <span className="ellipsis">{c.name}</span>
                  <span className="ch-num tabnum muted">{c.number}</span>
                </span>
              ) : (
                <span className="le-ch muted">No longer offered by your provider</span>
              );
            }}
          />
        )}
      </div>
      <div className="le-foot">
        {confirm ? (
          <>
            <span className="muted">Delete “{list.name}”? The channels stay in Live TV.</span>
            <button type="button" className="btn btn-danger" autoFocus onClick={() => (void deleteList(list.id), props.onClose())}>
              Delete list
            </button>
            <button type="button" className="btn" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-danger" onClick={() => setConfirm(true)}>
              Delete list…
            </button>
            <button type="button" className="btn btn-primary" onClick={props.onClose}>
              Done
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}

/* ---------------- Settings > Channel lists ---------------- */

export function ListsManager() {
  const lists = useApp((s) => s.lists);
  const loaded = useApp((s) => s.listsLoaded);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [name, setName] = useState('');
  const order = useMemo(() => lists.map((l) => l.id), [lists]);
  return (
    <div className="lists-manager">
      {!loaded ? (
        <Skeleton h="3rem" r="0.75rem" />
      ) : lists.length === 0 ? (
        <p className="lst-hint">No lists yet. Lists show up as chips in Live TV, right after Favorites, in your own order.</p>
      ) : (
        <SortableList
          label="Your channel lists"
          items={lists}
          keyOf={(l) => l.id}
          nameOf={(l) => l.name}
          onMove={(from, to) => void setListOrder(moveItem(order, from, to))}
          render={(l) =>
            confirm === l.id ? (
              <span className="lm-confirm">
                <span className="ellipsis">Delete “{l.name}”?</span>
              </span>
            ) : (
              <span className="lm-row">
                <span className="lst-label ellipsis">{l.name}</span>
                <span className="lst-hint tabnum">
                  {l.channelIds.length} {l.channelIds.length === 1 ? 'channel' : 'channels'}
                </span>
              </span>
            )
          }
          actions={(l) =>
            confirm === l.id ? (
              <>
                <button type="button" className="btn btn-danger" autoFocus onClick={() => (setConfirm(null), void deleteList(l.id))}>
                  Delete
                </button>
                <button type="button" className="btn" onClick={() => setConfirm(null)}>
                  Keep
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={() => setEditing(l.id)} aria-label={`Edit ${l.name}`}>
                  Edit
                </button>
                <button type="button" className="icon-btn sm reorder-remove" aria-label={`Delete ${l.name}`} title="Delete list" onClick={() => setConfirm(l.id)}>
                  <IconClose />
                </button>
              </>
            )
          }
        />
      )}
      <form
        className="lst-form"
        style={{ marginTop: '1rem' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void createList(name.trim());
          setName('');
        }}
      >
        <input className="input" placeholder="New list name, e.g. News" aria-label="New list name" value={name} onChange={(e) => setName(e.target.value)} maxLength={CHANNEL_LIST_LIMITS.name} />
        <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
          Add list
        </button>
      </form>
      <p className="lst-hint" style={{ marginTop: '0.75rem' }}>
        Add channels with “Add to list” on a channel (⋯, right-click or long-press) or in the player. A channel in a list stays there even when your filters hide its country.
      </p>
      {editing && <ListEditorSheet listId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
