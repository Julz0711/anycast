/**
 * Export and restore of the user data (see tables.ts for what is and isn't in a backup).
 * A restore runs in one transaction: it either applies completely or not at all.
 */
import {
  BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, mergePreferences, type AdultMode, type BackupFile, type BackupProfile, type BackupUser,
  type MediaKind, type RestoreMode,
} from '@anycast/shared';
import { VERSION } from '../config';
import { newId } from '../crypto';
import type { Db } from '../db';
import type { EventBus } from '../events';
import { ChannelLists } from '../lists';
import { MediaLists } from '../media-lists';
import type { UserData } from '../userdata';

interface UserRow { id: string; username: string; password_hash: string; is_admin: number; created_at: number }
interface ProfileRow { id: string; user_id: string; name: string; created_at: number; avatar: string | null; lock_hash: string | null }

/** Everything restorable, read in one consistent snapshot. */
export function exportBackup(db: Db, now = Date.now()): BackupFile {
  return db.transaction((): BackupFile => {
    const byProfile = <T>(sql: string): Map<string, T[]> => {
      const out = new Map<string, T[]>();
      for (const r of db.prepare(sql).all() as (T & { profile_id: string })[]) {
        const { profile_id, ...rest } = r;
        const list = out.get(profile_id) ?? [];
        list.push(rest as T);
        out.set(profile_id, list);
      }
      return out;
    };
    const one = <T>(sql: string): Map<string, T> => {
      const out = new Map<string, T>();
      for (const r of db.prepare(sql).all() as (T & { profile_id: string })[]) {
        const { profile_id, ...rest } = r;
        out.set(profile_id, rest as T);
      }
      return out;
    };

    const prefs = one<{ data: string }>('SELECT profile_id, data FROM preferences');
    const rules = one<{ data: string }>('SELECT profile_id, data FROM hide_rules');
    const parental = one<{ mode: AdultMode; unlockMinutes: number; pinHash: string | null; updatedAt: number }>(
      'SELECT profile_id, mode, unlock_minutes AS unlockMinutes, pin_hash AS pinHash, updated_at AS updatedAt FROM parental',
    );
    const favorites = byProfile<{ kind: MediaKind; id: string; addedAt: number }>(
      'SELECT profile_id, kind, item_id AS id, added_at AS addedAt FROM favorites ORDER BY added_at, kind, item_id',
    );
    const progress = byProfile<{ kind: 'movie' | 'episode'; id: string; seriesId: string | null; position: number; duration: number; finished: number; updatedAt: number }>(
      `SELECT profile_id, kind, item_id AS id, series_id AS seriesId, position, duration, finished, updated_at AS updatedAt
       FROM progress ORDER BY updated_at, kind, item_id`,
    );
    const tracks = byProfile<BackupProfile['trackChoices'][number]>(
      'SELECT profile_id, kind, item_id AS id, audio, subtitle, updated_at AS updatedAt FROM track_choices ORDER BY kind, item_id',
    );
    const watch = byProfile<NonNullable<BackupProfile['watchHistory']>[number]>(
      'SELECT profile_id, hour, kind, item_id AS id, series_id AS seriesId, seconds FROM watch_history ORDER BY hour, kind, item_id',
    );
    const lists = byProfile<{ id: string; name: string; position: number; createdAt: number }>(
      'SELECT profile_id, id, name, position, created_at AS createdAt FROM channel_lists ORDER BY position, created_at',
    );
    const items = new Map<string, string[]>();
    for (const r of db.prepare('SELECT list_id, channel_id FROM channel_list_items ORDER BY list_id, position').all() as { list_id: string; channel_id: string }[]) {
      const ids = items.get(r.list_id) ?? [];
      ids.push(r.channel_id);
      items.set(r.list_id, ids);
    }
    const mediaLists = byProfile<{ id: string; name: string; builtin: 'watch-later' | null; position: number; createdAt: number }>(
      'SELECT profile_id, id, name, builtin, position, created_at AS createdAt FROM media_lists ORDER BY builtin IS NULL, position, created_at',
    );
    const mediaItems = new Map<string, BackupProfile['mediaLists'][number]['items']>();
    for (const r of db.prepare('SELECT list_id, kind, item_id, added_at FROM media_list_items ORDER BY list_id, position').all() as {
      list_id: string;
      kind: 'movie' | 'series';
      item_id: string;
      added_at: number;
    }[]) {
      const list = mediaItems.get(r.list_id) ?? [];
      list.push({ kind: r.kind, id: r.item_id, addedAt: r.added_at });
      mediaItems.set(r.list_id, list);
    }

    const images = one<{ type: string; data: Buffer; updatedAt: number }>('SELECT profile_id, mime AS type, data, updated_at AS updatedAt FROM profile_images');
    const profilesOf = new Map<string, ProfileRow[]>();
    for (const p of db.prepare('SELECT id, user_id, name, created_at, avatar, lock_hash FROM profiles ORDER BY created_at, rowid').all() as ProfileRow[]) {
      const list = profilesOf.get(p.user_id) ?? [];
      list.push(p);
      profilesOf.set(p.user_id, list);
    }

    const users = (db.prepare('SELECT id, username, password_hash, is_admin, created_at FROM users ORDER BY created_at, rowid').all() as UserRow[]).map(
      (u): BackupUser => ({
        id: u.id,
        username: u.username,
        passwordHash: u.password_hash,
        isAdmin: u.is_admin === 1,
        createdAt: u.created_at,
        profiles: (profilesOf.get(u.id) ?? []).map(
          (p): BackupProfile => ({
            id: p.id,
            name: p.name,
            createdAt: p.created_at,
            preferences: prefs.has(p.id) ? (JSON.parse(prefs.get(p.id)!.data) as Record<string, unknown>) : null,
            hideRules: rules.has(p.id) ? (JSON.parse(rules.get(p.id)!.data) as BackupProfile['hideRules']) : null,
            parental: parental.get(p.id) ?? null,
            favorites: favorites.get(p.id) ?? [],
            progress: (progress.get(p.id) ?? []).map((x) => ({ ...x, finished: x.finished === 1 })),
            trackChoices: tracks.get(p.id) ?? [],
            lists: (lists.get(p.id) ?? []).map((l) => ({ ...l, channelIds: items.get(l.id) ?? [] })),
            mediaLists: (mediaLists.get(p.id) ?? []).map((l) => ({ ...l, items: mediaItems.get(l.id) ?? [] })),
            avatar: p.avatar,
            image: images.has(p.id) ? { ...images.get(p.id)!, data: images.get(p.id)!.data.toString('base64') } : null,
            lockHash: p.lock_hash,
            watchHistory: watch.get(p.id) ?? [],
          }),
        ),
      }),
    );
    const pinnedChannels = db.prepare('SELECT channel_id AS channelId, pinned_at AS pinnedAt FROM pinned_channels ORDER BY pinned_at, channel_id').all() as {
      channelId: string;
      pinnedAt: number;
    }[];
    return { format: BACKUP_FORMAT, schemaVersion: BACKUP_SCHEMA_VERSION, appVersion: VERSION, createdAt: now, users, pinnedChannels };
  })();
}

