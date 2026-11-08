/**
 * Keeps one player mounted for the whole app, so leaving the player can shrink it into a mini
 * player instead of stopping it. The same <video>, engine and server stream carry on (the
 * provider may allow only one connection), and expanding it again does not reload anything.
 *
 * The /play/:kind/:id route is the full-screen player. Leaving it with the mini player on keeps
 * the last item playing in a corner; with it off (or on TV) the player unmounts and stops as before.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../store/app';
import { useFormFactor } from '../lib/hooks';
import { readLocal, writeLocal } from '../lib/storage';
import { useMiniSize } from './miniSize';

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
 * when it shrinks. Mini: docked in a corner, dragged to another one, tapped to expand.
 */
function MiniFrame(props: { mini: boolean; form: string; onTap: () => void; children: React.ReactNode }) {
  const [corner, setCorner] = useState<Corner>(() => {
    const c = readLocal(CORNER_KEY) as Corner | null;
    return c && CORNERS.includes(c) ? c : 'br';
  });
  /** where the pointer went down, and the frame's centre then */
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; id: number; moved: boolean } | null>(null);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const size = useMiniSize();

  // leaving the player while in full screen: the mini player can't be full screen
  useEffect(() => {
    if (props.mini && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, [props.mini]);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!props.mini || e.button !== 0 || (e.target as HTMLElement).closest('button, a, input')) return;
    const r = e.currentTarget.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, cx: r.left + r.width / 2, cy: r.top + r.height / 2, id: e.pointerId, moved: false };
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
    setOffset({ x: dx, y: dy });
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved) return props.onTap();
    setOffset(null);
    // from the pointer, not the DOM: the last move may not have rendered yet
    const c = nearestCorner(d.cx + e.clientX - d.x, d.cy + e.clientY - d.y, window.innerWidth, window.innerHeight);
    setCorner(c);
    writeLocal(CORNER_KEY, c);
  };
  const onCancel = () => {
    drag.current = null;
    setOffset(null);
  };

  return (
    <div
      className={props.mini ? 'mini-frame' : 'player-frame'}
      data-corner={props.mini ? corner : undefined}
      data-size={props.mini ? size : undefined}
      data-dragging={offset ? '' : undefined}
      style={props.mini && offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      role={props.mini ? 'region' : undefined}
      aria-label={props.mini ? 'Mini player' : undefined}
    >
      {props.children}
    </div>
  );
}
