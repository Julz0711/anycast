/**
 * Movie and series lists per profile: the built-in Watch Later list plus the user's own lists.
 * Every change emits a 'media-lists' SyncEvent with all of the profile's lists, so other devices
 * just replace theirs.
 *
 * Watch Later is a row like any other list, marked builtin = 'watch-later'. Until something is put
 * in it, it is only shown (id `wl-<profile id>`), so reading never writes; the row is made on the
 * first change. It always comes first and can't be renamed or deleted.
 */
import { MEDIA_LIST_LIMITS, type MediaList, type MediaListItem } from '@anycast/shared';
import { HttpError } from './auth/users';
import { newId } from './crypto';
import type { Db } from './db';
import type { EventBus } from './events';

interface ListRow { id: string; name: string; builtin: string | null }
type ItemRef = { kind: 'movie' | 'series'; id: string };

export const WATCH_LATER = 'watch-later' as const;
export const WATCH_LATER_NAME = 'Watch Later';

/** The id Watch Later has before its row exists. */
export const watchLaterId = (profileId: string) => `wl-${profileId}`;

const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, MEDIA_LIST_LIMITS.name);

/** Trimmed, non-empty, first occurrence wins, capped at the per-list limit. */
export function cleanItems(items: ItemRef[]): ItemRef[] {
  const out: ItemRef[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const id = raw.id.trim();
    const key = `${raw.kind}:${id}`;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: raw.kind, id });
  }
  if (out.length > MEDIA_LIST_LIMITS.items) {
    throw new HttpError(409, 'list_limit', `A list can hold up to ${MEDIA_LIST_LIMITS.items} movies and series.`);
  }
  return out;
}

export class MediaLists {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  /** Watch Later first, then the user's lists in their order. */
  all(profileId: string): MediaList[] {
    const lists = this.db
      .prepare('SELECT id, name, builtin FROM media_lists WHERE profile_id = ? ORDER BY builtin IS NULL, position, created_at')
      .all(profileId) as ListRow[];
    const items = this.db
      .prepare(
        `SELECT i.list_id, i.kind, i.item_id, i.added_at FROM media_list_items i JOIN media_lists l ON l.id = i.list_id
         WHERE l.profile_id = ? ORDER BY i.list_id, i.position`,
      )
      .all(profileId) as { list_id: string; kind: 'movie' | 'series'; item_id: string; added_at: number }[];
    const byList = new Map<string, MediaListItem[]>();
    for (const r of items) {
      const list = byList.get(r.list_id) ?? [];
      list.push({ kind: r.kind, id: r.item_id, addedAt: r.added_at });
      byList.set(r.list_id, list);
    }
    if (!lists.some((l) => l.builtin === WATCH_LATER)) lists.unshift({ id: watchLaterId(profileId), name: WATCH_LATER_NAME, builtin: WATCH_LATER });
    return lists.map((l) => ({
      id: l.id,
      name: l.builtin === WATCH_LATER ? WATCH_LATER_NAME : l.name,
      builtin: l.builtin === WATCH_LATER ? WATCH_LATER : null,
      items: byList.get(l.id) ?? [],
    }));
  }

