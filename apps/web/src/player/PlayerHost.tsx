/**
 * Keeps one player mounted for the whole app, so leaving the player can shrink it into a mini
 * player instead of stopping it. The same <video>, engine and server stream carry on (the
 * provider may allow only one connection), and expanding it again does not reload anything.
 *
 * The /play/:kind/:id route is the full-screen player. Leaving it with the mini player on keeps
 * the last item playing: in a corner on desktops and tablets (drag it to another corner, drag its
 * grip to resize it), as a now bar docked on the tab bar on phones. With it off (or on TV) the
 * player unmounts and stops as before.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../store/app';
import { useFormFactor } from '../lib/hooks';
import { readLocal, writeLocal } from '../lib/storage';
import { clampMiniWidth, setMiniWidth, useMiniSize, useMiniWidth } from './miniSize';
import { setOpenPlayer } from './nowPlaying';

const PlayerScreen = lazy(() => import('./PlayerScreen'));

const PLAY_PATH = /^\/play\/(live|movie|episode)\/([^/?#]+)\/?$/;

export interface PlaySession {
  kind: 'live' | 'movie' | 'episode';
  id: string;
  /** query string, with its "?" (or empty) */
  search: string;
}

export function parsePlayPath(path: string): PlaySession | null {
  const [pathname = '', search = ''] = path.split(/(?=\?)/);
  const m = PLAY_PATH.exec(pathname);
  if (!m) return null;
  return { kind: m[1] as PlaySession['kind'], id: decodeURIComponent(m[2]!), search };
}

export const sessionPath = (s: PlaySession) => `/play/${s.kind}/${encodeURIComponent(s.id)}${s.search}`;

export type Corner = 'br' | 'bl' | 'tr' | 'tl';
const CORNERS: Corner[] = ['br', 'bl', 'tr', 'tl'];
const CORNER_KEY = 'anycast.miniCorner';

/** The corner nearest to a point (the mini player's centre), so a drag docks where it was dropped. */
export function nearestCorner(x: number, y: number, w: number, h: number): Corner {
  return `${y < h / 2 ? 't' : 'b'}${x < w / 2 ? 'l' : 'r'}` as Corner;
}

