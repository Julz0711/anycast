/** Pure helpers behind drag-to-reorder and the up/down buttons (channel lists, LB-3). */

/** A copy of `arr` with the item at `from` moved to index `to` (clamped). */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = arr.slice();
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item as T);
  return out;
}

/** Adds `id` at the end, or removes it. */
export function toggleId(ids: readonly string[], id: string, on: boolean): string[] {
  const without = ids.filter((x) => x !== id);
  return on ? [...without, id] : without;
}

/**
 * Where the dragged item lands: `mids` are the vertical centres of every item before the drag
 * started (same coordinates as `y`), `from` the dragged item's index, `y` the dragged item's centre now.
 * The answer is how many other items have their centre above it.
 */
export function dropIndex(mids: readonly number[], from: number, y: number): number {
  let n = 0;
  for (let i = 0; i < mids.length; i++) if (i !== from && mids[i]! < y) n++;
  return n;
}

/** How a non-dragged item at `i` shifts while the dragged one goes from `from` to `to`: -1 up, 1 down, 0 stays. */
export function shiftFor(i: number, from: number, to: number): -1 | 0 | 1 {
  if (i === from) return 0;
  if (from < to && i > from && i <= to) return -1;
  if (to < from && i >= to && i < from) return 1;
  return 0;
}
