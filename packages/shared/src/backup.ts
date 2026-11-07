/**
 * Backup and restore of AnyCast's own user data (admin only).
 *
 * A backup is one JSON file: accounts (with their argon2 password hashes), profiles and everything
 * per profile (picture, profile lock, preferences, hide rules, parental lock, favorites, progress,
 * track choices, channel lists, movie and series lists) and the channels pinned for the rewind buffer. It never holds the provider login, sign-in
 * sessions, the encryption secret, the catalog, the guide, or any cache: those come back from the
 * provider on the next sync. Ids of channels, movies and episodes are kept even when the catalog
 * doesn't (yet) have them, so a restore on a fresh install works before the first sync.
 *
 * The file names its `schemaVersion`; the server migrates older versions forward and refuses newer
 * ones. `appVersion` is informational.
 */
import type { AdultMode } from './parental';
import type { HideRules, MediaKind } from './catalog';

export const BACKUP_FORMAT = 'anycast-backup';
/** 2 added `mediaLists` (Watch Later and the user's movie and series lists) to every profile. */
export const BACKUP_SCHEMA_VERSION = 2;
/** Largest backup file a restore accepts. */
export const BACKUP_MAX_BYTES = 32 * 1024 * 1024;

export interface BackupFavorite { kind: MediaKind; id: string; addedAt: number }
export interface BackupProgress {
  kind: 'movie' | 'episode';
  id: string;
  seriesId: string | null;
  /** seconds */
  position: number;
  duration: number;
  /** watched to the end ("finished"); unfinished entries are Continue watching */
  finished: boolean;
  updatedAt: number;
}
/** audio / subtitle = source track index; subtitle -1 = turned off; null = not picked */
export interface BackupTrackChoice { kind: 'movie' | 'episode' | 'live'; id: string; audio: number | null; subtitle: number | null; updatedAt: number }
export interface BackupList { id: string; name: string; position: number; createdAt: number; channelIds: string[] }
/** builtin 'watch-later' is the profile's Watch Later list */
export interface BackupMediaList {
  id: string;
  name: string;
  builtin: 'watch-later' | null;
  position: number;
  createdAt: number;
  items: { kind: 'movie' | 'series'; id: string; addedAt: number }[];
}
export interface BackupParental { mode: AdultMode; unlockMinutes: number; /** argon2 hash of the PIN */ pinHash: string | null; updatedAt: number }

export interface BackupProfile {
  id: string;
  name: string;
  createdAt: number;
  /** the stored Preferences; null = defaults */
  preferences: Record<string, unknown> | null;
  hideRules: HideRules | null;
  parental: BackupParental | null;
  favorites: BackupFavorite[];
  progress: BackupProgress[];
  trackChoices: BackupTrackChoice[];
  lists: BackupList[];
  mediaLists: BackupMediaList[];
  /** built-in picture "shape.color" (missing in backups made before profile pictures) */
  avatar?: string | null;
  /** uploaded picture, base64 */
  image?: { type: string; data: string; updatedAt: number } | null;
  /** argon2 hash of the profile lock PIN */
  lockHash?: string | null;
}

export interface BackupUser {
  id: string;
  username: string;
  /** argon2 hash; the password itself is never stored */
  passwordHash: string;
  isAdmin: boolean;
  createdAt: number;
  profiles: BackupProfile[];
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  appVersion: string;
  /** epoch ms */
  createdAt: number;
  users: BackupUser[];
  /** channels that always keep a rewind buffer (server-wide) */
  pinnedChannels: { channelId: string; pinnedAt: number }[];
}

/** What a backup holds, for the confirm dialog and the restore answer. */
export interface BackupSummary {
  users: number;
  admins: number;
  profiles: number;
  favorites: number;
  /** progress entries still being watched (Continue watching) */
  inProgress: number;
  /** progress entries watched to the end */
  finished: number;
  lists: number;
  listChannels: number;
  /** the user's own movie and series lists (Watch Later not counted) */
  mediaLists: number;
  /** movies and series in all media lists, Watch Later included */
  mediaListItems: number;
  trackChoices: number;
  /** profiles with a parental PIN */
  pins: number;
  pinnedChannels: number;
}

export function summarizeBackup(b: Pick<BackupFile, 'users' | 'pinnedChannels'>): BackupSummary {
  const profiles = b.users.flatMap((u) => u.profiles);
  const sum = (f: (p: BackupProfile) => number) => profiles.reduce((n, p) => n + f(p), 0);
  return {
    users: b.users.length,
    admins: b.users.filter((u) => u.isAdmin).length,
    profiles: profiles.length,
    favorites: sum((p) => p.favorites.length),
    inProgress: sum((p) => p.progress.filter((x) => !x.finished).length),
    finished: sum((p) => p.progress.filter((x) => x.finished).length),
    lists: sum((p) => p.lists.length),
    listChannels: sum((p) => p.lists.reduce((n, l) => n + l.channelIds.length, 0)),
    mediaLists: sum((p) => (p.mediaLists ?? []).filter((l) => !l.builtin).length),
    mediaListItems: sum((p) => (p.mediaLists ?? []).reduce((n, l) => n + l.items.length, 0)),
    trackChoices: sum((p) => p.trackChoices.length),
    pins: sum((p) => (p.parental?.pinHash ? 1 : 0)),
    pinnedChannels: b.pinnedChannels.length,
  };
}

/**
 * replace (default): the backup's data replaces all user data. The signed-in admin's account is
 * always kept with its current password, so they can still sign in.
 * merge: existing data stays as it is; what the backup has and the server doesn't is added.
 */
export type RestoreMode = 'replace' | 'merge';

export interface RestoreResult {
  ok: true;
  mode: RestoreMode;
  /** what the backup held */
  summary: BackupSummary;
  /** the signed-in admin was not in the backup, so the account (and its profiles) was kept */
  keptCurrentAccount: boolean;
  /** file name of the automatic backup taken just before restoring, if automatic backups are on */
  safetyBackup: string | null;
}

export interface AutoBackupFile { name: string; bytes: number; /** epoch ms */ createdAt: number }
export interface AutoBackups {
  /** how many automatic backups are kept (ANYCAST_BACKUP_KEEP); 0 = automatic backups off */
  keep: number;
  files: AutoBackupFile[];
}

/** `anycast-backup-2026-11-06.json` for a date, in UTC. */
export function backupFileName(at: number | Date): string {
  return `anycast-backup-${new Date(at).toISOString().slice(0, 10)}.json`;
}
