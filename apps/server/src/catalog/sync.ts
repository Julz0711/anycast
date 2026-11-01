/**
 * Catalog and EPG sync. Rows are upserted in small transactions with a generation number and
 * stale rows pruned at the end, so the app keeps serving the previous catalog while syncing and
 * the event loop is released between batches.
 */
import type { MediaKind } from '@anycast/shared';
import type { FastifyBaseLogger } from 'fastify';
import { kvGet, kvSet, type Db } from '../db';
import type { EventBus } from '../events';
import type { SourceService } from '../source';
import type { XtreamClient } from '../xtream/client';
import type { XCategory, XLiveStream, XSeries, XVodStream } from '../xtream/schemas';
import { parseXmltv } from '../xtream/xmltv';
import { KIND_INDEX, refreshHasEpg } from './store';
import { tagCategory, tagItem, type Tag } from './tagger';

const BATCH = 2000;
const CATALOG_INTERVAL_MS = 12 * 3600_000;
const EPG_INTERVAL_MS = 3600_000;
const EPISODES_TTL_MS = 12 * 3600_000;
const EPG_KEEP_BACK_MS = 7 * 86400_000;
const EPG_KEEP_AHEAD_MS = 2 * 86400_000;

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

const CATEGORY_PREFIX: Record<MediaKind, string> = { live: 'l', movie: 'm', series: 's' };
const categoryId = (kind: MediaKind, providerId: string | null) => `${CATEGORY_PREFIX[kind]}${providerId ?? '0'}`;

/** "Title (2019)", "Title - 2019", "Title [2019]" -> year and title without it */
function splitYear(name: string): { name: string; year: number | null } {
  const m = /\s*(?:\((\d{4})\)|\[(\d{4})\]|[-–]\s*(\d{4}))\s*$/.exec(name);
  const y = m ? Number(m[1] ?? m[2] ?? m[3]) : NaN;
  if (!m || y < 1900 || y > 2100) return { name, year: null };
  return { name: name.slice(0, m.index).trim() || name, year: y };
}

const rating = (r: number | null) => (r && r > 0 ? Math.round(r * 10) / 10 : null);

