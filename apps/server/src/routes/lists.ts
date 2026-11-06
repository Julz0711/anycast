import type { LiveChannelWithNow } from '@anycast/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EMPTY_RULES, itemsByIds, nowNext, toChannel } from '../catalog/store';
import { auth, type Services } from '../context';
import { ChannelLists } from '../lists';

const Id = z.string().min(1).max(64);
const Ids = z.array(Id).max(10_000);
const Name = z.string().max(200);

/** Custom channel lists (LB-3); see ChannelLists. */
export function listRoutes(app: FastifyInstance, s: Services): void {
  const lists = new ChannelLists(s.db, s.bus);
  const bad = (message: string) => ({ error: 'bad_request', message });
  const pid = (req: Parameters<typeof auth>[0]) => auth(req).profileId;

  app.get('/api/lists', async (req) => lists.all(pid(req)));

  app.post('/api/lists', async (req, reply) => {
    const b = z.object({ name: Name, channelIds: Ids.optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send(bad('name is required; channelIds is a list of channel ids'));
    return lists.create(pid(req), b.data.name, b.data.channelIds);
  });

  // static path before the :id routes, for readability (find-my-way prefers static segments anyway)
  app.put('/api/lists/order', async (req, reply) => {
    const b = z.object({ ids: Ids }).safeParse(req.body);
    if (!b.success) return reply.code(400).send(bad('ids is the new order of list ids'));
    return lists.reorder(pid(req), b.data.ids);
  });

  app.patch<{ Params: { id: string } }>('/api/lists/:id', async (req, reply) => {
    const b = z.object({ name: Name }).safeParse(req.body);
    if (!b.success) return reply.code(400).send(bad('name is required'));
    return lists.rename(pid(req), req.params.id, b.data.name);
  });

  app.delete<{ Params: { id: string } }>('/api/lists/:id', async (req) => {
    lists.remove(pid(req), req.params.id);
    return { ok: true as const };
  });

  app.put<{ Params: { id: string } }>('/api/lists/:id/channels', async (req, reply) => {
    const b = z.object({ channelIds: Ids }).safeParse(req.body);
    if (!b.success) return reply.code(400).send(bad('channelIds is the whole ordered list of channel ids'));
    return lists.setChannels(pid(req), req.params.id, b.data.channelIds);
  });

  // Hide rules don't apply here on purpose: what the user put in a list stays visible in it.
  app.get<{ Params: { id: string } }>('/api/lists/:id/channels', async (req): Promise<LiveChannelWithNow[]> => {
    const list = lists.get(pid(req), req.params.id);
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < list.channelIds.length; i += 500) rows.push(...itemsByIds(s.db, 'live', list.channelIds.slice(i, i + 500), EMPTY_RULES));
    return rows.map((c) => ({ ...toChannel(c), ...nowNext(s.db, c, now) }));
  });
}
