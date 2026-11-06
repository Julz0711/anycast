/**
 * Custom ordered channel lists per profile (LB-3). Every change emits a 'lists' SyncEvent with all
 * of the profile's lists, so other devices just replace theirs.
 *
 * Lists deliberately ignore hide rules: a channel the user explicitly put in a list stays in it and
 * is shown there even when its country, language or group is hidden. Hide rules declutter the big
 * provider catalog; a list is the user's own hand-picked selection.
 */
import { CHANNEL_LIST_LIMITS, type ChannelList } from '@anycast/shared';
import { HttpError } from './auth/users';
import { newId } from './crypto';
import type { Db } from './db';
import type { EventBus } from './events';

interface ListRow { id: string; name: string }

export const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, CHANNEL_LIST_LIMITS.name);

/** Trimmed, non-empty, first occurrence wins, capped at the per-list limit. */
export function cleanIds(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > CHANNEL_LIST_LIMITS.channels) {
    throw new HttpError(409, 'list_limit', `A list can hold up to ${CHANNEL_LIST_LIMITS.channels} channels.`);
  }
  return out;
}

/** Channel ids in any of the profile's lists (they stay visible there despite hide rules). */
export function listedChannelIds(db: Db, profileId: string): Set<string> {
  const rows = db
    .prepare('SELECT DISTINCT i.channel_id AS id FROM channel_list_items i JOIN channel_lists l ON l.id = i.list_id WHERE l.profile_id = ?')
    .all(profileId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export class ChannelLists {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  all(profileId: string): ChannelList[] {
    const lists = this.db.prepare('SELECT id, name FROM channel_lists WHERE profile_id = ? ORDER BY position, created_at').all(profileId) as ListRow[];
    if (!lists.length) return [];
    const items = this.db
      .prepare(
        `SELECT i.list_id, i.channel_id FROM channel_list_items i JOIN channel_lists l ON l.id = i.list_id
         WHERE l.profile_id = ? ORDER BY i.list_id, i.position`,
      )
      .all(profileId) as { list_id: string; channel_id: string }[];
    const byList = new Map<string, string[]>();
    for (const r of items) {
      const ids = byList.get(r.list_id) ?? [];
      ids.push(r.channel_id);
      byList.set(r.list_id, ids);
    }
    return lists.map((l) => ({ id: l.id, name: l.name, channelIds: byList.get(l.id) ?? [] }));
  }

  get(profileId: string, id: string): ChannelList {
    const list = this.all(profileId).find((l) => l.id === id);
    if (!list) throw new HttpError(404, 'not_found', 'List not found');
    return list;
  }

  create(profileId: string, name: string, channelIds: string[] = []): ChannelList {
    const clean = cleanName(name);
    if (!clean) throw new HttpError(400, 'bad_request', 'A list needs a name');
    const ids = cleanIds(channelIds);
    const id = newId();
    this.db.transaction(() => {
      const { n, max } = this.db
        .prepare('SELECT count(*) AS n, coalesce(max(position), -1) AS max FROM channel_lists WHERE profile_id = ?')
        .get(profileId) as { n: number; max: number };
      if (n >= CHANNEL_LIST_LIMITS.lists) throw new HttpError(409, 'list_limit', `You can have up to ${CHANNEL_LIST_LIMITS.lists} lists.`);
      this.db
        .prepare('INSERT INTO channel_lists (id, profile_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, profileId, clean, max + 1, Date.now());
      this.writeItems(id, ids);
    })();
    return this.changed(profileId, id);
  }

  rename(profileId: string, id: string, name: string): ChannelList {
    const clean = cleanName(name);
    if (!clean) throw new HttpError(400, 'bad_request', 'A list needs a name');
    const r = this.db.prepare('UPDATE channel_lists SET name = ? WHERE id = ? AND profile_id = ?').run(clean, id, profileId);
    if (!r.changes) throw new HttpError(404, 'not_found', 'List not found');
    return this.changed(profileId, id);
  }

  remove(profileId: string, id: string): void {
    const r = this.db.prepare('DELETE FROM channel_lists WHERE id = ? AND profile_id = ?').run(id, profileId);
    if (!r.changes) throw new HttpError(404, 'not_found', 'List not found');
    this.emit(profileId);
  }

  setChannels(profileId: string, id: string, channelIds: string[]): ChannelList {
    const ids = cleanIds(channelIds);
    this.db.transaction(() => {
      this.own(profileId, id);
      this.db.prepare('DELETE FROM channel_list_items WHERE list_id = ?').run(id);
      this.writeItems(id, ids);
    })();
    return this.changed(profileId, id);
  }

  /** Named lists first, in the given order; the rest keep their relative order after them. */
  reorder(profileId: string, ids: string[]): ChannelList[] {
    this.db.transaction(() => {
      const current = (this.db.prepare('SELECT id FROM channel_lists WHERE profile_id = ? ORDER BY position, created_at').all(profileId) as { id: string }[]).map((r) => r.id);
      const known = new Set(current);
      const named = [...new Set(ids)].filter((x) => known.has(x));
      const rest = current.filter((x) => !named.includes(x));
      const update = this.db.prepare('UPDATE channel_lists SET position = ? WHERE id = ?');
      [...named, ...rest].forEach((x, i) => update.run(i, x));
    })();
    return this.emit(profileId);
  }

  private own(profileId: string, id: string) {
    if (!this.db.prepare('SELECT 1 FROM channel_lists WHERE id = ? AND profile_id = ?').get(id, profileId)) {
      throw new HttpError(404, 'not_found', 'List not found');
    }
  }

  private writeItems(listId: string, ids: string[]) {
    const insert = this.db.prepare('INSERT INTO channel_list_items (list_id, channel_id, position) VALUES (?, ?, ?)');
    ids.forEach((c, i) => insert.run(listId, c, i));
  }

  private changed(profileId: string, id: string): ChannelList {
    const lists = this.emit(profileId);
    return lists.find((l) => l.id === id)!;
  }

  private emit(profileId: string): ChannelList[] {
    const lists = this.all(profileId);
    this.bus.emit({ type: 'lists', profileId, lists });
    return lists;
  }
}
