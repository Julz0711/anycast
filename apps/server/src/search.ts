/** Instant search over live/movies/series via FTS5 (prefix tokens, diacritics folded by the tokenizer). */
import type { HideRules, MediaKind, SearchResults } from '@anycast/shared';
import { hideClause, KIND_TABLE, toChannel, toMovie, toSeries, type ChannelRow, type MovieRow, type SeriesRow } from './catalog/store';
import type { Db } from './db';

/** User text -> FTS5 query: every token must match as a prefix. Returns null when nothing searchable. */
function toFtsQuery(input: string): string | null {
  const tokens = input
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

export function search(db: Db, q: string, rules: HideRules, limit = 50): SearchResults {
  const fts = toFtsQuery(q);
  if (!fts) return { live: [], movies: [], series: [] };
  const run = <R>(kind: MediaKind) => {
    const hide = hideClause(rules, 't');
    return db
      .prepare(
        `SELECT t.* FROM search_fts f JOIN ${KIND_TABLE[kind]} t ON t.rowid = f.rowid >> 2
         WHERE search_fts MATCH ? AND f.kind = ? AND ${hide.sql}
         ORDER BY f.rank LIMIT ?`,
      )
      .all(fts, kind, ...hide.params, limit) as R[];
  };
  return {
    live: run<ChannelRow>('live').map(toChannel),
    movies: run<MovieRow>('movie').map(toMovie),
    series: run<SeriesRow>('series').map(toSeries),
  };
}
