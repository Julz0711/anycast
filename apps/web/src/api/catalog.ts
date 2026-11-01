/**
 * Catalog helpers on top of the contract: category lists filtered by hide rules,
 * an id -> item cache filled by every list we load, and resolving ids to items.
 */
import type { Category, Channel, HideRules, LiveChannelWithNow, MediaKind, Movie, Series } from '@anycast/shared';
import { cachedGet, call } from './client';

type AnyItem = Channel | LiveChannelWithNow | Movie | Series;
const items = { live: new Map<string, Channel | LiveChannelWithNow>(), movie: new Map<string, Movie>(), series: new Map<string, Series>() };

export function remember(kind: MediaKind, list: AnyItem[]) {
  const m = items[kind] as Map<string, AnyItem>;
  for (const x of list) m.set(x.id, x);
}
export function lookup<K extends MediaKind>(kind: K, id: string): (K extends 'live' ? Channel | LiveChannelWithNow : K extends 'movie' ? Movie : Series) | undefined {
  return (items[kind] as Map<string, never>).get(id);
}

export function isHidden(rules: HideRules, x: { country: string | null; language: string | null; categoryId?: string; id?: string }, isCategory = false) {
  if (x.country && rules.countries.includes(x.country)) return true;
  if (x.language && rules.languages.includes(x.language)) return true;
  if (isCategory && x.id && rules.categoryIds.includes(x.id)) return true;
  if (!isCategory && x.categoryId && rules.categoryIds.includes(x.categoryId)) return true;
  return false;
}

export async function visibleCategories(kind: MediaKind, rules: HideRules): Promise<Category[]> {
  const all = await cachedGet('GET /api/categories', { query: { kind } }, 300_000);
  return all.filter((c) => !isHidden(rules, c, true));
}

const ITEMS_KEY = { live: 'live', movie: 'movies', series: 'series' } as const;
const MAX_IDS = 500;

/**
 * Resolve ids to items (favorites, deep links) with GET /api/items. Cached items are reused unless
 * `fresh` (e.g. live rows, whose now/next goes stale). Hidden and unknown ids are left out.
 */
export async function resolveItems<K extends MediaKind>(
  kind: K,
  ids: string[],
  opts: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<NonNullable<ReturnType<typeof lookup<K>>>[]> {
  const missing = [...new Set(opts.fresh ? ids : ids.filter((id) => !lookup(kind, id)))];
  const got = new Set<string>();
  for (let i = 0; i < missing.length; i += MAX_IDS) {
    const chunk = missing.slice(i, i + MAX_IDS);
    const res = await call('GET /api/items', { query: { [kind]: chunk.join(',') }, signal: opts.signal });
    const list = res[ITEMS_KEY[kind]] as AnyItem[];
    remember(kind, list);
    for (const x of list) got.add(x.id);
  }
  // with `fresh`, ids the server left out (now hidden or gone) are not served from the cache
  return ids
    .filter((id) => !opts.fresh || got.has(id))
    .map((id) => lookup(kind, id))
    .filter((x): x is NonNullable<typeof x> => !!x);
}
