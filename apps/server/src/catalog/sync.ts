/**
 * Catalog and EPG sync. Rows are upserted in small transactions with a generation number and
 * stale rows pruned at the end, so the app keeps serving the previous catalog while syncing and
 * the event loop is released between batches.
 */
import type { MediaKind } from '@anycast/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Statement } from 'better-sqlite3';
import { kvGet, kvSet, type Db } from '../db';
import type { EventBus } from '../events';
import type { SourceService } from '../source';
import type { XtreamClient } from '../xtream/client';
import type { XCategory, XLiveStream, XSeries, XVodStream } from '../xtream/schemas';
import { parseXmltv } from '../xtream/xmltv';
import { KIND_INDEX, KIND_TABLE, refreshHasEpg } from './store';
import { cleanCategoryName, cleanEpisodeTitle, splitTitle } from './names';
import { tagCategory, tagItem, type Tag } from './tagger';
import { groupVariants } from './variants';
import { followedByAnyone } from './followed';

/** followed series refreshed after one sync at most (each is one provider request) */
const FOLLOWED_REFRESH_MAX = 200;

const BATCH = 2000;
/** About the longest stretch a sync keeps the event loop (parsing plus writing one transaction). */
const SLICE_MS = 20;
/** search rows per FTS transaction (see FtsWriter) */
const FTS_BATCH = 3000;
const CATALOG_INTERVAL_MS = 12 * 3600_000;
const EPG_INTERVAL_MS = 3600_000;
const EPISODES_TTL_MS = 12 * 3600_000;
const EPG_KEEP_BACK_MS = 7 * 86400_000;
const EPG_KEEP_AHEAD_MS = 2 * 86400_000;

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

const CATEGORY_PREFIX: Record<MediaKind, string> = { live: 'l', movie: 'm', series: 's' };
const categoryId = (kind: MediaKind, providerId: string | null) => `${CATEGORY_PREFIX[kind]}${providerId ?? '0'}`;

const rating = (r: number | null) => (r && r > 0 ? Math.round(r * 10) / 10 : null);

/**
 * Keeps search_fts in step with one table, in transactions of its own. FTS5 writes a new index
 * segment at every commit, so search rows are queued and written FTS_BATCH at a time instead of
 * with every short catalog transaction (which made merging segments most of a sync). And a
 * re-sync leaves most names as they were, while replacing an FTS row means tokenizing the old
 * one to delete it, so rows whose name did not change are skipped: `before(id)` is read ahead of
 * the upsert, `write` runs after it.
 */
class FtsWriter {
  private pending: [number, string, MediaKind, string][] = [];
  private readonly prev: Statement;
  private readonly tx: (rows: [number, string, MediaKind, string][]) => void;

  constructor(
    db: Db,
    private readonly kind: MediaKind,
  ) {
    this.prev = db.prepare(`SELECT name FROM ${KIND_TABLE[kind]} WHERE id = ?`).pluck();
    const stmt = db.prepare('INSERT OR REPLACE INTO search_fts (rowid, name, kind, item_id) VALUES (?, ?, ?, ?)');
    this.tx = db.transaction((rows: [number, string, MediaKind, string][]) => {
      for (const r of rows) stmt.run(...r);
    });
  }

  before(id: string): string | undefined {
    return this.prev.get(id) as string | undefined;
  }

  write(rowid: number, name: string, id: string, before: string | undefined): void {
    if (before !== name) this.pending.push([rowid * 4 + KIND_INDEX[this.kind], name, this.kind, id]);
  }

  /** Writes the queued rows once there are FTS_BATCH of them, or all of them with `all`. Returns whether it wrote. */
  flush(all = false): boolean {
    if (this.pending.length < (all ? 1 : FTS_BATCH)) return false;
    this.tx(this.pending);
    this.pending = [];
    return true;
  }
}

/**
 * Cuts a sync into short stretches: rows are parsed into a chunk until parsing so far plus
 * writing the chunk (estimated from the last transaction) would take SLICE_MS, or BATCH rows;
 * then the chunk is written in one transaction and the event loop gets a turn. (A for-await
 * over an already buffered stream only runs microtasks, so without the explicit yield requests
 * would wait for the whole list.)
 */
class Slicer {
  private since = performance.now();
  /** ms to write one row, as measured in the last transaction */
  private perRow = 0;

  due(rows: number): boolean {
    return rows >= BATCH || performance.now() - this.since + rows * this.perRow >= SLICE_MS;
  }

