/**
 * Instant search over live/movies/series via FTS5 (prefix tokens, diacritics folded by the tokenizer).
 *
 * Big catalogs: a one-letter prefix matches most of a 195k item panel, and ranking every match
 * (bm25) for every keystroke is too slow. So each kind ranks at most CANDIDATES visible matches
 * (taken in index order, hidden items filtered on the way) and returns the best `limit`, names
 * that start with the query first.
 */
import type { HideRules, MediaKind, SearchResults } from '@anycast/shared';
import { hideClause, KIND_INDEX, KIND_TABLE, toChannel, toMovie, toSeries, type ChannelRow, type MovieRow, type SeriesRow } from './catalog/store';
import type { Db } from './db';

/** visible matches ranked per kind and query */
const CANDIDATES = 600;
/** results per kind */
export const SEARCH_LIMIT = 40;

function tokensOf(input: string): string[] {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
}

/** User text -> FTS5 query: every token must match as a prefix. Returns null when nothing searchable. */
function toFtsQuery(tokens: string[]): string | null {
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

export function search(db: Db, q: string, rules: HideRules, limit = SEARCH_LIMIT): SearchResults {
  const tokens = tokensOf(q);
  const fts = toFtsQuery(tokens);
  if (!fts) return { live: [], movies: [], series: [] };
  const lead = tokens[0]!;
  const run = <R>(kind: MediaKind) => {
    const hide = hideClause(rules, 't');
    // rowid = item rowid * 4 + kind; the kind test on the rowid needs no column read
    return db
      .prepare(
        `SELECT * FROM (
           SELECT t.*, f.rank AS _rank FROM search_fts f JOIN ${KIND_TABLE[kind]} t ON t.rowid = f.rowid >> 2
           WHERE search_fts MATCH ? AND (f.rowid & 3) = ? AND ${hide.sql}
           LIMIT ${CANDIDATES}
         ) ORDER BY (instr(lower(name), ?) = 1) DESC, _rank, length(name) LIMIT ?`,
      )
      .all(fts, KIND_INDEX[kind], ...hide.params, lead, limit) as R[];
  };
  return {
    live: run<ChannelRow>('live').map(toChannel),
    movies: run<MovieRow>('movie').map(toMovie),
    series: run<SeriesRow>('series').map(toSeries),
  };
}
