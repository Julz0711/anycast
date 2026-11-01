import type { LiveChannelWithNow, MediaKind, SeriesDetail, SourceStatus, TagSummary } from '@anycast/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  countsByKind, EMPTY_RULES, epgFor, getSeries, listCategories, listEpisodes, nowNext, pageChannels, pageMovies, pageSeries,
  toEpisode, toSeries, visibleChannels,
} from '../catalog/store';
import { auth, type Services } from '../context';
import { search } from '../search';

const PageQuery = z.object({
  categoryId: z.string().optional(),
  offset: z.coerce.number().int().min(0).catch(0),
  limit: z.coerce.number().int().min(1).max(500).catch(100),
});
const Kind = z.enum(['live', 'movie', 'series']);
const MAX_EPG_SPAN_MS = 3 * 86400_000;

export function catalogRoutes(app: FastifyInstance, s: Services): void {
  const rules = (req: Parameters<typeof auth>[0]) => s.userData.hideRules(auth(req).profileId);

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
    return listCategories(s.db, q.data.kind as MediaKind, q.data.all === '1' ? EMPTY_RULES : rules(req));
  });

  app.get('/api/tags', async () => {
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
    return out;
  });

  app.get('/api/live', async (req) => {
    const q = PageQuery.parse(req.query);
    const page = pageChannels(s.db, rules(req), q);
    const now = Date.now();
    const items: LiveChannelWithNow[] = page.items.map((c) => ({ ...c, ...nowNext(s.db, { id: c.id, epg_channel_id: c.epgChannelId }, now) }));
    return { items, total: page.total };
  });

  app.get('/api/epg', async (req, reply) => {
    const q = z
      .object({ channelIds: z.string(), from: z.coerce.number(), to: z.coerce.number() })
      .safeParse(req.query);
    if (!q.success || q.data.to <= q.data.from) return reply.code(400).send({ error: 'bad_request', message: 'channelIds, from and to are required' });
    const ids = q.data.channelIds.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 500);
    const to = Math.min(q.data.to, q.data.from + MAX_EPG_SPAN_MS);
    return epgFor(s.db, visibleChannels(s.db, ids, rules(req)), q.data.from, to);
  });

  app.get('/api/movies', async (req) => pageMovies(s.db, rules(req), PageQuery.parse(req.query)));
  app.get('/api/series', async (req) => pageSeries(s.db, rules(req), PageQuery.parse(req.query)));

  app.get<{ Params: { id: string } }>('/api/series/:id', async (req, reply): Promise<SeriesDetail | undefined> => {
    const row = getSeries(s.db, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'Series not found' });
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
    return { ...toSeries(row), seasons: [...seasons.entries()].map(([season, episodes]) => ({ season, episodes })) };
  });

  app.get('/api/search', async (req) => {
    const q = z.object({ q: z.string().max(200).catch('') }).parse(req.query);
    return search(s.db, q.q, rules(req));
  });
}
