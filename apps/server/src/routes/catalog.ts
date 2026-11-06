import type { ItemsById, LiveChannelWithNow, MediaKind, SeriesDetail, SourceStatus, TagSummary } from '@anycast/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  countsByKind, EMPTY_RULES, epgFor, getSeries, itemsByIds, listCategories, listEpisodes, nowNext, pageChannels, pageMovies, pageSeries,
  toChannel, toEpisode, toMovie, toSeries, visibleChannels,
} from '../catalog/store';
import { auth, type Services } from '../context';
import { parentalCtx } from '../parental';
import { search } from '../search';

const PageQuery = z.object({
  categoryId: z.string().optional(),
  offset: z.coerce.number().int().min(0).catch(0),
  limit: z.coerce.number().int().min(1).max(500).catch(100),
  hasEpg: z.string().optional().transform((v) => v === '1' || v === 'true'),
});
const MAX_IDS = 500;
const IdList = z
  .string()
  .max(64 * MAX_IDS)
  .optional()
  .transform((v) => [...new Set((v ?? '').split(',').map((x) => x.trim()).filter(Boolean))].slice(0, MAX_IDS));
const ItemsQuery = z.object({ live: IdList, movie: IdList, series: IdList });
const Kind = z.enum(['live', 'movie', 'series']);
const MAX_EPG_SPAN_MS = 3 * 86400_000;

