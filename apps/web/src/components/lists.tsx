/**
 * Channel lists (LB-3), the always-loaded part: a modal Sheet, the long-press / right-click hook for
 * channel rows, and the "Add to list" sheet (mounted once in App, opened with openAddToList).
 * The list editor itself is lazy: ./ListEditor.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CHANNEL_LIST_LIMITS } from '@anycast/shared';
import { useApp } from '../store/app';
import { closeAddToList, createList, toggleInList } from '../store/lists';
import { isBackKey } from '../nav/spatial';
import { IconClose } from './Icons';
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

/** The "Add to list" sheet for the channel in `addToList`; mounted once in App. */
export function AddToListHost() {
  const ch = useApp((s) => s.addToList);
  if (!ch) return null;
  // a full-screen player only shows its own subtree, so the sheet goes inside it then
  return createPortal(<AddToListSheet key={ch.id} id={ch.id} name={ch.name} />, document.fullscreenElement ?? document.body);
}

function AddToListSheet(props: { id: string; name: string }) {
  const lists = useApp((s) => s.lists);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const made = await createList(n, [props.id]);
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
        {lists.length === 0 && !creating && <p className="muted atl-empty">No lists yet. Make one for the channels you watch, like News or Sport.</p>}
        {lists.map((l, i) => {
          const on = l.channelIds.includes(props.id);
          return (
            <button
              key={l.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              className="atl-row"
              data-autofocus={i === 0 ? '' : undefined}
              onClick={() => void toggleInList(l.id, props.id, !on)}
            >
              <span className="atl-box" aria-hidden="true">
                {on && (
                  <svg viewBox="0 0 24 24" className="ico">
                    <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="atl-name ellipsis">{l.name}</span>
              <span className="atl-count tabnum">{l.channelIds.length}</span>
            </button>
          );
        })}
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
            placeholder="List name, e.g. News"
            aria-label="New list name"
            maxLength={CHANNEL_LIST_LIMITS.name}
            autoFocus
          />
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>
            Create
          </button>
        </form>
      ) : (
        <button type="button" className="btn btn-quiet atl-new-btn" data-autofocus={lists.length === 0 ? '' : undefined} onClick={() => setCreating(true)}>
          + New list…
        </button>
      )}
    </Sheet>
  );
}