async function inBatches<T>(db: Db, rows: Iterable<T> | AsyncIterable<T>, write: (row: T) => void): Promise<void> {
  const tx = db.transaction((chunk: T[]) => chunk.forEach(write));
  let chunk: T[] = [];
  for await (const row of rows) {
    chunk.push(row);
    if (chunk.length >= BATCH) {
      tx(chunk);
      chunk = [];
      await yieldLoop();
    }
  }
  if (chunk.length) tx(chunk);
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
    const tick = () => {
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
      this.source.saveAccount(await client.authenticate());
      const gen = started;
      const [liveCats, vodCats, seriesCats] = await Promise.all([client.liveCategories(), client.vodCategories(), client.seriesCategories()]);
      const catTags = new Map<string, Tag>();
      await this.writeCategories('live', liveCats, gen, catTags);
      await this.writeCategories('movie', vodCats, gen, catTags);
      await this.writeCategories('series', seriesCats, gen, catTags);
      // streamed: the movie list of a big panel is 100+ MB of JSON
      await this.writeLive(client.liveStreamsIter(), gen, catTags);
      await this.writeMovies(client.vodStreamsIter(), gen, catTags);
      await this.writeSeries(client.seriesIter(), gen, catTags);
      this.prune(gen);
      refreshHasEpg(this.db);
      kvSet(this.db, 'lastCatalogSync', String(Date.now()));
      this.log.info({ ms: Date.now() - started }, 'catalog sync finished');
      this.bus.emit({ type: 'catalog-updated' });
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
      stmt.run(id, kind, c.category_name.trim(), tag.country, tag.language, tag.adult ? 1 : 0, sort++, gen);
    });
  }

  private ftsWriter(kind: MediaKind) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO search_fts (rowid, name, kind, item_id) VALUES (?, ?, ?, ?)');
    return (rowid: number, name: string, id: string) => stmt.run(rowid * 4 + KIND_INDEX[kind], name, kind, id);
  }

  private async writeLive(streams: AsyncIterable<XLiveStream>, gen: number, catTags: Map<string, Tag>) {
    const stmt = this.db.prepare(
      `INSERT INTO channels (id, name, raw_name, number, category_id, logo, country, language, archive_days, epg_channel_id, gen)
       VALUES (@id, @name, @raw, @number, @cat, @logo, @country, @language, @archive, @epg, @gen)
       ON CONFLICT(id) DO UPDATE SET name = @name, raw_name = @raw, number = @number, category_id = @cat, logo = @logo,
         country = @country, language = @language, archive_days = @archive, epg_channel_id = @epg, gen = @gen
       RETURNING rowid`,
    );
    const fts = this.ftsWriter('live');
    let i = 0;
    await inBatches(this.db, streams, (s) => {
      i++;
      const cat = categoryId('live', s.category_id);
      const tag = tagItem(s.name, catTags.get(cat) ?? null);
      const archive = s.tv_archive ? Math.max(0, Math.round(s.tv_archive_duration ?? 0)) : 0;
      const row = stmt.get({
        id: s.stream_id, name: tag.name, raw: s.name.trim(), number: s.num ?? i, cat, logo: s.stream_icon || null,
        country: tag.country, language: tag.language, archive, epg: s.epg_channel_id?.trim() || null, gen,
      }) as { rowid: number };
      fts(row.rowid, tag.name, s.stream_id);
    });
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
    const fts = this.ftsWriter('movie');
    await inBatches(this.db, streams, (s) => {
      const cat = categoryId('movie', s.category_id);
      const tag = tagItem(s.name, catTags.get(cat) ?? null);
      const split = splitYear(tag.name);
      const row = stmt.get({
        id: s.stream_id, name: split.name, raw: s.name.trim(), cat, poster: s.stream_icon || null,
        year: s.year ?? split.year, rating: rating(s.rating), plot: s.plot, duration: s.duration_secs,
        container: s.container_extension?.toLowerCase() ?? null, country: tag.country, language: tag.language,
        added: s.added ?? 0, gen,
      }) as { rowid: number };
      fts(row.rowid, split.name, s.stream_id);
    });
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
    const fts = this.ftsWriter('series');
    await inBatches(this.db, list, (s) => {
      const cat = categoryId('series', s.category_id);
      const tag = tagItem(s.name, catTags.get(cat) ?? null);
      const split = splitYear(tag.name);
      const release = s.releaseDate ?? s.release_date;
      const year = s.year ?? split.year ?? (release && /^\d{4}/.test(release) ? Number(release.slice(0, 4)) : null);
      const row = stmt.get({
        id: s.series_id, name: split.name, raw: s.name.trim(), cat, poster: s.cover || null, year,
        rating: rating(s.rating), plot: s.plot, country: tag.country, language: tag.language, added: s.last_modified ?? 0, gen,
      }) as { rowid: number };
      fts(row.rowid, split.name, s.series_id);
    });
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
        for await (const p of parseXmltv(await client.xmltv())) {
          if (!known.has(p.channel) || p.stop < minStart || p.start > maxStart) continue;
          batch.push([p.channel, p.start, p.stop, p.title, p.description]);
          if (batch.length >= BATCH) {
            flush(batch);
            count += batch.length;
            batch = [];
            await yieldLoop();
          }
        }
        flush(batch);
        count += batch.length;
        this.db.transaction(() => {
          // replace the old schedule where the new guide covers it; keep older history
          this.db
            .prepare(
              `DELETE FROM epg WHERE gen < ? AND start >= (SELECT min(e2.start) FROM epg e2 WHERE e2.epg_id = epg.epg_id AND e2.gen = ?)`,
            )
            .run(gen, gen);
          this.db.prepare('DELETE FROM epg WHERE end < ?').run(minStart);
          refreshHasEpg(this.db);
        })();
        kvSet(this.db, 'lastEpgSync', String(Date.now()));
        this.log.info({ ms: Date.now() - started, programs: count }, 'epg sync finished');
      } catch (err) {
        this.log.error({ err }, 'epg sync failed');
        throw err;
      } finally {
        this.epgRunning = null;
      }
    })();
    return this.epgRunning;
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
    const insert = this.db.prepare(
      `INSERT INTO episodes (id, series_id, season, episode, title, plot, duration, container) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET series_id = excluded.series_id, season = excluded.season, episode = excluded.episode,
         title = excluded.title, plot = excluded.plot, duration = excluded.duration, container = excluded.container`,
    );
    this.db.transaction(() => {
      const ids = info.episodes.map((e) => e.id);
      this.db
        .prepare(`DELETE FROM episodes WHERE series_id = ? AND id NOT IN (${ids.map(() => '?').join(',') || "''"})`)
        .run(seriesId, ...ids);
      info.episodes.forEach((e, i) => {
        insert.run(
          e.id, seriesId, e.season, e.episode_num ?? i + 1, e.title?.trim() || `Episode ${e.episode_num ?? i + 1}`,
          e.info.plot, e.info.duration_secs ?? parseDuration(e.info.duration), e.container_extension?.toLowerCase() ?? null,
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
