/**
 * Swipe: random movies and series, one card at a time. Right (or the bookmark) puts the title in
 * Watch Later, left (or ✕) passes on it for good, and Undo takes the last swipe back. Works with
 * touch and mouse (drag the card), keys (← → ↑ Z) and the TV remote (the buttons).
 *
 * The deck lives in this module, per filter, so opening a title and coming back finds it as it was.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Category, SwipeCard, SwipeKind } from '@anycast/shared';
import { useApp } from '../store/app';
import { call, errorMessage } from '../api/client';
import { remember, visibleCategories } from '../api/catalog';
import { toggleInMediaList, watchLater } from '../store/lists';
import { toast } from '../store/actions';
import { useAsync, useFormFactor } from '../lib/hooks';
import { isTypingTarget, toneFor } from '../lib/misc';
import { readLocal, writeLocal } from '../lib/storage';
import { fmtLength } from '../lib/time';
import { Empty, Segmented, Skeleton } from '../components/ui';
import { PhoneHeadActions } from '../components/PageHead';
import { IconBack, IconBookmark, IconClose, IconInfo, IconRefresh, IconStar } from '../components/Icons';
import { catLabel } from './Live';
import '../theme/swipe.css';

type Dir = 'left' | 'right';
interface Filter { kind: SwipeKind; categoryId: string; minRating: number }
interface Deck { cards: SwipeCard[]; history: { card: SwipeCard; dir: Dir }[]; left: number | null; done: boolean; saved: number; passed: number }

const FILTER_KEY = 'anycast.swipe';
const REFILL_AT = 6;
const BATCH = 20;
/** how far (share of the card width) a drag must go to count as a swipe */
const THRESHOLD = 0.28;
const RATINGS = [
  { value: 0, label: 'Any rating' },
  { value: 6, label: 'Rated 6+' },
  { value: 7, label: 'Rated 7+' },
  { value: 8, label: 'Rated 8+' },
];

const keyOf = (c: SwipeCard) => `${c.kind}:${c.item.id}`;
const filterKey = (f: Filter) => `${f.kind}|${f.kind === 'all' ? '' : f.categoryId}|${f.minRating}`;
const decks = new Map<string, Deck>();
/** Forget the dealt decks (after passed titles came back). */
export const resetSwipeDecks = () => decks.clear();

function readFilter(kindParam: string | null): Filter {
  let saved: Partial<Filter> = {};
  try {
    saved = JSON.parse(readLocal(FILTER_KEY) ?? '{}') as Partial<Filter>;
  } catch {
    /* ignore */
  }
  const kind = (['all', 'movie', 'series'] as const).find((k) => k === (kindParam ?? saved.kind)) ?? 'all';
  return {
    kind,
    categoryId: kind === saved.kind && typeof saved.categoryId === 'string' ? saved.categoryId : '',
    minRating: RATINGS.some((r) => r.value === saved.minRating) ? saved.minRating! : 0,
  };
}