export interface RestoreOptions {
  mode: RestoreMode;
  /**
   * The admin restoring from the web app. Their account always survives a replace with its current
   * password: when the backup has it (same id or username), it takes the backup's profiles but keeps
   * the current password and stays admin; when it doesn't, the account and its profiles are kept.
   */
  currentUserId?: string | null;
}

export interface RestoreOutcome {
  /** profiles that exist after the restore and whose data changed */
  touchedProfiles: string[];
  keptCurrentAccount: boolean;
  pinsChanged: boolean;
}

/** Applies a validated backup (see format.ts parseBackup) in one transaction. */
export function restoreBackup(db: Db, backup: BackupFile, opts: RestoreOptions): RestoreOutcome {
  return db.transaction((): RestoreOutcome => {
    const replace = opts.mode === 'replace';
    const current = opts.currentUserId ? (db.prepare('SELECT * FROM users WHERE id = ?').get(opts.currentUserId) as UserRow | undefined) : undefined;
    const match = current
      ? backup.users.find((u) => u.id === current.id || u.username.toLowerCase() === current.username.toLowerCase())
      : undefined;
    const touched = new Set<string>();
    let pinsChanged = false;

    if (replace) {
      for (const r of db.prepare('SELECT id FROM profiles').all() as { id: string }[]) touched.add(r.id);
      // profiles cascade to favorites, progress, preferences, hide rules, parental, track choices and lists
      if (current && !match) {
        db.prepare('DELETE FROM profiles WHERE user_id != ?').run(current.id);
      } else {
        db.prepare('DELETE FROM profiles').run();
      }
      // users cascade to their sessions; the current admin's row stays, so they stay signed in
      if (current) db.prepare('DELETE FROM users WHERE id != ?').run(current.id);
      else db.prepare('DELETE FROM users').run();
      pinsChanged = db.prepare('DELETE FROM pinned_channels').run().changes > 0;
    }

    const q = {
      userById: db.prepare('SELECT id FROM users WHERE id = ?'),
      userByName: db.prepare('SELECT id FROM users WHERE username = ?'),
      insertUser: db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)'),
      profileOwner: db.prepare('SELECT user_id FROM profiles WHERE id = ?'),
      insertProfile: db.prepare('INSERT INTO profiles (id, user_id, name, created_at, avatar, lock_hash) VALUES (?, ?, ?, ?, ?, ?)'),
      image: db.prepare('INSERT OR IGNORE INTO profile_images (profile_id, mime, data, updated_at) VALUES (?, ?, ?, ?)'),
      prefs: db.prepare('INSERT OR IGNORE INTO preferences (profile_id, data) VALUES (?, ?)'),
      rules: db.prepare('INSERT OR IGNORE INTO hide_rules (profile_id, data) VALUES (?, ?)'),
      parental: db.prepare('INSERT OR IGNORE INTO parental (profile_id, mode, unlock_minutes, pin_hash, updated_at) VALUES (?, ?, ?, ?, ?)'),
      favorite: db.prepare('INSERT OR IGNORE INTO favorites (profile_id, kind, item_id, added_at) VALUES (?, ?, ?, ?)'),
      progress: db.prepare(
        'INSERT OR IGNORE INTO progress (profile_id, kind, item_id, series_id, position, duration, finished, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      track: db.prepare('INSERT OR IGNORE INTO track_choices (profile_id, kind, item_id, audio, subtitle, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
      watch: db.prepare(
        `INSERT INTO watch_history (profile_id, hour, kind, item_id, series_id, seconds) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, hour, kind, item_id) DO UPDATE SET seconds = MAX(seconds, excluded.seconds)`,
      ),
      listExists: db.prepare('SELECT 1 FROM channel_lists WHERE id = ?'),
      listMax: db.prepare('SELECT COALESCE(MAX(position), -1) AS n FROM channel_lists WHERE profile_id = ?'),
      insertList: db.prepare('INSERT INTO channel_lists (id, profile_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)'),
      listItem: db.prepare('INSERT OR IGNORE INTO channel_list_items (list_id, channel_id, position) VALUES (?, ?, ?)'),
      mediaListExists: db.prepare('SELECT 1 FROM media_lists WHERE id = ?'),
      watchLater: db.prepare("SELECT id FROM media_lists WHERE profile_id = ? AND builtin = 'watch-later'"),
      mediaListMax: db.prepare('SELECT COALESCE(MAX(position), -1) AS n FROM media_lists WHERE profile_id = ? AND builtin IS NULL'),
      insertMediaList: db.prepare('INSERT INTO media_lists (id, profile_id, name, builtin, position, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      mediaItemMax: db.prepare('SELECT COALESCE(MAX(position), -1) AS n FROM media_list_items WHERE list_id = ?'),
      mediaItem: db.prepare('INSERT OR IGNORE INTO media_list_items (list_id, kind, item_id, position, added_at) VALUES (?, ?, ?, ?, ?)'),
      pin: db.prepare('INSERT OR IGNORE INTO pinned_channels (channel_id, pinned_at) VALUES (?, ?)'),
    };

    for (const u of backup.users) {
      let userId: string;
      if (current && u === match) {
        userId = current.id;
        // their own account: keep the password they just confirmed, and keep them admin
        if (replace) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(current.id);
      } else {
        const existing = (q.userById.get(u.id) ?? q.userByName.get(u.username)) as { id: string } | undefined;
        if (existing) userId = existing.id;
        else {
          q.insertUser.run(u.id, u.username, u.passwordHash, u.isAdmin ? 1 : 0, u.createdAt);
          userId = u.id;
        }
      }
      for (const p of u.profiles) {
        const owner = q.profileOwner.get(p.id) as { user_id: string } | undefined;
        // merge: a profile id that belongs to another account is left alone (and its data with it)
        if (owner && owner.user_id !== userId) continue;
        let changed = false;
        const did = (r: { changes: number }) => {
          if (r.changes) changed = true;
        };
        if (!owner) did(q.insertProfile.run(p.id, userId, p.name, p.createdAt, p.avatar ?? null, p.lockHash ?? null));
        if (p.image) did(q.image.run(p.id, p.image.type, Buffer.from(p.image.data, 'base64'), p.image.updatedAt));
        if (p.preferences) did(q.prefs.run(p.id, JSON.stringify(mergePreferences(p.preferences))));
        if (p.hideRules) did(q.rules.run(p.id, JSON.stringify(p.hideRules)));
        if (p.parental) did(q.parental.run(p.id, p.parental.mode, p.parental.unlockMinutes, p.parental.pinHash, p.parental.updatedAt));
        for (const f of p.favorites) did(q.favorite.run(p.id, f.kind, f.id, f.addedAt));
        for (const x of p.progress) did(q.progress.run(p.id, x.kind, x.id, x.seriesId, x.position, x.duration, x.finished ? 1 : 0, x.updatedAt));
        for (const t of p.trackChoices) did(q.track.run(p.id, t.kind, t.id, t.audio, t.subtitle, t.updatedAt));
        for (const w of p.watchHistory ?? []) did(q.watch.run(p.id, w.hour, w.kind, w.id, w.seriesId, w.seconds));
        // lists that already exist are kept as they are; new ones go after the profile's own lists on a merge
        let next = replace ? 0 : (q.listMax.get(p.id) as { n: number }).n + 1;
        for (const l of [...p.lists].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)) {
          if (q.listExists.get(l.id)) continue;
          did(q.insertList.run(l.id, p.id, l.name, replace ? l.position : next++, l.createdAt));
          l.channelIds.forEach((c, i) => q.listItem.run(l.id, c, i));
        }
        // movie and series lists the same way; Watch Later items join the profile's own Watch Later
        let nextMedia = replace ? 0 : (q.mediaListMax.get(p.id) as { n: number }).n + 1;
        for (const l of [...p.mediaLists].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)) {
          if (l.builtin) {
            const own = q.watchLater.get(p.id) as { id: string } | undefined;
            if (own) {
              let pos = (q.mediaItemMax.get(own.id) as { n: number }).n + 1;
              for (const it of l.items) {
                const r = q.mediaItem.run(own.id, it.kind, it.id, pos, it.addedAt);
                if (r.changes) pos++;
                did(r);
              }
              continue;
            }
          }
          if (q.mediaListExists.get(l.id)) continue;
          did(q.insertMediaList.run(l.id, p.id, l.name, l.builtin, l.builtin ? -1 : replace ? l.position : nextMedia++, l.createdAt));
          l.items.forEach((it, i) => q.mediaItem.run(l.id, it.kind, it.id, i, it.addedAt));
        }
        if (changed) touched.add(p.id);
      }
    }

    // every account needs a profile to sign in with
    const bare = db.prepare('SELECT u.id, u.username, u.created_at FROM users u WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u.id)').all() as UserRow[];
    for (const u of bare) {
      const id = newId();
      q.insertProfile.run(id, u.id, u.username, Date.now(), null, null);
      touched.add(id);
    }

    for (const pin of backup.pinnedChannels) if (q.pin.run(pin.channelId, pin.pinnedAt).changes) pinsChanged = true;

    const alive = new Set((db.prepare('SELECT id FROM profiles').all() as { id: string }[]).map((r) => r.id));
    return {
      touchedProfiles: [...touched].filter((id) => alive.has(id)),
      keptCurrentAccount: replace && !!current && !match,
      pinsChanged,
    };
  })();
}

/** Tells every open device of the changed profiles to refetch (the usual per-kind events, then 'restored'). */
export function announceRestore(db: Db, bus: EventBus, userData: UserData, profileIds: string[]): void {
  const lists = new ChannelLists(db, bus);
  const media = new MediaLists(db, bus);
  for (const profileId of profileIds) {
    bus.emit({ type: 'favorites', profileId, favorites: userData.favorites(profileId) });
    bus.emit({ type: 'preferences', profileId, preferences: userData.preferences(profileId) });
    bus.emit({ type: 'hide-rules', profileId, rules: userData.hideRules(profileId) });
    bus.emit({ type: 'lists', profileId, lists: lists.all(profileId) });
    bus.emit({ type: 'media-lists', profileId, lists: media.all(profileId) });
    bus.emit({ type: 'parental', profileId });
    bus.emit({ type: 'restored', profileId });
  }
}