  /** Runs one transaction of `rows` rows and measures it. */
  write(rows: number, tx: () => void): void {
    const t = performance.now();
    tx();
    if (rows > 0) this.perRow = (performance.now() - t) / rows;
  }

  /** Lets requests run, then starts the next stretch. */
  async pause(): Promise<void> {
    await yieldLoop();
    this.since = performance.now();
  }
}

async function inBatches<T>(db: Db, rows: Iterable<T> | AsyncIterable<T>, write: (row: T) => void, fts?: FtsWriter): Promise<void> {
  const tx = db.transaction((chunk: T[]) => chunk.forEach(write));
  const slicer = new Slicer();
  let chunk: T[] = [];
  for await (const row of rows) {
    chunk.push(row);
    if (slicer.due(chunk.length)) {
      const c = chunk;
      slicer.write(c.length, () => tx(c));
      chunk = [];
      await slicer.pause();
      if (fts?.flush()) await slicer.pause();
    }
  }
  if (chunk.length) tx(chunk);
  fts?.flush(true);
}

export class CatalogSync {
  private running: Promise<void> | null = null;
  private epgRunning: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly episodeFetches = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly source: SourceService,
    private readonly bus: EventBus,
    private readonly log: FastifyBaseLogger,
  ) {}

  get syncing(): boolean {
    return this.running !== null || this.epgRunning !== null;
  }

  lastCatalog(): number | null {
    const v = kvGet(this.db, 'lastCatalogSync');
    return v ? Number(v) : null;
  }

  lastEpg(): number | null {
    const v = kvGet(this.db, 'lastEpgSync');
    return v ? Number(v) : null;
  }

  /** Background scheduler: catalog when older than 12 h, EPG when older than 1 h. */
  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (!this.source.credentials()) return;
      const now = Date.now();
      if (!this.running && now - (this.lastCatalog() ?? 0) > CATALOG_INTERVAL_MS) {
        this.syncAll().catch(() => undefined);
      } else if (!this.running && !this.epgRunning && now - (this.lastEpg() ?? 0) > EPG_INTERVAL_MS) {
        this.syncEpg().catch(() => undefined);
      }
    };
    tick();
    this.timer = setInterval(tick, 5 * 60_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.running, this.epgRunning]);
  }

  /** Catalog then EPG; concurrent callers share the running sync. */
  syncAll(): Promise<void> {
    this.running ??= (async () => {
      try {
        await this.syncCatalog();
        await this.syncEpg();
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private requireClient(): XtreamClient {
    const client = this.source.client();
    if (!client) throw new Error('No provider configured');
    return client;
  }

  async syncCatalog(): Promise<void> {
    const client = this.requireClient();
    const started = Date.now();
    try {
      // ms per phase, logged with the result (the perf benchmark reads them)
      const phases: Record<string, number> = {};
      let mark = started;
      const phase = (name: string) => {
        const now = Date.now();
        phases[name] = now - mark;
        mark = now;
      };
      this.source.saveAccount(await client.authenticate());
      const gen = started;
      const [liveCats, vodCats, seriesCats] = await Promise.all([client.liveCategories(), client.vodCategories(), client.seriesCategories()]);
      const catTags = new Map<string, Tag>();
      await this.writeCategories('live', liveCats, gen, catTags);
      await this.writeCategories('movie', vodCats, gen, catTags);
      await this.writeCategories('series', seriesCats, gen, catTags);
      phase('categories');
      // streamed: the movie list of a big panel is 100+ MB of JSON
      await this.writeLive(client.liveStreamsIter(), gen, catTags);
      phase('live');
      await this.writeMovies(client.vodStreamsIter(), gen, catTags);
      phase('movies');
      await this.writeSeries(client.seriesIter(), gen, catTags);
      phase('series');
      this.prune(gen);
      phase('prune');
      groupVariants(this.db);
      refreshHasEpg(this.db);
      phase('variants');
      kvSet(this.db, 'lastCatalogSync', String(Date.now()));
      this.log.info({ ms: Date.now() - started, phases }, 'catalog sync finished');
      this.bus.emit({ type: 'catalog-updated' });
      void this.refreshFollowed();
    } catch (err) {
      this.log.error({ err }, 'catalog sync failed');
      throw err;
    }
  }

  private async writeCategories(kind: MediaKind, cats: XCategory[], gen: number, tags: Map<string, Tag>) {
    const stmt = this.db.prepare(
      `INSERT INTO categories (id, kind, name, country, language, adult, sort, gen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, country = excluded.country,
         language = excluded.language, adult = excluded.adult, sort = excluded.sort, gen = excluded.gen`,
    );
    let sort = 0;
    await inBatches(this.db, cats, (c) => {
      const id = categoryId(kind, c.category_id);
      const tag = tagCategory(c.category_name);
      tags.set(id, tag);
      stmt.run(id, kind, cleanCategoryName(c.category_name), tag.country, tag.language, tag.adult ? 1 : 0, sort++, gen);
    });
  }

  private async writeLive(streams: AsyncIterable<XLiveStream>, gen: number, catTags: Map<string, Tag>) {
    const stmt = this.db.prepare(
      `INSERT INTO channels (id, name, raw_name, number, category_id, logo, country, language, archive_days, epg_channel_id, gen)
       VALUES (@id, @name, @raw, @number, @cat, @logo, @country, @language, @archive, @epg, @gen)
       ON CONFLICT(id) DO UPDATE SET name = @name, raw_name = @raw, number = @number, category_id = @cat, logo = @logo,
         country = @country, language = @language, archive_days = @archive, epg_channel_id = @epg, gen = @gen
       RETURNING rowid`,
    );
    const fts = new FtsWriter(this.db, 'live');
    let i = 0;
    await inBatches(this.db, streams, (s) => {
      i++;
      const cat = categoryId('live', s.category_id);
      const tag = tagItem(s.name, catTags.get(cat) ?? null);
      const archive = s.tv_archive ? Math.max(0, Math.round(s.tv_archive_duration ?? 0)) : 0;
      const before = fts.before(s.stream_id);
      const row = stmt.get({
        id: s.stream_id, name: tag.name, raw: s.name.trim(), number: s.num ?? i, cat, logo: s.stream_icon || null,
        country: tag.country, language: tag.language, archive, epg: s.epg_channel_id?.trim() || null, gen,
      }) as { rowid: number };
      fts.write(row.rowid, tag.name, s.stream_id, before);
    }, fts);
  }

  private async writeMovies(streams: AsyncIterable<XVodStream>, gen: number, catTags: Map<string, Tag>) {
    const stmt = this.db.prepare(
      `INSERT INTO movies (id, name, raw_name, category_id, poster, year, rating, plot, duration, container, country, language, added, gen)
       VALUES (@id, @name, @raw, @cat, @poster, @year, @rating, @plot, @duration, @container, @country, @language, @added, @gen)
       ON CONFLICT(id) DO UPDATE SET name = @name, raw_name = @raw, category_id = @cat, poster = @poster, year = @year,
         rating = @rating, plot = COALESCE(@plot, plot), duration = COALESCE(@duration, duration), container = @container,
         country = @country, language = @language, added = @added, gen = @gen
       RETURNING rowid`,
    );
    const fts = new FtsWriter(this.db, 'movie');
    await inBatches(this.db, streams, (s) => {
      const cat = categoryId('movie', s.category_id);
      const tag = tagItem(s.name, catTags.get(cat) ?? null);
      const split = splitTitle(tag.name);
      const before = fts.before(s.stream_id);
      const row = stmt.get({
        id: s.stream_id, name: split.name, raw: s.name.trim(), cat, poster: s.stream_icon || null,
        year: s.year ?? split.year, rating: rating(s.rating), plot: s.plot, duration: s.duration_secs,
        container: s.container_extension?.toLowerCase() ?? null, country: tag.country, language: tag.language,
        added: s.added ?? 0, gen,
      }) as { rowid: number };
      fts.write(row.rowid, split.name, s.stream_id, before);
    }, fts);
  }

  private async writeSeries(list: AsyncIterable<XSeries>, gen: number, catTags: Map<string, Tag>) {
    const stmt = this.db.prepare(
      `INSERT INTO series (id, name, raw_name, category_id, poster, year, rating, plot, country, language, added, gen)
       VALUES (@id, @name, @raw, @cat, @poster, @year, @rating, @plot, @country, @language, @added, @gen)
       ON CONFLICT(id) DO UPDATE SET name = @name, raw_name = @raw, category_id = @cat, poster = @poster, year = @year,
         rating = @rating, plot = @plot, country = @country, language = @language,
         episodes_synced_at = CASE WHEN added = @added THEN episodes_synced_at ELSE NULL END, added = @added, gen = @gen
       RETURNING rowid`,
    );
    const fts = new FtsWriter(this.db, 'series');
    await inBatches(this.db, list, (s) => {
      const cat = categoryId('series', s.category_id);
      const tag = tagItem(s.name, catTags.get(cat) ?? null);
      const split = splitTitle(tag.name);
      const release = s.releaseDate ?? s.release_date;
      const year = s.year ?? split.year ?? (release && /^\d{4}/.test(release) ? Number(release.slice(0, 4)) : null);
      const before = fts.before(s.series_id);
      const row = stmt.get({
        id: s.series_id, name: split.name, raw: s.name.trim(), cat, poster: s.cover || null, year,
        rating: rating(s.rating), plot: s.plot, country: tag.country, language: tag.language, added: s.last_modified ?? 0, gen,
      }) as { rowid: number };
      fts.write(row.rowid, split.name, s.series_id, before);
    }, fts);
  }

  private prune(gen: number) {
    this.db.transaction(() => {
      for (const [kind, table] of [['live', 'channels'], ['movie', 'movies'], ['series', 'series']] as const) {
        this.db
          .prepare(`DELETE FROM search_fts WHERE rowid IN (SELECT rowid * 4 + ? FROM ${table} WHERE gen < ?)`)
          .run(KIND_INDEX[kind], gen);
        this.db.prepare(`DELETE FROM ${table} WHERE gen < ?`).run(gen);
      }
      this.db.prepare('DELETE FROM categories WHERE gen < ?').run(gen);
      this.db.prepare('DELETE FROM episodes WHERE series_id NOT IN (SELECT id FROM series)').run();
    })();
  }

  /** Streams xmltv.php; keeps programs of known channels from 7 days back to 2 days ahead. */
  syncEpg(): Promise<void> {
    this.epgRunning ??= (async () => {
      const started = Date.now();
      try {
        const client = this.requireClient();
        const known = new Set(
          (this.db.prepare('SELECT DISTINCT epg_channel_id AS e FROM channels WHERE epg_channel_id IS NOT NULL').all() as { e: string }[]).map((r) => r.e),
        );
        const gen = started;
        const minStart = started - EPG_KEEP_BACK_MS;
        const maxStart = started + EPG_KEEP_AHEAD_MS;
        const stmt = this.db.prepare(
          `INSERT INTO epg (epg_id, start, end, title, description, gen) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(epg_id, start) DO UPDATE SET end = excluded.end, title = excluded.title, description = excluded.description, gen = excluded.gen`,
        );
        const flush = this.db.transaction((rows: [string, number, number, string, string | null][]) => {
          for (const r of rows) stmt.run(...r, gen);
        });
        let batch: [string, number, number, string, string | null][] = [];
        let count = 0;
        const slicer = new Slicer();
        for await (const p of parseXmltv(await client.xmltv(), this.source.timezone())) {
          if (known.has(p.channel) && p.stop >= minStart && p.start <= maxStart) batch.push([p.channel, p.start, p.stop, p.title, p.description]);
          if (slicer.due(batch.length)) {
            const b = batch;
            slicer.write(b.length, () => flush(b));
            count += b.length;
            batch = [];
            await slicer.pause();
          }
        }
        flush(batch);
        count += batch.length;
        const streamed = Date.now();
        await this.cleanEpg(gen, minStart);
        kvSet(this.db, 'lastEpgSync', String(Date.now()));
        const phases = { stream: streamed - started, cleanup: Date.now() - streamed };
        this.log.info({ ms: Date.now() - started, programs: count, phases }, 'epg sync finished');
      } catch (err) {
        this.log.error({ err }, 'epg sync failed');
        throw err;
      } finally {
        this.epgRunning = null;
      }
    })();
    return this.epgRunning;
  }

  /**
   * After an EPG sync, per guide channel: replaces the old schedule where the new guide covers it
   * (keeping older history) and drops programmes that ended before `minStart`. Done one channel
   * id at a time along the primary key, in short transactions, instead of two scans of the whole
   * guide in one long one.
   */
  private async cleanEpg(gen: number, minStart: number): Promise<void> {
    const nextId = this.db.prepare('SELECT min(epg_id) FROM epg WHERE epg_id > ?').pluck();
    const replaced = this.db.prepare(
      'DELETE FROM epg WHERE epg_id = ? AND gen < ? AND start >= (SELECT min(e2.start) FROM epg e2 WHERE e2.epg_id = ? AND e2.gen = ?)',
    );
    // end < minStart implies start < minStart, which keeps this a range of the primary key
    const ended = this.db.prepare('DELETE FROM epg WHERE epg_id = ? AND start < ? AND end < ?');
    const some = this.db.transaction((first: string): string | null => {
      let id: string | null = first;
      for (let n = 0; id !== null && n < 200; n++) {
        replaced.run(id, gen, id, gen);
        ended.run(id, minStart, minStart);
        id = nextId.get(id) as string | null;
      }
      return id;
    });
    let id = nextId.get('') as string | null;
    while (id !== null) {
      id = some(id);
      await yieldLoop();
    }
    refreshHasEpg(this.db);
  }

  /**
   * After a sync, fetches the episodes of followed series the provider changed (their
   * episodes_synced_at was reset), one at a time, so New episodes knows about them without the
   * series page being opened.
   */
  private async refreshFollowed(): Promise<void> {
    const ids = followedByAnyone(this.db);
    if (!ids.length) return;
    const stale = this.db
      .prepare(`SELECT id FROM series WHERE episodes_synced_at IS NULL AND id IN (${ids.map(() => '?').join(',')}) LIMIT ${FOLLOWED_REFRESH_MAX}`)
      .pluck()
      .all(...ids) as string[];
    let done = 0;
    for (const id of stale) {
      try {
        await this.ensureEpisodes(id);
        done++;
      } catch (err) {
        this.log.warn({ err, seriesId: id }, 'episode refresh failed');
      }
    }
    if (done) {
      this.log.info({ series: done }, 'followed series refreshed');
      this.bus.emit({ type: 'catalog-updated' });
    }
  }

  /** Lazily fetches a series' episodes (once per TTL, deduplicated). */
  async ensureEpisodes(seriesId: string): Promise<void> {
    const row = this.db.prepare('SELECT episodes_synced_at AS t FROM series WHERE id = ?').get(seriesId) as { t: number | null } | undefined;
    if (!row || (row.t && Date.now() - row.t < EPISODES_TTL_MS)) return;
    let p = this.episodeFetches.get(seriesId);
    if (!p) {
      p = this.fetchEpisodes(seriesId).finally(() => this.episodeFetches.delete(seriesId));
      this.episodeFetches.set(seriesId, p);
    }
    await p;
  }

  private async fetchEpisodes(seriesId: string): Promise<void> {
    const info = await this.requireClient().seriesInfo(seriesId);
    const seriesName = (this.db.prepare('SELECT name FROM series WHERE id = ?').pluck().get(seriesId) as string | undefined) ?? null;
    const insert = this.db.prepare(
      `INSERT INTO episodes (id, series_id, season, episode, title, plot, duration, container, image, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET series_id = excluded.series_id, season = excluded.season, episode = excluded.episode,
         title = excluded.title, plot = excluded.plot, duration = excluded.duration, container = excluded.container, image = excluded.image`,
    );
    // episodes that appear after the series' first fetch are new (followed.ts); the first fetch's are not
    const known = this.db.prepare('SELECT 1 FROM episodes WHERE series_id = ? LIMIT 1').get(seriesId) !== undefined;
    const firstSeen = known ? Date.now() : 0;
    this.db.transaction(() => {
      const ids = info.episodes.map((e) => e.id);
      this.db
        .prepare(`DELETE FROM episodes WHERE series_id = ? AND id NOT IN (${ids.map(() => '?').join(',') || "''"})`)
        .run(seriesId, ...ids);
      info.episodes.forEach((e, i) => {
        insert.run(
          e.id, seriesId, e.season, e.episode_num ?? i + 1,
          e.title?.trim() ? cleanEpisodeTitle(e.title, seriesName, e.episode_num ?? i + 1) : `Episode ${e.episode_num ?? i + 1}`,
          e.info.plot, e.info.duration_secs ?? parseDuration(e.info.duration), e.container_extension?.toLowerCase() ?? null,
          e.info.movie_image && /^https?:\/\//i.test(e.info.movie_image) ? e.info.movie_image : null, firstSeen,
        );
      });
      this.db.prepare('UPDATE series SET episodes_synced_at = ? WHERE id = ?').run(Date.now(), seriesId);
    })();
  }
}

/** "01:23:45" -> seconds */
function parseDuration(s: string | null): number | null {
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) || null;
}