export function SwipeScreen() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const form = useFormFactor();
  const rules = useApp((s) => s.hideRules);
  const version = useApp((s) => s.catalogVersion);
  const profileId = useApp((s) => s.profileId);
  const wl = useApp((s) => watchLater(s.mediaLists));
  const [filter, setFilterState] = useState(() => readFilter(params.get('kind')));
  const setFilter = (f: Filter) => {
    setFilterState(f);
    writeLocal(FILTER_KEY, JSON.stringify(f));
    setParams(f.kind === 'all' ? {} : { kind: f.kind }, { replace: true });
  };
  const fkey = `${profileId}|${filterKey(filter)}`;
  const [deck, setDeckState] = useState<Deck>(() => decks.get(fkey) ?? { cards: [], history: [], left: null, done: false, saved: 0, passed: 0 });
  const deckRef = useRef(deck);
  const setDeck = useCallback(
    (fn: (d: Deck) => Deck) => {
      const next = fn(deckRef.current);
      deckRef.current = next;
      decks.set(fkey, next);
      setDeckState(next);
    },
    [fkey],
  );
  const [error, setError] = useState<string | null>(null);
  const loading = useRef<string | null>(null);
  const fkeyRef = useRef(fkey);
  fkeyRef.current = fkey;

  // another filter or profile: its own deck
  useEffect(() => {
    const d = decks.get(fkey) ?? { cards: [], history: [], left: null, done: false, saved: 0, passed: 0 };
    deckRef.current = d;
    setDeckState(d);
    setError(null);
  }, [fkey]);

  const refill = useCallback(async () => {
    const d = deckRef.current;
    if (loading.current === fkey || d.done || d.cards.length > REFILL_AT) return;
    loading.current = fkey;
    try {
      const skip = [...d.cards, ...d.history.map((h) => h.card)].slice(-300).map(keyOf).join(',');
      const res = await call('GET /api/swipe', {
        query: {
          kind: filter.kind,
          ...(filter.kind !== 'all' && filter.categoryId ? { categoryId: filter.categoryId } : {}),
          ...(filter.minRating ? { minRating: filter.minRating } : {}),
          limit: BATCH,
          ...(skip ? { skip } : {}),
        },
      });
      if (fkeyRef.current !== fkey) return;
      remember('movie', res.cards.flatMap((c) => (c.kind === 'movie' ? [c.item] : [])));
      remember('series', res.cards.flatMap((c) => (c.kind === 'series' ? [c.item] : [])));
      setDeck((cur) => {
        const have = new Set(cur.cards.map(keyOf));
        const fresh = res.cards.filter((c) => !have.has(keyOf(c)));
        return { ...cur, cards: [...cur.cards, ...fresh], left: res.left, done: fresh.length === 0 };
      });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (loading.current === fkey) loading.current = null;
    }
  }, [fkey, filter, setDeck]);

  useEffect(() => {
    if (deck.cards.length <= REFILL_AT && !deck.done && !error) void refill();
  }, [deck.cards.length, deck.done, error, refill]);

  // a catalog sync or new hide rules: deal again
  const firstVersion = useRef(`${version}|${JSON.stringify(rules)}`);
  useEffect(() => {
    const v = `${version}|${JSON.stringify(rules)}`;
    if (v === firstVersion.current) return;
    firstVersion.current = v;
    decks.clear();
    setDeck(() => ({ cards: [], history: [], left: null, done: false, saved: 0, passed: 0 }));
  }, [version, rules, setDeck]);

  // warm the next posters
  useEffect(() => {
    for (const c of deck.cards.slice(1, 5)) if (c.item.poster) new Image().src = c.item.poster;
  }, [deck.cards]);

  const top = deck.cards[0];

  const act = useCallback(
    (card: SwipeCard, dir: Dir) => {
      setDeck((d) => ({
        ...d,
        cards: d.cards.filter((c) => keyOf(c) !== keyOf(card)),
        history: [...d.history.slice(-99), { card, dir }],
        left: d.left === null ? null : Math.max(0, d.left - 1),
        saved: d.saved + (dir === 'right' ? 1 : 0),
        passed: d.passed + (dir === 'left' ? 1 : 0),
      }));
      if (dir === 'right') {
        if (wl) void toggleInMediaList(wl.id, card.kind, card.item.id, true);
      } else {
        call('POST /api/swipe/passed', { body: { kind: card.kind, id: card.item.id } }).catch((e) => toast(`Couldn't pass on ${card.item.name}: ${errorMessage(e)}`, 'error'));
      }
    },
    [setDeck, wl],
  );

  const undo = useCallback(() => {
    const last = deckRef.current.history.at(-1);
    if (!last) return;
    setDeck((d) => ({
      ...d,
      cards: [last.card, ...d.cards.filter((c) => keyOf(c) !== keyOf(last.card))],
      history: d.history.slice(0, -1),
      left: d.left === null ? null : d.left + 1,
      done: false,
      saved: d.saved - (last.dir === 'right' ? 1 : 0),
      passed: d.passed - (last.dir === 'left' ? 1 : 0),
    }));
    const { card } = last;
    if (last.dir === 'right') {
      if (wl) void toggleInMediaList(wl.id, card.kind, card.item.id, false);
    } else {
      call('DELETE /api/swipe/passed/:kind/:id', { params: { kind: card.kind, id: card.item.id } }).catch(() => undefined);
    }
  }, [setDeck, wl]);

  const open = useCallback((c: SwipeCard) => navigate(c.kind === 'movie' ? `/movies/${c.item.id}` : `/series/${c.item.id}`), [navigate]);

  // the top card flies out first, then the swipe counts
  const stack = useRef<CardHandle | null>(null);
  const swipe = useCallback(
    (dir: Dir) => {
      const c = deckRef.current.cards[0];
      if (!c) return;
      if (stack.current) stack.current.fly(dir, () => act(c, dir));
      else act(c, dir);
    },
    [act],
  );

  // keys: ← pass, → watch later, ↑ details, Z or Backspace undo (the TV remote uses the buttons)
  useEffect(() => {
    if (form === 'tv') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const k = e.key;
      if (e.ctrlKey && k.toLowerCase() !== 'z') return;
      if (k === 'ArrowLeft') swipe('left');
      else if (k === 'ArrowRight') swipe('right');
      else if (k === 'ArrowUp' && deckRef.current.cards[0]) open(deckRef.current.cards[0]);
      else if (k.toLowerCase() === 'z' || k === 'Backspace') undo();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [form, swipe, undo, open]);

  const cats = useAsync(
    () => (filter.kind === 'all' ? Promise.resolve([] as Category[]) : visibleCategories(filter.kind, rules)),
    [filter.kind, rules, version],
  );

  const bringBack = async () => {
    try {
      await call('DELETE /api/swipe/passed');
      decks.clear();
      setDeck(() => ({ cards: [], history: [], left: null, done: false, saved: 0, passed: 0 }));
      setError(null);
      toast('Passed titles are back in the deck', 'info');
    } catch (e) {
      toast(`Couldn't bring them back: ${errorMessage(e)}`, 'error');
    }
  };

  const phone = form === 'phone';
  const filtered = filter.minRating > 0 || (filter.kind !== 'all' && !!filter.categoryId);
  const status =
    deck.saved + deck.passed > 0
      ? `${deck.saved} saved · ${deck.passed} passed`
      : deck.left !== null
        ? `${deck.left.toLocaleString()} ${deck.left === 1 ? 'title' : 'titles'} to go`
        : '';

  return (
    <div className="swipe-screen">
      <div className="page-head">
        <div className="swipe-title">
          {!phone && (
            <button type="button" className="icon-btn" aria-label="Back" onClick={() => ((history.state?.idx ?? 0) > 0 ? navigate(-1) : navigate('/movies'))}>
              <IconBack />
            </button>
          )}
          <h1 className="h1">Swipe</h1>
        </div>
        <PhoneHeadActions>
          {!phone && <span className="swipe-status tabnum muted" aria-live="polite">{status}</span>}
        </PhoneHeadActions>
      </div>

      <div className="swipe-filters" role="group" aria-label="What to swipe through" data-nav-row="swipe-filters">
        <Segmented
          label="Show"
          value={filter.kind}
          options={[
            { value: 'all', label: 'Both' },
            { value: 'movie', label: 'Movies' },
            { value: 'series', label: 'Series' },
          ]}
          onChange={(kind) => setFilter({ ...filter, kind, categoryId: '' })}
        />
        {filter.kind !== 'all' && (
          <select
            className={`input vod-select${filter.categoryId ? ' on' : ''}`}
            aria-label="Category"
            value={filter.categoryId}
            onChange={(e) => setFilter({ ...filter, categoryId: e.target.value })}
          >
            <option value="">All categories</option>
            {(cats.data ?? []).filter((c) => !c.locked).map((c) => (
              <option key={c.id} value={c.id}>
                {catLabel(c)}
              </option>
            ))}
          </select>
        )}
        <select className={`input vod-select${filter.minRating ? ' on' : ''}`} aria-label="Rating" value={filter.minRating} onChange={(e) => setFilter({ ...filter, minRating: Number(e.target.value) })}>
          {RATINGS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {phone && status && <p className="swipe-status phone tabnum muted" aria-live="polite">{status}</p>}

      <div className="swipe-stage">
        {top ? (
          <CardStack key={fkey} cards={deck.cards} handle={stack} onSwipe={(c, dir) => act(c, dir)} onOpen={open} />
        ) : error ? (
          <Empty title="Couldn't load the deck">
            <p>{error}</p>
            <button type="button" className="btn" onClick={() => (setError(null), void refill())}>
              <IconRefresh /> Try again
            </button>
          </Empty>
        ) : deck.done ? (
          <Empty title="That's everything">
            <p>{filtered ? 'Nothing left with these filters. Try another category or rating.' : 'You have been through every title. Bring back the ones you passed on to go again.'}</p>
            <div className="swipe-empty-actions">
              {filtered && (
                <button type="button" className="btn" onClick={() => setFilter({ ...filter, categoryId: '', minRating: 0 })}>
                  Clear filters
                </button>
              )}
              <button type="button" className="btn" onClick={() => void bringBack()}>
                Bring back passed titles
              </button>
            </div>
          </Empty>
        ) : (
          <div className="swipe-deck" aria-hidden="true">
            <Skeleton className="swipe-card" r="1.25rem" h="100%" />
          </div>
        )}
      </div>

      <div className="swipe-actions" data-nav-row="swipe-actions">
        <button type="button" className="swipe-btn small" aria-label="Undo" title="Undo (Z)" disabled={!deck.history.length} onClick={undo}>
          <IconUndo />
        </button>
        <button type="button" className="swipe-btn pass" aria-label={top ? `Pass on ${top.item.name}` : 'Pass'} title="Pass (←)" disabled={!top} onClick={() => swipe('left')}>
          <IconClose />
        </button>
        <button
          type="button"
          className="swipe-btn save"
          aria-label={top ? `Watch ${top.item.name} later` : 'Watch later'}
          title="Watch later (→)"
          disabled={!top}
          data-nav-autofocus=""
          onClick={() => swipe('right')}
        >
          <IconBookmark filled />
        </button>
        <button type="button" className="swipe-btn small" aria-label={top ? `Details of ${top.item.name}` : 'Details'} title="Details (↑)" disabled={!top} onClick={() => top && open(top)}>
          <IconInfo />
        </button>
      </div>
      {form === 'large' && (
        <p className="swipe-keys muted" aria-hidden="true">
          <kbd>←</kbd> pass <kbd>→</kbd> watch later <kbd>↑</kbd> details <kbd>Z</kbd> undo
        </p>
      )}
    </div>
  );
}

const IconUndo = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="ico">
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
  </svg>
);