export function PlayerHost() {
  const loc = useLocation();
  const navigate = useNavigate();
  const form = useFormFactor();
  const miniPref = useApp((s) => s.prefs.player.miniPlayer);
  const profileId = useApp((s) => s.profileId);
  const allowMini = miniPref && form !== 'tv';

  const routed = parsePlayPath(loc.pathname + loc.search);
  const [kept, setKept] = useState<PlaySession | null>(null);
  // the full player follows the address bar; the mini player keeps the last item that played
  useEffect(() => {
    if (routed) setKept((k) => (k && k.kind === routed.kind && k.id === routed.id && k.search === routed.search ? k : routed));
    else if (!allowMini) setKept(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routed?.kind, routed?.id, routed?.search, allowMini]);
  // another profile does not inherit what this one was watching
  const lastProfile = useRef(profileId);
  useEffect(() => {
    if (lastProfile.current !== profileId) setKept(null);
    lastProfile.current = profileId;
  }, [profileId]);

  const session = routed ?? (allowMini ? kept : null);
  const mini = !routed && !!session;

  const go = useCallback(
    (path: string) => {
      if (mini) {
        const next = parsePlayPath(path);
        if (next) setKept(next);
      } else navigate(path, { replace: true });
    },
    [mini, navigate],
  );
  const expand = useCallback(() => {
    if (kept) navigate(sessionPath(kept));
  }, [kept, navigate]);
  const close = useCallback(() => setKept(null), []);
  // the rest of the app may bring the mini player back up (the phone's "turn upright" screen does)
  useEffect(() => {
    setOpenPlayer(mini ? expand : null);
    return () => setOpenPlayer(null);
  }, [mini, expand]);

  if (!session) return null;
  return (
    <MiniFrame mini={mini} form={form} onTap={expand}>
      <Suspense fallback={null}>
        <PlayerScreen kind={session.kind} id={session.id} search={session.search} mini={mini} go={go} expand={expand} close={close} />
      </Suspense>
    </MiniFrame>
  );
}

/**
 * The frame stays the same element in both modes, so React keeps the player (and its <video>)
 * when it shrinks. Mini: docked in a corner, dragged to another one, tapped to expand. On phones
 * it is the now bar instead: fixed above the tab bar, a tap or a swipe up opens the player.
 */
function MiniFrame(props: { mini: boolean; form: string; onTap: () => void; children: React.ReactNode }) {
  const bar = props.mini && props.form === 'phone';
  const floating = props.mini && !bar;
  const [corner, setCorner] = useState<Corner>(() => {
    const c = readLocal(CORNER_KEY) as Corner | null;
    return c && CORNERS.includes(c) ? c : 'br';
  });
  /** where the pointer went down, and the frame's centre then */
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; id: number; moved: boolean; onButton: boolean } | null>(null);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const size = useMiniSize();
  const frame = useRef<HTMLDivElement>(null);
  /** a tap or swipe on the now bar's title is handled here: its own click, if one follows, must not open the player twice */
  const swallowClickUntil = useRef(0);

  // leaving the player while in full screen: the mini player can't be full screen
  useEffect(() => {
    if (props.mini && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, [props.mini]);

  // the now bar takes room above the tab bar: the layout (theme/mobile.css) makes space for it
  useEffect(() => {
    if (!bar) return;
    document.documentElement.dataset.nowbar = '';
    return () => {
      delete document.documentElement.dataset.nowbar;
    };
  }, [bar]);

  /* ---------- a width of the viewer's own (not on phones) ---------- */
  const customWidth = useMiniWidth();
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    if (!floating || customWidth === null) return;
    const on = () => setView({ w: window.innerWidth, h: window.innerHeight });
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [floating, customWidth]);
  const width = floating && customWidth !== null ? clampMiniWidth(customWidth, view.w, view.h) : null;
  const resize = useRef<{ id: number; x: number; y: number; w: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  // the grip sits on the corner that points into the screen: dragging it away from the dock grows the frame
  const sx = corner.endsWith('r') ? -1 : 1;
  const sy = corner.startsWith('b') ? -1 : 1;
  const gripDown = (e: RPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !frame.current) return;
    e.preventDefault();
    resize.current = { id: e.pointerId, x: e.clientX, y: e.clientY, w: frame.current.offsetWidth };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setResizing(true);
  };
  const gripMove = (e: RPointerEvent<HTMLButtonElement>) => {
    const r = resize.current;
    if (!r || r.id !== e.pointerId) return;
    const byX = sx * (e.clientX - r.x);
    const byY = (sy * (e.clientY - r.y) * 16) / 9;
    setMiniWidth(clampMiniWidth(r.w + (Math.abs(byX) > Math.abs(byY) ? byX : byY), window.innerWidth, window.innerHeight), false);
  };
  const gripUp = (e: RPointerEvent<HTMLButtonElement>) => {
    const r = resize.current;
    if (!r || r.id !== e.pointerId) return;
    resize.current = null;
    setResizing(false);
    if (frame.current && customWidth !== null) setMiniWidth(Math.round(frame.current.offsetWidth));
  };
  const gripKey = (e: RKeyboardEvent<HTMLButtonElement>) => {
    const step = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 32 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -32 : 0;
    if (!step || !frame.current) return;
    e.preventDefault();
    e.stopPropagation();
    setMiniWidth(clampMiniWidth(frame.current.offsetWidth + step, window.innerWidth, window.innerHeight));
  };

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!props.mini || e.button !== 0) return;
    const onControl = (e.target as HTMLElement).closest('button, a, input');
    // the now bar's title is a button (it opens the player), and a swipe up may start on it
    const onButton = !!onControl && bar && onControl.classList.contains('now-open');
    if (onControl && !onButton) return;
    const r = e.currentTarget.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, cx: r.left + r.width / 2, cy: r.top + r.height / 2, id: e.pointerId, moved: false, onButton };
    // a quick flick can leave the frame before it counts as a drag
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 8) return;
    d.moved = true;
    // the now bar stays put; only an upward pull shows
    setOffset(bar ? { x: 0, y: Math.max(-24, Math.min(0, dy)) } : { x: dx, y: dy });
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (d.onButton) swallowClickUntil.current = performance.now() + 400;
    if (!d.moved) return props.onTap();
    setOffset(null);
    if (bar) {
      const dy = e.clientY - d.y;
      if (dy < -24 && Math.abs(dy) > Math.abs(e.clientX - d.x)) props.onTap();
      return;
    }
    // from the pointer, not the DOM: the last move may not have rendered yet
    const c = nearestCorner(d.cx + e.clientX - d.x, d.cy + e.clientY - d.y, window.innerWidth, window.innerHeight);
    setCorner(c);
    writeLocal(CORNER_KEY, c);
  };
  const onCancel = () => {
    drag.current = null;
    setOffset(null);
  };
  const onClickCapture = (e: RMouseEvent<HTMLDivElement>) => {
    if (performance.now() >= swallowClickUntil.current) return;
    swallowClickUntil.current = 0;
    // only the click that belongs to that tap: on the title, or on the frame that had captured the pointer
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).closest('.now-open')) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const style: React.CSSProperties = {};
  if (props.mini && offset) style.transform = `translate(${offset.x}px, ${offset.y}px)`;
  if (width !== null) style.width = `${width}px`;

  return (
    <div
      ref={frame}
      className={props.mini ? 'mini-frame' : 'player-frame'}
      data-dock={bar ? 'bar' : undefined}
      data-corner={floating ? corner : undefined}
      data-size={floating ? size : undefined}
      data-dragging={offset || resizing ? '' : undefined}
      style={style}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onClickCapture={onClickCapture}
      role={props.mini ? 'region' : undefined}
      aria-label={bar ? 'Now playing' : props.mini ? 'Mini player' : undefined}
    >
      {props.children}
      {floating && (
        <button
          type="button"
          className="mini-grip"
          aria-label="Resize the mini player"
          title="Drag to resize"
          onPointerDown={gripDown}
          onPointerMove={gripMove}
          onPointerUp={gripUp}
          onPointerCancel={gripUp}
          onKeyDown={gripKey}
        />
      )}
    </div>
  );
}
