import type { Episode, Movie, Progress, Series } from '@anycast/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getEpisode, getMovie, getSeries, listEpisodes, toEpisode, toMovie, toSeries } from '../catalog/store';
import { auth, type Services } from '../context';
import { parentalCtx } from '../parental';
import { continueWatching } from '../progress';
import { buildRecap, clearWatchHistory, recordWatch } from '../recap';
import { WATCH_REPORT_MAX_SECONDS } from '@anycast/shared';

const FavoriteBody = z.object({ kind: z.enum(['live', 'movie', 'series']), id: z.string().min(1), favorite: z.boolean() });
const ProgressBody = z.object({
  kind: z.enum(['movie', 'episode']),
  id: z.string().min(1),
  position: z.number().finite().min(0),
  duration: z.number().finite().min(0),
  seriesId: z.string().optional(),
});
const WatchBody = z.object({
  kind: z.enum(['live', 'movie', 'episode']),
  id: z.string().min(1).max(200),
  seconds: z.number().finite().positive().max(WATCH_REPORT_MAX_SECONDS),
  seriesId: z.string().min(1).max(200).optional(),
});
const RecapQuery = z.object({
  from: z.coerce.number().int().min(0),
  to: z.coerce.number().int().positive(),
  tz: z.string().max(64).optional(),
});
const Codes = z.array(z.string().max(16)).max(500);
const HideRulesBody = z.object({ countries: Codes, languages: Codes, categoryIds: z.array(z.string().max(64)).max(5000) });

export function userDataRoutes(app: FastifyInstance, s: Services): void {
  const bad = (message: string) => ({ error: 'bad_request', message });

  app.get('/api/favorites', async (req) => s.userData.favorites(auth(req).profileId));
  app.put('/api/favorites', async (req, reply) => {
    const b = FavoriteBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send(bad('kind, id and favorite are required'));
    return s.userData.setFavorite(auth(req).profileId, b.data.kind, b.data.id, b.data.favorite);
  });

  app.get('/api/progress', async (req) => s.userData.allProgress(auth(req).profileId));
  app.put('/api/progress', async (req, reply) => {
    const b = ProgressBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send(bad('kind, id, position and duration are required'));
    const input = { ...b.data };
    if (input.kind === 'episode' && !input.seriesId) {
      const ep = getEpisode(s.db, input.id);
      if (ep) input.seriesId = ep.series_id;
    }
    return s.userData.saveProgress(auth(req).profileId, input);
  });

  app.get('/api/recent-channels', async (req) => s.userData.recentChannels(auth(req).profileId));
  app.put('/api/recent-channels', async (req, reply) => {
    const b = z.object({ channelId: z.string().min(1).max(64) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send(bad('channelId is required'));
    return s.userData.touchRecentChannel(auth(req).profileId, b.data.channelId);
  });
  app.delete('/api/recent-channels', async (req) => s.userData.forgetRecentChannels(auth(req).profileId, null));
  app.delete<{ Params: { id: string } }>('/api/recent-channels/:id', async (req) => s.userData.forgetRecentChannels(auth(req).profileId, req.params.id));

  app.post('/api/watch-time', async (req, reply) => {
    const b = WatchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send(bad('kind, id and seconds are required'));
    const { profileId } = auth(req);
    if (!s.userData.preferences(profileId).history.record) return { ok: false };
    recordWatch(s.db, profileId, b.data);
    return { ok: true };
  });
  app.get('/api/recap', async (req, reply) => {
    const q = RecapQuery.safeParse(req.query);
    if (!q.success || q.data.to <= q.data.from) return reply.code(400).send(bad('from and to (epoch ms, from < to) are required'));
    return buildRecap(s.db, auth(req).profileId, q.data, s.parental.view(parentalCtx(req)));
  });
  app.delete('/api/watch-history', async (req) => {
    clearWatchHistory(s.db, auth(req).profileId);
    return { ok: true as const };
  });

  app.get('/api/continue', async (req) => {
    const all = s.userData.allProgress(auth(req).profileId);
    // hidden adult titles are left out; locked ones are shown as placeholders
    const adult = s.parental.view(parentalCtx(req));
    const hidden = new Set(adult.hiddenIds);
    const result = continueWatching(all, (seriesId) => listEpisodes(s.db, seriesId).map(toEpisode));
    const movies: (Movie & { progress: Progress })[] = [];
    for (const p of result.movies) {
      const m = getMovie(s.db, p.id);
      if (m && !hidden.has(m.category_id)) movies.push({ ...adult.item(toMovie(m)), progress: p });
    }
    const episodes: (Episode & { progress: Progress; series: Series })[] = [];
    for (const e of result.episodes) {
      const series = getSeries(s.db, e.episode.seriesId);
      if (series && !hidden.has(series.category_id)) {
        episodes.push({ ...adult.episode(e.episode, series.category_id), progress: e.progress, series: adult.item(toSeries(series)) });
      }
    }
    return { movies, episodes };
  });

  app.get('/api/preferences', async (req) => s.userData.preferences(auth(req).profileId));
  app.put('/api/preferences', async (req, reply) => {
    if (!req.body || typeof req.body !== 'object') return reply.code(400).send(bad('A preferences object is required'));
    return s.userData.updatePreferences(auth(req).profileId, req.body);
  });

  app.get('/api/hide-rules', async (req) => s.userData.hideRules(auth(req).profileId));
  app.put('/api/hide-rules', async (req, reply) => {
    const b = HideRulesBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send(bad('countries, languages and categoryIds are required'));
    return s.userData.setHideRules(auth(req).profileId, b.data);
  });
}
