/** The mini player's size (per device): small, medium or large. Shared by the frame and its size button. */
import { useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../lib/storage';

export type MiniSize = 's' | 'm' | 'l';
export const MINI_SIZES: MiniSize[] = ['s', 'm', 'l'];
export const MINI_SIZE_LABEL: Record<MiniSize, string> = { s: 'Small', m: 'Medium', l: 'Large' };
const KEY = 'anycast.miniSize';

const read = (): MiniSize => {
  const v = readLocal(KEY) as MiniSize | null;
  return v && MINI_SIZES.includes(v) ? v : 'm';
};
let current: MiniSize = read();
const listeners = new Set<() => void>();

export function setMiniSize(s: MiniSize) {
  current = s;
  writeLocal(KEY, s === 'm' ? null : s);
  // a preset replaces a width that was dragged
  width = null;
  writeLocal(WIDTH_KEY, null);
  listeners.forEach((l) => l());
}

/* A width of the viewer's own, from dragging the mini player's corner (desktop and tablets). */
const WIDTH_KEY = 'anycast.miniWidth';
export const MINI_MIN_WIDTH = 224;
const MINI_MARGIN = 20;

/** Keeps a dragged width usable: not tiny, and the whole 16:9 frame stays on screen. */
export function clampMiniWidth(w: number, viewW: number, viewH: number): number {
  const max = Math.max(MINI_MIN_WIDTH, Math.min(viewW - 2 * MINI_MARGIN, ((viewH - 2 * MINI_MARGIN) * 16) / 9));
  return Math.round(Math.min(max, Math.max(MINI_MIN_WIDTH, w)));
}

const readWidth = (): number | null => {
  const n = Number(readLocal(WIDTH_KEY));
  return Number.isFinite(n) && n >= MINI_MIN_WIDTH ? n : null;
};
let width: number | null = readWidth();

/** `persist: false` while the drag is still going. */
export function setMiniWidth(px: number | null, persist = true) {
  width = px;
  if (persist) writeLocal(WIDTH_KEY, px === null ? null : String(Math.round(px)));
  listeners.forEach((l) => l());
}

export function useMiniWidth(): number | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => width,
    () => width,
  );
}

/** small → medium → large → small */
export const nextMiniSize = (s: MiniSize): MiniSize => MINI_SIZES[(MINI_SIZES.indexOf(s) + 1) % MINI_SIZES.length]!;

export function useMiniSize(): MiniSize {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
    () => current,
  );
}