/* ---------------- the cards ---------------- */

interface CardHandle {
  fly: (dir: Dir, then: () => void) => void;
}

function CardStack(props: { cards: SwipeCard[]; handle: React.MutableRefObject<CardHandle | null>; onSwipe: (c: SwipeCard, dir: Dir) => void; onOpen: (c: SwipeCard) => void }) {
  // the same element moves up the stack, so the next card eases forward when the top one leaves
  return (
    <div className="swipe-deck">
      {props.cards
        .slice(0, 3)
        .map((c, i) => <Card key={keyOf(c)} card={c} depth={i} handle={props.handle} onSwipe={props.onSwipe} onOpen={props.onOpen} />)
        .reverse()}
    </div>
  );
}

function Card(props: {
  card: SwipeCard;
  depth: number;
  handle: React.MutableRefObject<CardHandle | null>;
  onSwipe: (c: SwipeCard, dir: Dir) => void;
  onOpen: (c: SwipeCard) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; t: number; dx: number; dy: number; moved: boolean } | null>(null);
  const gone = useRef(false);
  const { card, onSwipe, onOpen, depth } = props;
  const isTop = depth === 0;

  const paint = (dx: number, dy: number) => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)` : '';
    const w = el.offsetWidth || 300;
    el.style.setProperty('--save', String(Math.max(0, Math.min(1, dx / (w * THRESHOLD)))));
    el.style.setProperty('--pass', String(Math.max(0, Math.min(1, -dx / (w * THRESHOLD)))));
  };

  const fly = useCallback((dir: Dir, then: () => void) => {
    const el = ref.current;
    if (!el || gone.current) return;
    gone.current = true;
    const sign = dir === 'right' ? 1 : -1;
    const dy = drag.current?.dy ?? 0;
    el.classList.remove('settle', 'dragging');
    el.classList.add('flying');
    el.style.setProperty(dir === 'right' ? '--save' : '--pass', '1');
    el.style.transform = `translate(${sign * Math.max(window.innerWidth, 900)}px, ${dy + 60}px) rotate(${sign * 28}deg)`;
    const anim = document.documentElement.dataset.anim;
    setTimeout(then, anim === 'off' || anim === 'reduced' ? 0 : 260);
  }, []);

  useEffect(() => {
    if (!isTop) return;
    const h = { fly };
    props.handle.current = h;
    return () => {
      if (props.handle.current === h) props.handle.current = null;
    };
  }, [isTop, fly, props.handle]);

  const onDown = (e: React.PointerEvent) => {
    if (!isTop || gone.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, dy: 0, moved: false };
    ref.current?.setPointerCapture(e.pointerId);
    ref.current?.classList.remove('settle');
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dx = e.clientX - d.x;
    d.dy = (e.clientY - d.y) * 0.35;
    if (!d.moved && Math.hypot(d.dx, e.clientY - d.y) > 6) {
      d.moved = true;
      ref.current?.classList.add('dragging');
    }
    if (d.moved) paint(d.dx, d.dy);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const el = ref.current;
    el?.classList.remove('dragging');
    if (!d.moved) {
      drag.current = null;
      if (e.type === 'pointerup') onOpen(card);
      return;
    }
    const w = el?.offsetWidth || 300;
    const speed = d.dx / Math.max(1, performance.now() - d.t);
    const fast = Math.abs(speed) > 0.6 && Math.abs(d.dx) > 40;
    if (e.type === 'pointerup' && (Math.abs(d.dx) > w * THRESHOLD || fast)) {
      const dir: Dir = d.dx > 0 ? 'right' : 'left';
      fly(dir, () => onSwipe(card, dir));
    } else {
      el?.classList.add('settle');
      paint(0, 0);
    }
    drag.current = null;
  };

  return (
    <div
      ref={ref}
      className={`swipe-card d${depth}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      role={isTop ? 'group' : undefined}
      aria-roledescription={isTop ? 'card' : undefined}
      aria-label={isTop ? cardLabel(card) : undefined}
      aria-hidden={isTop ? undefined : true}
    >
      <CardBody card={card} />
      {isTop && (
        <>
          <span className="swipe-stamp save" aria-hidden="true">
            <IconBookmark filled /> Watch later
          </span>
          <span className="swipe-stamp pass" aria-hidden="true">
            <IconClose /> Pass
          </span>
        </>
      )}
    </div>
  );
}

