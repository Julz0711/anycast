import { SWIPE_LIMITS, type SwipeDeck } from '@anycast/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth, type Services } from '../context';
import { parentalCtx } from '../parental';
import { SwipeDecks } from '../swipe';

const Kind = z.enum(['movie', 'series']);
const DeckQuery = z.object({
  kind: z.enum(['all', 'movie', 'series']).catch('all'),
  categoryId: z.string().max(64).optional(),
  minRating: z.coerce.number().min(0).max(10).optional().catch(undefined),
  limit: z.coerce.number().int().min(1).max(SWIPE_LIMITS.deck).catch(20),
  skip: z
    .string()
    .max(80 * SWIPE_LIMITS.skip)
    .optional()
    .transform((v) => new Set((v ?? '').split(',').map((x) => x.trim()).filter((x) => /^(movie|series):./.test(x)).slice(0, SWIPE_LIMITS.skip))),
});

/** Swipe (see SwipeDecks): random cards, and the titles a profile passed on. */
export function swipeRoutes(app: FastifyInstance, s: Services): void {
  const decks = new SwipeDecks(s.db, () => `${s.sync.syncing ? 'syncing' : 'idle'}|${s.sync.lastCatalog()}`);
  const pid = (req: Parameters<typeof auth>[0]) => auth(req).profileId;

  app.get('/api/swipe', async (req): Promise<SwipeDeck> => {
    const q = DeckQuery.parse(req.query);
    const profileId = pid(req);
    // locked adult categories count as hidden: a masked card can't be judged
    const rules = s.parental.view(parentalCtx(req)).rules(s.userData.hideRules(profileId), { search: true });
    const kinds = q.kind === 'all' ? (['movie', 'series'] as const) : ([q.kind] as const);
    return decks.deal(profileId, rules, { kinds: [...kinds], categoryId: q.kind === 'all' ? undefined : q.categoryId, minRating: q.minRating || undefined }, q.limit, q.skip);
  });

  app.get('/api/swipe/passed', async (req) => ({ passed: decks.passed(pid(req)) }));

  app.post('/api/swipe/passed', async (req, reply) => {
    const b = z.object({ kind: Kind, id: z.string().min(1).max(64) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'kind (movie or series) and id are required' });
    return { passed: decks.pass(pid(req), b.data.kind, b.data.id) };
  });

  app.delete<{ Params: { kind: string; id: string } }>('/api/swipe/passed/:kind/:id', async (req, reply) => {
    const kind = Kind.safeParse(req.params.kind);
    if (!kind.success) return reply.code(400).send({ error: 'bad_request', message: 'kind must be movie or series' });
    return { passed: decks.unpass(pid(req), kind.data, req.params.id) };
  });

  app.delete('/api/swipe/passed', async (req) => ({ passed: decks.clear(pid(req)) }));
}
