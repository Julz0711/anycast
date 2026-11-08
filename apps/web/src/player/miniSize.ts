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
  listeners.forEach((l) => l());
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
