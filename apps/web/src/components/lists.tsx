/**
 * Lists, the always-loaded part: a modal Sheet, the long-press / right-click hook for channel rows
 * and posters, and the "Add to list" sheet for channels, movies and series (mounted once in App,
 * opened with openAddToList).
 * The list editor itself is lazy: ./ListEditor.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CHANNEL_LIST_LIMITS, MEDIA_LIST_LIMITS } from '@anycast/shared';
import { useApp } from '../store/app';
import { closeAddToList, createList, createMediaList, inMediaList, openAddToList, toggleInList, toggleInMediaList, toggleWatchLater, watchLater } from '../store/lists';
import { isBackKey } from '../nav/spatial';
import { IconBookmark, IconClose, IconListAdd } from './Icons';
import '../theme/lists.css';

/**
 * A modal sheet (bottom sheet on phones). Back / Escape closes it before anything else sees the key
 * (capture phase), focus moves in on open and back out on close, and the player ignores keys in it.
 */
export function Sheet(props: { title: string; onClose: () => void; children: ReactNode; className?: string; head?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = ref.current;
      if (!el || el.contains(document.activeElement)) return;
      (el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>('button, input'))?.focus();
    }, 30);
    const onKey = (e: KeyboardEvent) => {
      // only the topmost sheet answers
      const sheets = document.querySelectorAll('.sheet');
      if (sheets[sheets.length - 1] !== ref.current) return;
      if (!isBackKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      onClose.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div
        ref={ref}
        className={`sheet${props.className ? ' ' + props.className : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        data-nav-trap=""
        data-player-keys="off"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          {props.head ?? <h2 className="h2">{props.title}</h2>}
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/**
 * Right-click (desktop) or long-press (touch) on a channel row opens its menu. Returns props for the
 * row; a click right after a long-press is swallowed so the row doesn't also open the channel.
 */
export function useChannelMenu(onMenu: (() => void) | undefined) {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  if (!onMenu) return {};
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    start.current = null;
  };
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      clear();
      fired.current = true;
      onMenu();
    },
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      if (e.pointerType !== 'touch') return;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        timer.current = undefined;
        onMenu();
      }, 500);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        fired.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}

/** The "Add to list" sheet for the channel, movie or series in `addToList`; mounted once in App. */
export function AddToListHost() {
  const t = useApp((s) => s.addToList);
  if (!t) return null;
  // a full-screen player only shows its own subtree, so the sheet goes inside it then
  const sheet = t.kind === 'live' ? <ChannelAddToList key={t.id} id={t.id} name={t.name} /> : <MediaAddToList key={`${t.kind}:${t.id}`} kind={t.kind} id={t.id} name={t.name} />;
  return createPortal(sheet, document.fullscreenElement ?? document.body);
}

function ChannelAddToList(props: { id: string; name: string }) {
  const lists = useApp((s) => s.lists);
  return (
    <AddToListSheet
      name={props.name}
      rows={lists.map((l) => ({ id: l.id, name: l.name, count: l.channelIds.length, on: l.channelIds.includes(props.id) }))}
      onToggle={(listId, on) => void toggleInList(listId, props.id, on)}
      onCreate={async (n) => !!(await createList(n, [props.id]))}
      empty="No lists yet. Make one for the channels you watch, like News or Sport."
      placeholder="List name, e.g. News"
      maxLength={CHANNEL_LIST_LIMITS.name}
    />
  );
}

function MediaAddToList(props: { kind: 'movie' | 'series'; id: string; name: string }) {
  const lists = useApp((s) => s.mediaLists);
  return (
    <AddToListSheet
      name={props.name}
      rows={lists.map((l) => ({ id: l.id, name: l.name, count: l.items.length, on: inMediaList(l, props.kind, props.id) }))}
      onToggle={(listId, on) => void toggleInMediaList(listId, props.kind, props.id, on)}
      onCreate={async (n) => !!(await createMediaList(n, [{ kind: props.kind, id: props.id }]))}
      empty="No lists yet."
      placeholder="List name, e.g. Date night"
      maxLength={MEDIA_LIST_LIMITS.name}
    />
  );
}

function AddToListSheet(props: {
  name: string;
  rows: { id: string; name: string; count: number; on: boolean }[];
  onToggle: (listId: string, on: boolean) => void;
  onCreate: (name: string) => Promise<boolean>;
  empty: string;
  placeholder: string;
  maxLength: number;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const made = await props.onCreate(n);
    setBusy(false);
    if (made) {
      setName('');
      setCreating(false);
    }
  };
  return (
    <Sheet
      title={`Add ${props.name} to a list`}
      onClose={closeAddToList}
      className="atl-sheet"
      head={
        <div className="atl-head">
          <h2 className="h2">Add to list</h2>
          <div className="atl-ch ellipsis">{props.name}</div>
        </div>
      }
    >
      <div className="atl-list" role="group" aria-label="Your lists">
        {props.rows.length === 0 && !creating && <p className="muted atl-empty">{props.empty}</p>}
        {props.rows.map((l, i) => (
          <button
            key={l.id}
            type="button"
            role="checkbox"
            aria-checked={l.on}
            className="atl-row"
            data-autofocus={i === 0 ? '' : undefined}
            onClick={() => props.onToggle(l.id, !l.on)}
          >
            <span className="atl-box" aria-hidden="true">
              {l.on && (
                <svg viewBox="0 0 24 24" className="ico">
                  <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <span className="atl-name ellipsis">{l.name}</span>
            <span className="atl-count tabnum">{l.count}</span>
          </button>
        ))}
      </div>
      {creating ? (
        <form
          className="lst-form atl-new"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={props.placeholder}
            aria-label="New list name"
            maxLength={props.maxLength}
            autoFocus
          />
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>
            Create
          </button>
        </form>
      ) : (
        <button type="button" className="btn btn-quiet atl-new-btn" data-autofocus={props.rows.length === 0 ? '' : undefined} onClick={() => setCreating(true)}>
          + New list…
        </button>
      )}
    </Sheet>
  );
}

/** Watch later + Add to list buttons for a movie or series page. */
export function MediaListButtons(props: { kind: 'movie' | 'series'; id: string; name: string }) {
  const later = useApp((s) => {
    const wl = watchLater(s.mediaLists);
    return !!wl && inMediaList(wl, props.kind, props.id);
  });
  return (
    <>
      <button type="button" className={`btn btn-lg${later ? ' on' : ''}`} aria-pressed={later} onClick={() => void toggleWatchLater(props.kind, props.id)}>
        <IconBookmark filled={later} /> {later ? 'In Watch Later' : 'Watch later'}
      </button>
      <button type="button" className="btn btn-lg" onClick={() => openAddToList({ kind: props.kind, id: props.id, name: props.name })}>
        <IconListAdd /> Add to list
      </button>
    </>
  );
}
