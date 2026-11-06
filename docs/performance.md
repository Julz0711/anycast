# Performance at a real provider's scale

The PRD sizes AnyCast for 50k items. The provider it actually runs against has about 19.8k live
channels, 139k movies and 35.7k series (~195k items), a guide for ~4k channels and one connection.
This page measures the server at that size and records what was changed to get there.

## How to measure

```sh
pnpm install
pnpm run perf                       # a few minutes; add -- --no-web to skip the web build
pnpm run perf -- --size huge --json out.json
```

`pnpm run perf` (`apps/server/test/perf/bench.ts`, not part of `pnpm test`) starts the mock
provider with its `real` size (the item counts above, ~4,000 guide channels, 7 days back and 2
ahead: a 45 MB movie list and a 236 MB XMLTV) and the server as separate processes, like in
production. It syncs into a temp `DATA_DIR`, then reports sync time per phase, memory, database size,
p50/p95 of the requests the app makes (lists with category filters and paging, search with 1-3
letter and longer queries, a guide window, favorites, continue watching), each with no hide rules,
with 8 countries hidden and with the adult lock on on top; the latency of app requests while a
re-sync runs; and the web app's initial gzipped JS from a production build. It ends with the PRD
targets.

Measured in a 4-core container, Node 22. Memory is the server process's RSS (the harness and the
image both start node directly). Idle RSS depends on when the garbage collector last ran: two runs
of the final version gave 146 and 210 MB.

## Before and after

| | before | after | PRD target |
|---|---:|---:|---:|
| Catalog sync (195k items) | 13.4 s | 7.2-7.6 s | < 2 min (50k) |
| of which movies (139k) | 9.2 s | 5.0 s | |
| EPG sync (890k programmes) | 28.8 s | 7.4-7.8 s | hourly |
| Peak RSS during first sync | 299 MB | 221-232 MB | |
| Idle RSS after sync | 285 MB | 146-210 MB | < 300 MB |
| Database | 227 MB | 194 MB + WAL | |
| Search p95, all queries / 1-3 letters | 12.3 / 11.6 ms | 12-17 / 10-15 ms | < 150 ms (50k) |
| Movies first page p50 | 18.8 ms | 2.4 ms | |
| Movies deep page (offset 139k) p50 | 44.6 ms | 25 ms | |
| Series first page p50 | 8.0 ms | 2.2 ms | |
| Live first page p50 | 5.3 ms | 2.9 ms | |
| Guide, 30 channels x 6 h p50 | 3.6 ms | 3.3 ms | |
| Favorites / continue watching p50 | 1.4 / 2.8 ms | 1.5 / 3.0 ms | |
| App requests during a re-sync, p50 | 72-113 ms | 18-29 ms | usable |
| ... p95 | 158-220 ms | 29-80 ms | |
| ... worst | 525 ms | 80-140 ms | |
| Web initial JS, gzipped | 92 KB | 92 KB | < 300 KB |

With 8 countries hidden or the adult lock on, every list, guide and search request stays in the
same range (worst p95: movies deep page 41 ms, search 17 ms). The server Docker image also no longer
runs a second ~55 MB node process (see below), which these numbers do not include.

## What changed

- **EPG end index dropped.** It served only the hourly cleanup, and keeping it current was three
  quarters of an EPG sync: random inserts into a 26 MB index for every programme. The cleanup now
  walks the guide one channel id at a time along the primary key, in short transactions.
- **Sync in short stretches.** A sync used to write 2000 rows per transaction and only then let
  requests run, which held the event loop 70-140 ms at a time (more on a re-sync, whose upserts
  cost more). A stretch now ends when parsing plus the estimated write time reaches 20 ms.
- **Search rows written apart.** FTS5 writes an index segment per commit, so search rows are
  queued and written 3000 per transaction; a re-sync skips rows whose name did not change.
- **No zod per list item.** The streamed live, movie and series lists go through small parsers
  built from the same field conversions as the zod schemas (a test checks they agree). zod cost
  ~20 µs per item: reading the movie list went from 3.7 s to 1.4 s.
- **WAL checkpoints every 16 MB** instead of 4 MB: the sync's many small commits kept writing the
  same pages back to the database file. Catalog sync ~20% faster; a checkpoint holds the event
  loop up to ~90 ms, which is the worst case left during a sync.
- **Page totals cached between syncs.** Counting the visible rows of the movie list with the adult
  categories hidden walked most of an index on every page (~15 ms).
- **Faster XMLTV text extraction** (regexes compiled once, plain text skips the markup passes).
- **Docker image starts node directly** (`node --max-semi-space-size=4 --import tsx`) instead of the
  tsx CLI, which kept a second node process (~55 MB) only to relay signals. The smaller young
  generation keeps the heap ~35 MB lower after a sync with no measurable cost in speed.

Already in place before this round: streamed JSON parsing of the big lists, FTS5 search capped at
600 ranked candidates per kind, list indexes that carry the hide-rule columns, the `/api/tags` cache.

## Left as is

- Deep pages use `OFFSET`, so the last page of the 139k movie list costs ~25 ms. The app scrolls
  through pages near the top, so cursors are not worth the API change.
- `/api/live?limit=500` (the player's channel list) runs one now/next query per channel: ~8 ms.
- The mock's XMLTV takes ~5 s to generate, so most of the remaining EPG sync time is the provider.
