/**
 * Swipe: random movies and series to sort through, one card at a time (SwipeCard in @anycast/shared).
 *
 * The pool of a deck is every movie or series with a poster that the profile's rules let it see.
 * Listing those ids walks a big table (~140k movies), so pools are kept per catalog sync and filter.
 * What the profile already dealt with comes off per request: titles it passed on (swipe_passed),
 * titles in one of its movie and series lists (Watch Later included) and titles it started watching.
 */
import type { HideRules, SwipeCard } from '@anycast/shared';
import type { Db } from './db';
import { hideClause, itemsByIds, KIND_TABLE, toMovie, toSeries } from './catalog/store';

type Kind = 'movie' | 'series';
export interface DeckFilter {
  kinds: Kind[];
  categoryId?: string;
  minRating?: number;
}

const POOL_CACHE_MAX = 16;

export class SwipeDecks {
  private pools = new Map<string, string[]>();
  private poolsAt: string | undefined = undefined;

  constructor(
    private readonly db: Db,
    /** changes with every catalog sync (and while one runs); pools are dropped when it moves */
    private readonly catalogAt: () => string,
  ) {}

  /** Ids of every title of `kind` the filter and rules let through, in table order. */
  private pool(kind: Kind, rules: HideRules, f: DeckFilter): string[] {
    const at = this.catalogAt();
    if (at !== this.poolsAt) {
      this.pools.clear();
      this.poolsAt = at;
    }
    const key = JSON.stringify([kind, f.categoryId ?? null, f.minRating ?? null, rules.countries, rules.languages, rules.categoryIds]);
    const hit = this.pools.get(key);
    if (hit) return hit;
    const hide = hideClause(rules, 't');
    const where = ["coalesce(t.poster, '') != ''", hide.sql];
    const params: (string | number)[] = [...hide.params];
    if (f.categoryId) {
      where.push('t.category_id = ?');
      params.push(f.categoryId);
    }
    if (f.minRating) {
      where.push('t.rating >= ?');
      params.push(f.minRating);
    }
    const ids = (this.db.prepare(`SELECT t.id FROM ${KIND_TABLE[kind]} t WHERE ${where.join(' AND ')}`).pluck().all(...params) as string[]);
    if (this.pools.size >= POOL_CACHE_MAX) this.pools.delete(this.pools.keys().next().value!);
    this.pools.set(key, ids);
    return ids;
  }

  /** Titles the profile already dealt with, as "kind:id". */
  private dealtWith(profileId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT kind || ':' || item_id FROM swipe_passed WHERE profile_id = ?
         UNION SELECT i.kind || ':' || i.item_id FROM media_list_items i JOIN media_lists l ON l.id = i.list_id WHERE l.profile_id = ?
         UNION SELECT 'movie:' || item_id FROM progress WHERE profile_id = ? AND kind = 'movie'
         UNION SELECT 'series:' || series_id FROM progress WHERE profile_id = ? AND kind = 'episode' AND series_id IS NOT NULL`,
      )
      .pluck()
      .all(profileId, profileId, profileId, profileId) as string[];
    return new Set(rows);
  }

  /**
   * Up to `limit` random cards, none of them in `skip` ("kind:id"). With both kinds, each card is a
   * movie or a series with even odds (movies would otherwise bury the series), as long as both last.
   */
  deal(profileId: string, rules: HideRules, f: DeckFilter, limit: number, skip: Set<string>): { cards: SwipeCard[]; left: number } {
    const done = this.dealtWith(profileId);
    const open = f.kinds.map((kind) => ({ kind, ids: this.pool(kind, rules, f).filter((id) => !done.has(`${kind}:${id}`)) }));
    const left = open.reduce((n, p) => n + p.ids.length, 0);
    const picked: Record<Kind, string[]> = { movie: [], series: [] };
    const order: { kind: Kind; id: string }[] = [];
    const taken = new Set(skip);
    // ids left to draw from; a drawn id is swapped to the end of its pool and cut off
    const avail = open.map((p) => ({ kind: p.kind, ids: p.ids.slice(), n: p.ids.length }));
    while (order.length < limit) {
      const live = avail.filter((p) => p.n > 0);
      if (!live.length) break;
      const p = live[Math.floor(Math.random() * live.length)]!;
      const i = Math.floor(Math.random() * p.n);
      const id = p.ids[i]!;
      p.ids[i] = p.ids[p.n - 1]!;
      p.n--;
      const key = `${p.kind}:${id}`;
      if (taken.has(key)) continue;
      taken.add(key);
      picked[p.kind].push(id);
      order.push({ kind: p.kind, id });
    }
    const movies = new Map(itemsByIds(this.db, 'movie', picked.movie, rules).map((r) => [r.id, toMovie(r)]));
    const series = new Map(itemsByIds(this.db, 'series', picked.series, rules).map((r) => [r.id, toSeries(r)]));
    const cards: SwipeCard[] = [];
    for (const o of order) {
      if (o.kind === 'movie') {
        const item = movies.get(o.id);
        if (item) cards.push({ kind: 'movie', item });
      } else {
        const item = series.get(o.id);
        if (item) cards.push({ kind: 'series', item });
      }
    }
    return { cards, left };
  }

  pass(profileId: string, kind: Kind, id: string): number {
    this.db
      .prepare('INSERT INTO swipe_passed (profile_id, kind, item_id, passed_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .run(profileId, kind, id, Date.now());
    return this.passed(profileId);
  }

  unpass(profileId: string, kind: Kind, id: string): number {
    this.db.prepare('DELETE FROM swipe_passed WHERE profile_id = ? AND kind = ? AND item_id = ?').run(profileId, kind, id);
    return this.passed(profileId);
  }

  clear(profileId: string): number {
    this.db.prepare('DELETE FROM swipe_passed WHERE profile_id = ?').run(profileId);
    return 0;
  }

  passed(profileId: string): number {
    return this.db.prepare('SELECT count(*) FROM swipe_passed WHERE profile_id = ?').pluck().get(profileId) as number;
  }
}
