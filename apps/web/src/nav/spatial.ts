/**
 * Compact spatial (D-pad) navigation for TV.
 * - Focusable: buttons, links, inputs, [tabindex=0], [data-nav]; opt out with data-nav="off".
 * - Arrow keys move focus to the nearest element in that direction (pickNearest).
 * - Elements inside [data-nav-row="id"] share a row; re-entering a row restores its last focused element.
 * - Components can claim a key first by calling preventDefault() (e.g. the timeline slider for left/right).
 */
export type Dir = 'up' | 'down' | 'left' | 'right';
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const KEY_DIR: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/** Pure: choose the candidate nearest to `from` in `dir`. Orthogonal offset weighs 3x the travel distance. */
export function pickNearest<T>(from: Rect, candidates: { rect: Rect; item: T }[], dir: Dir): T | null {
  const cx = (from.left + from.right) / 2;
  const cy = (from.top + from.bottom) / 2;
  let best: T | null = null;
  let bestScore = Infinity;
  for (const { rect: r, item } of candidates) {
    const rcx = (r.left + r.right) / 2;
    const rcy = (r.top + r.bottom) / 2;
    let travel: number;
    let ortho: number;
    if (dir === 'left' || dir === 'right') {
      if (dir === 'right' ? rcx <= cx + 1 || r.right <= from.right : rcx >= cx - 1 || r.left >= from.left) continue;
      travel = dir === 'right' ? Math.max(0, r.left - from.right) : Math.max(0, from.left - r.right);
      const overlap = Math.min(r.bottom, from.bottom) - Math.max(r.top, from.top);
      ortho = overlap > 0 ? 0 : Math.abs(rcy - cy);
    } else {
      if (dir === 'down' ? rcy <= cy + 1 || r.bottom <= from.bottom : rcy >= cy - 1 || r.top >= from.top) continue;
      travel = dir === 'down' ? Math.max(0, r.top - from.bottom) : Math.max(0, from.top - r.bottom);
      const overlap = Math.min(r.right, from.right) - Math.max(r.left, from.left);
      ortho = overlap > 0 ? 0 : Math.abs(rcx - cx);
    }
    const score = travel + ortho * 3;
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea, [tabindex="0"], [data-nav]';

function visible(el: HTMLElement): boolean {
  if (el.dataset.nav === 'off' || el.closest('[inert],[aria-hidden="true"]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > -2000 && r.top < innerHeight + 2000;
}

export function focusables(scope: ParentNode = document): HTMLElement[] {
  // A modal layer (data-nav-trap) restricts navigation to itself.
  const traps = document.querySelectorAll<HTMLElement>('[data-nav-trap]');
  const root = traps.length ? traps[traps.length - 1]! : scope;
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
}

const lastInRow = new Map<string, HTMLElement>();
const rowOf = (el: Element | null) => (el as HTMLElement | null)?.closest<HTMLElement>('[data-nav-row]')?.dataset.navRow ?? null;

export function moveFocus(dir: Dir): boolean {
  const active = document.activeElement as HTMLElement | null;
  const all = focusables();
  if (!active || active === document.body || !all.includes(active)) {
    const first = document.querySelector<HTMLElement>('[data-nav-autofocus]') ?? all[0];
    first?.focus();
    return !!first;
  }
  const others = all.filter((el) => el !== active);
  const target = pickNearest(active.getBoundingClientRect(), others.map((el) => ({ rect: el.getBoundingClientRect(), item: el })), dir);
  if (!target) return false;
  const fromRow = rowOf(active);
  const toRow = rowOf(target);
  let dest = target;
  if (toRow && toRow !== fromRow) {
    const remembered = lastInRow.get(toRow);
    if (remembered && remembered.isConnected && others.includes(remembered)) dest = remembered;
  }
  dest.focus({ preventScroll: true });
  dest.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

const BACK_KEYCODES = new Set([461 /* webOS */, 10009 /* Tizen */, 4 /* Android */]);
export function isBackKey(e: KeyboardEvent): boolean {
  if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') return true;
  if (e.key === 'Backspace') return !isEditable(e.target);
  return BACK_KEYCODES.has(e.keyCode);
}

function isEditable(t: EventTarget | null) {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
}

/** Install the global handler. Returns an uninstall function. */
export function installSpatialNav(opts: { enabled: () => boolean; onBack: () => void }): () => void {
  const onFocusIn = (e: FocusEvent) => {
    const row = rowOf(e.target as Element);
    if (row) lastInRow.set(row, e.target as HTMLElement);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !opts.enabled()) return;
    const dir = KEY_DIR[e.key];
    if (dir) {
      const t = e.target;
      // Inside text inputs, left/right edit text.
      if (isEditable(t) && (dir === 'left' || dir === 'right')) return;
      if (moveFocus(dir)) e.preventDefault();
      return;
    }
    if (isBackKey(e)) {
      e.preventDefault();
      opts.onBack();
    }
  };
  document.addEventListener('focusin', onFocusIn);
  window.addEventListener('keydown', onKey);
  return () => {
    document.removeEventListener('focusin', onFocusIn);
    window.removeEventListener('keydown', onKey);
  };
}
