/**
 * While something plays in the mini player or the now bar, the rest of the app can open it again
 * (the "turn your phone upright" screen offers that). PlayerHost publishes how; null when nothing plays.
 */
import { useSyncExternalStore } from 'react';

let open: (() => void) | null = null;
const listeners = new Set<() => void>();

export function setOpenPlayer(fn: (() => void) | null) {
  if (fn === open) return;
  open = fn;
  listeners.forEach((l) => l());
}

export function useOpenPlayer(): (() => void) | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => null,
  );
}
