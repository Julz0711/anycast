/** Pure helpers behind the reorderable lists (components/Sortable.tsx) and list membership. */

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