  create(profileId: string, name: string, items: ItemRef[] = []): MediaList {
    const clean = cleanName(name);
    if (!clean) throw new HttpError(400, 'bad_request', 'A list needs a name');
    const refs = cleanItems(items);
    const id = newId();
    this.db.transaction(() => {
      const { n, max } = this.db
        .prepare('SELECT count(*) AS n, coalesce(max(position), -1) AS max FROM media_lists WHERE profile_id = ? AND builtin IS NULL')
        .get(profileId) as { n: number; max: number };
      if (n >= MEDIA_LIST_LIMITS.lists) throw new HttpError(409, 'list_limit', `You can have up to ${MEDIA_LIST_LIMITS.lists} lists.`);
      this.db
        .prepare('INSERT INTO media_lists (id, profile_id, name, builtin, position, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
        .run(id, profileId, clean, max + 1, Date.now());
      this.writeItems(id, refs, new Map());
    })();
    return this.changed(profileId, id);
  }

  rename(profileId: string, id: string, name: string): MediaList {
    const clean = cleanName(name);
    if (!clean) throw new HttpError(400, 'bad_request', 'A list needs a name');
    this.own(profileId, id, true);
    this.db.prepare('UPDATE media_lists SET name = ? WHERE id = ?').run(clean, id);
    return this.changed(profileId, id);
  }

  remove(profileId: string, id: string): void {
    this.own(profileId, id, true);
    this.db.prepare('DELETE FROM media_lists WHERE id = ?').run(id);
    this.emit(profileId);
  }

  /** The whole new item list; items that were already in it keep their addedAt. */
  setItems(profileId: string, id: string, items: ItemRef[]): MediaList {
    const refs = cleanItems(items);
    this.db.transaction(() => {
      this.own(profileId, id, false);
      const before = new Map(
        (this.db.prepare('SELECT kind, item_id, added_at FROM media_list_items WHERE list_id = ?').all(id) as { kind: string; item_id: string; added_at: number }[]).map(
          (r) => [`${r.kind}:${r.item_id}`, r.added_at],
        ),
      );
      this.db.prepare('DELETE FROM media_list_items WHERE list_id = ?').run(id);
      this.writeItems(id, refs, before);
    })();
    return this.changed(profileId, id);
  }

  /** The user's lists named first, in the given order; the rest keep their relative order after them. Watch Later stays first. */
  reorder(profileId: string, ids: string[]): MediaList[] {
    this.db.transaction(() => {
      const current = (
        this.db.prepare('SELECT id FROM media_lists WHERE profile_id = ? AND builtin IS NULL ORDER BY position, created_at').all(profileId) as { id: string }[]
      ).map((r) => r.id);
      const known = new Set(current);
      const named = [...new Set(ids)].filter((x) => known.has(x));
      const rest = current.filter((x) => !named.includes(x));
      const update = this.db.prepare('UPDATE media_lists SET position = ? WHERE id = ?');
      [...named, ...rest].forEach((x, i) => update.run(i, x));
    })();
    return this.emit(profileId);
  }

  private own(profileId: string, id: string, mustBeOwn: boolean) {
    if (id === watchLaterId(profileId)) {
      if (mustBeOwn) throw new HttpError(409, 'builtin', "Watch Later can't be renamed or deleted.");
      // first change to Watch Later: make its row (unless it came from a backup with another id)
      this.db
        .prepare(
          `INSERT INTO media_lists (id, profile_id, name, builtin, position, created_at)
           SELECT ?, ?, ?, ?, -1, ? WHERE NOT EXISTS (SELECT 1 FROM media_lists WHERE profile_id = ? AND builtin = ?)`,
        )
        .run(id, profileId, WATCH_LATER_NAME, WATCH_LATER, Date.now(), profileId, WATCH_LATER);
    }
    const row = this.db.prepare('SELECT builtin FROM media_lists WHERE id = ? AND profile_id = ?').get(id, profileId) as { builtin: string | null } | undefined;
    if (!row) throw new HttpError(404, 'not_found', 'List not found');
    if (mustBeOwn && row.builtin) throw new HttpError(409, 'builtin', "Watch Later can't be renamed or deleted.");
  }

  private writeItems(listId: string, refs: ItemRef[], addedBefore: Map<string, number>) {
    const insert = this.db.prepare('INSERT INTO media_list_items (list_id, kind, item_id, position, added_at) VALUES (?, ?, ?, ?, ?)');
    const now = Date.now();
    refs.forEach((r, i) => insert.run(listId, r.kind, r.id, i, addedBefore.get(`${r.kind}:${r.id}`) ?? now));
  }

  private changed(profileId: string, id: string): MediaList {
    return this.emit(profileId).find((l) => l.id === id)!;
  }

  private emit(profileId: string): MediaList[] {
    const lists = this.all(profileId);
    this.bus.emit({ type: 'media-lists', profileId, lists });
    return lists;
  }
}