function cardLabel(c: SwipeCard) {
  const meta = [c.kind === 'movie' ? 'Movie' : 'Series', c.item.year, c.item.rating ? `rated ${c.item.rating.toFixed(1)}` : null].filter(Boolean).join(', ');
  return `${c.item.name}, ${meta}`;
}

function CardBody({ card }: { card: SwipeCard }) {
  const showArt = useApp((s) => s.prefs.appearance.showArtwork);
  const [broken, setBroken] = useState(false);
  const { item } = card;
  const meta = useMemo(
    () => [card.kind === 'movie' ? 'Movie' : 'Series', item.year, card.kind === 'movie' && card.item.duration ? fmtLength(card.item.duration) : null].filter(Boolean).join(' · '),
    [card, item.year],
  );
  return (
    <>
      <div className="swipe-art" style={{ background: toneFor(item.id) }}>
        {showArt && item.poster && !broken ? <img src={item.poster} alt="" draggable={false} decoding="async" onError={() => setBroken(true)} /> : <span className="ph">{item.name}</span>}
      </div>
      <div className="swipe-info">
        <div className="swipe-meta tabnum">
          {meta}
          {item.rating ? (
            <span className="swipe-rating">
              <IconStar filled /> {item.rating.toFixed(1)}
            </span>
          ) : null}
        </div>
        <h2 className="swipe-name">{item.name}</h2>
        {item.plot && <p className="swipe-plot">{item.plot}</p>}
      </div>
    </>
  );
}