export function catalogRoutes(app: FastifyInstance, s: Services): void {
  /** The profile's hide rules plus its parental lock (hidden adult categories, masking of locked ones). */
  const scope = (req: Parameters<typeof auth>[0], opts: { search?: boolean } = {}) => {
    const adult = s.parental.view(parentalCtx(req));
    return { adult, rules: adult.rules(s.userData.hideRules(auth(req).profileId), opts) };
  };

  app.get('/api/source', async (): Promise<SourceStatus> => ({
    configured: s.source.credentials() !== null,
    account: s.source.accountStatus(),
    lastSync: { catalog: s.sync.lastCatalog(), epg: s.sync.lastEpg() },
    syncing: s.sync.syncing,
    counts: countsByKind(s.db),
  }));

  app.post('/api/source/sync', async (_req, reply) => {
    if (!s.source.credentials()) return reply.code(409).send({ error: 'not_configured', message: 'No provider is configured' });
    s.sync.syncAll().catch(() => undefined);
    return { ok: true };
  });

  /** `all=1` includes categories hidden by the profile's rules (for the settings screen). */
  app.get('/api/categories', async (req, reply) => {
    const q = z.object({ kind: Kind, all: z.string().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request', message: 'kind must be live, movie or series' });
    const { adult, rules } = scope(req);
    return listCategories(s.db, q.data.kind as MediaKind, q.data.all === '1' ? adult.rules(EMPTY_RULES) : rules).map((c) => adult.category(c));
  });

  // grouping ~200k rows takes ~80 ms on a big panel; the answer only changes with a catalog sync
  let tagsCache: { at: number | null; value: { countries: TagSummary[]; languages: TagSummary[] } } | null = null;
  app.get('/api/tags', async () => {
    const at = s.sync.lastCatalog();
    if (tagsCache && tagsCache.at === at && at !== null) return tagsCache.value;
    const rows = s.db
      .prepare(
        `SELECT country, language, count(*) AS n FROM (
           SELECT country, language FROM channels UNION ALL SELECT country, language FROM movies UNION ALL SELECT country, language FROM series
         ) GROUP BY country, language`,
      )
      .all() as { country: string | null; language: string | null; n: number }[];
    const countries = new Map<string, { count: number; langs: Map<string | null, number> }>();
    const languages = new Map<string, number>();
    for (const r of rows) {
      if (r.country) {
        const c = countries.get(r.country) ?? { count: 0, langs: new Map() };
        c.count += r.n;
        c.langs.set(r.language, (c.langs.get(r.language) ?? 0) + r.n);
        countries.set(r.country, c);
      }
      if (r.language) languages.set(r.language, (languages.get(r.language) ?? 0) + r.n);
    }
    const top = (m: Map<string | null, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const out: { countries: TagSummary[]; languages: TagSummary[] } = {
      countries: [...countries.entries()].map(([country, c]) => ({ country, language: top(c.langs), count: c.count })),
      languages: [...languages.entries()].map(([language, count]) => ({ country: null, language, count })),
    };
    out.countries.sort((a, b) => b.count - a.count);
    out.languages.sort((a, b) => b.count - a.count);
    tagsCache = { at, value: out };
    return out;
  });

  app.get('/api/live', async (req) => {
    const q = PageQuery.parse(req.query);
    const { adult, rules } = scope(req);
    const page = pageChannels(s.db, rules, q);
    const now = Date.now();
    const items: LiveChannelWithNow[] = page.items.map((c) => adult.item({ ...c, ...nowNext(s.db, { id: c.id, epg_channel_id: c.epgChannelId }, now) }));
    return { items, total: page.total };
  });

  app.get('/api/items', async (req, reply): Promise<ItemsById | undefined> => {
    const q = ItemsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request', message: 'live, movie and series are comma-separated id lists' });
    const { adult, rules: r } = scope(req);
    const now = Date.now();
    return {
      live: itemsByIds(s.db, 'live', q.data.live, r).map((c) => adult.item({ ...toChannel(c), ...nowNext(s.db, c, now) })),
      movies: itemsByIds(s.db, 'movie', q.data.movie, r).map((m) => adult.item(toMovie(m))),
      series: itemsByIds(s.db, 'series', q.data.series, r).map((x) => adult.item(toSeries(x))),
    };
  });

  app.get('/api/epg', async (req, reply) => {
    const q = z
      .object({ channelIds: z.string(), from: z.coerce.number(), to: z.coerce.number() })
      .safeParse(req.query);
    if (!q.success || q.data.to <= q.data.from) return reply.code(400).send({ error: 'bad_request', message: 'channelIds, from and to are required' });
    const ids = q.data.channelIds.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 500);
    const to = Math.min(q.data.to, q.data.from + MAX_EPG_SPAN_MS);
    const { adult, rules } = scope(req);
    const channels = visibleChannels(s.db, ids, rules);
    const out = epgFor(s.db, channels, q.data.from, to);
    for (const c of channels) out[c.id] = adult.programs(out[c.id] ?? [], c.category_id);
    return out;
  });

  app.get('/api/movies', async (req) => {
    const { adult, rules } = scope(req);
    const page = pageMovies(s.db, rules, PageQuery.parse(req.query));
    return { ...page, items: page.items.map((m) => adult.item(m)) };
  });
  app.get('/api/series', async (req) => {
    const { adult, rules } = scope(req);
    const page = pageSeries(s.db, rules, PageQuery.parse(req.query));
    return { ...page, items: page.items.map((x) => adult.item(x)) };
  });

  app.get<{ Params: { id: string } }>('/api/series/:id', async (req, reply): Promise<SeriesDetail | undefined> => {
    const row = getSeries(s.db, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'Series not found' });
    const { adult } = scope(req);
    adult.assertOpen(row.category_id);
    try {
      await s.sync.ensureEpisodes(row.id);
    } catch (err) {
      req.log.warn({ err }, 'episode fetch failed');
      if (!listEpisodes(s.db, row.id).length) {
        return reply.code(502).send({ error: 'upstream', message: 'The provider did not return the episodes' });
      }
    }
    const seasons = new Map<number, ReturnType<typeof toEpisode>[]>();
    for (const e of listEpisodes(s.db, row.id).map(toEpisode)) {
      const list = seasons.get(e.season) ?? [];
      list.push(e);
      seasons.set(e.season, list);
    }
    return { ...adult.item(toSeries(row)), seasons: [...seasons.entries()].map(([season, episodes]) => ({ season, episodes })) };
  });

  app.get('/api/search', async (req) => {
    const q = z.object({ q: z.string().max(200).catch('') }).parse(req.query);
    const { adult, rules } = scope(req, { search: true });
    const res = search(s.db, q.q, rules);
    return { live: res.live.map((x) => adult.item(x)), movies: res.movies.map((x) => adult.item(x)), series: res.series.map((x) => adult.item(x)) };
  });
}
