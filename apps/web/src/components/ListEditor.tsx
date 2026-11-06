/**
 * Channel list editing (LB-3, lazy chunk): a dependency-free reorderable list (pointer drag for
 * mouse and touch, up/down buttons for the keyboard, a "Move" mode for the TV remote), the editor
 * sheet for one list and the "Channel lists" group in Settings.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CHANNEL_LIST_LIMITS, type LiveChannelWithNow } from '@anycast/shared';
import { call } from '../api/client';
import { remember } from '../api/catalog';
import { useAsync, useFormFactor } from '../lib/hooks';
import { dropIndex, moveItem, shiftFor } from '../lib/reorder';
import { useApp } from '../store/app';
import { createList, deleteList, renameList, setListChannels, setListOrder } from '../store/lists';
import { Sheet } from './lists';
import { IconClose, IconDown, IconDrag, IconUp } from './Icons';
import { LogoTile, Skeleton } from './ui';

/* ---------------- reorderable list ---------------- */

interface DragState { from: number; to: number; dy: number; slot: number }

function scrollParent(el: HTMLElement | null): HTMLElement {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement as HTMLElement;
}

export function ReorderList<T>(props: {
  label: string;
  items: T[];
  keyOf: (item: T) => string;
  nameOf: (item: T) => string;
  render: (item: T) => ReactNode;
  onMove: (from: number, to: number) => void;
  onRemove?: (index: number) => void;
  removeLabel?: string;
  /** extra buttons per row (before remove) */
  actions?: (item: T, index: number) => ReactNode;
}) {
  const form = useFormFactor();
  const listRef = useRef<HTMLOListElement>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [settling, setSettling] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const live = useRef<{ mids: number[]; startY: number; from: number; slot: number; scroller: HTMLElement; clientY: number; raf: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const { items, keyOf } = props;

  const commit = (from: number, to: number) => {
    if (from === to) return;
    props.onMove(from, to);
    setAnnounce(`${props.nameOf(items[from]!)} moved to position ${to + 1} of ${items.length}`);
  };

  /* pointer drag */
  const recompute = () => {
    const d = live.current;
    if (!d) return;
    const y = d.clientY + d.scroller.scrollTop;
    const dy = y - d.startY;
    setDrag({ from: d.from, to: dropIndex(d.mids, d.from, d.mids[d.from]! + dy), dy, slot: d.slot });
  };
  const onDown = (i: number) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || items.length < 2) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const els = items.map((it) => rows.current.get(keyOf(it))!);
    const scroller = scrollParent(listRef.current);
    const rects = els.map((el) => el.getBoundingClientRect());
    const gap = rects.length > 1 ? Math.max(0, rects[1]!.top - rects[0]!.bottom) : 0;
    const st = scroller.scrollTop;
    live.current = {
      mids: rects.map((r) => r.top + r.height / 2 + st),
      startY: e.clientY + st,
      from: i,
      slot: rects[i]!.height + gap,
      scroller,
      clientY: e.clientY,
      raf: 0,
    };
    // keep scrolling while the pointer rests near the scroller's edge
    const tick = () => {
      const d = live.current;
      if (!d) return;
      const box = d.scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : d.scroller.getBoundingClientRect();
      const edge = 48;
      const v = d.clientY < box.top + edge ? -(box.top + edge - d.clientY) / 4 : d.clientY > box.bottom - edge ? (d.clientY - (box.bottom - edge)) / 4 : 0;
      if (v) {
        d.scroller.scrollTop += Math.max(-16, Math.min(16, v));
        recompute();
      }
      d.raf = requestAnimationFrame(tick);
    };
    live.current.raf = requestAnimationFrame(tick);
    setDrag({ from: i, to: i, dy: 0, slot: live.current.slot });
  };
  const onMovePointer = (e: React.PointerEvent) => {
    if (!live.current) return;
    live.current.clientY = e.clientY;
    recompute();
  };
  const onUp = () => {
    const d = live.current;
    if (!d) return;
    cancelAnimationFrame(d.raf);
    live.current = null;
    const final = drag;
    setDrag(null);
    if (final && final.to !== final.from) {
      // no transition for the frame where the DOM order changes under the transforms
      setSettling(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
      commit(final.from, final.to);
    }
  };
  useEffect(() => () => cancelAnimationFrame(live.current?.raf ?? 0), []);

  /* Move mode (TV remote, keyboard): up/down move the item, OK / Back finish */
  useEffect(() => {
    if (!moving) return;
    const onKey = (e: KeyboardEvent) => {
      const i = items.findIndex((it) => keyOf(it) === moving);
      if (i < 0) return setMoving(null);
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const to = e.key === 'ArrowUp' ? i - 1 : i + 1;
        if (to >= 0 && to < items.length) commit(i, to);
      } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape' || e.key === 'Backspace' || [461, 10009, 4].includes(e.keyCode)) {
        e.preventDefault();
        e.stopPropagation();
        setMoving(null);
        setAnnounce('Done moving');
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab') {
        setMoving(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  // keep the moving row's Move button focused and in view as it travels
  useEffect(() => {
    if (!moving) return;
    const el = rows.current.get(moving)?.querySelector<HTMLElement>('[data-move]');
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  });

  const tv = form === 'tv';
  return (
    <>
      <ol ref={listRef} className={`reorder${settling ? ' settling' : ''}${drag ? ' dragging' : ''}`} aria-label={props.label}>
        {items.map((it, i) => {
          const k = keyOf(it);
          const name = props.nameOf(it);
          const isDrag = drag?.from === i;
          const y = drag ? (isDrag ? drag.dy : shiftFor(i, drag.from, drag.to) * drag.slot) : 0;
          return (
            <li
              key={k}
              ref={(el) => (el ? rows.current.set(k, el) : rows.current.delete(k))}
              className={`reorder-row${isDrag ? ' lifted' : ''}${moving === k ? ' moving' : ''}`}
              style={y ? { transform: `translateY(${y}px)` } : undefined}
              data-nav-row={`reorder-${k}`}
            >
              {!tv && (
                <span
                  className="reorder-handle"
                  aria-hidden="true"
                  title="Drag to reorder"
                  onPointerDown={onDown(i)}
                  onPointerMove={onMovePointer}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                >
                  <IconDrag />
                </span>
              )}
              <div className="reorder-main">{props.render(it)}</div>
              {tv ? (
                <button
                  type="button"
                  className={`btn${moving === k ? ' btn-primary' : ''}`}
                  data-move=""
                  aria-pressed={moving === k}
                  aria-label={moving === k ? `Moving ${name}: up or down, then OK` : `Move ${name}`}
                  onClick={() => {
                    if (moving === k) return setMoving(null);
                    setMoving(k);
                    setAnnounce(`Moving ${name}. Press up or down, then OK.`);
                  }}
                >
                  {moving === k ? '▲▼ Moving' : 'Move'}
                </button>
              ) : (
                <span className="reorder-arrows">
                  <button type="button" className="icon-btn sm" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => commit(i, i - 1)}>
                    <IconUp />
                  </button>
                  <button type="button" className="icon-btn sm" aria-label={`Move ${name} down`} disabled={i === items.length - 1} onClick={() => commit(i, i + 1)}>
                    <IconDown />
                  </button>
                </span>
              )}
              {props.actions?.(it, i)}
              {props.onRemove && (
                <button type="button" className="icon-btn sm reorder-remove" aria-label={`${props.removeLabel ?? 'Remove'} ${name}`} title={props.removeLabel ?? 'Remove'} onClick={() => props.onRemove!(i)}>
                  <IconClose />
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </>
  );
}

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
          <ReorderList
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
        <ReorderList
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
