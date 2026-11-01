/**
 * Catalog helpers on top of the contract: category lists filtered by hide rules,
 * an id -> item cache filled by every list we load, and favorites resolution.
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

const LIST_ROUTE = { live: 'GET /api/live', movie: 'GET /api/movies', series: 'GET /api/series' } as const;

/**
 * Resolve favorite ids to items. The contract has no "get by ids" route, so we use the cache and walk
 * pages of the full list (1000 at a time) until every id is found. (Proposed: `ids` query param.)
 */
export async function resolveItems<K extends MediaKind>(
  kind: K,
  ids: string[],
  opts: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<NonNullable<ReturnType<typeof lookup<K>>>[]> {
  const found = new Set<string>(opts.fresh ? [] : ids.filter((id) => lookup(kind, id)));
  const PAGE = 1000;
  for (let offset = 0; found.size < ids.length && offset < 20 * PAGE; offset += PAGE) {
    const res = await call(LIST_ROUTE[kind], { query: { offset, limit: PAGE } as never, signal: opts.signal });
    remember(kind, res.items as AnyItem[]);
    for (const x of res.items) if (ids.includes(x.id)) found.add(x.id);
    if (offset + PAGE >= res.total) break;
  }
  return ids.map((id) => lookup(kind, id)).filter((x): x is NonNullable<typeof x> => !!x);
}
