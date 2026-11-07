/** Backup files in the browser: read and check a chosen file, describe what it holds, save one. */
import { BACKUP_FORMAT, BACKUP_MAX_BYTES, BACKUP_SCHEMA_VERSION, summarizeBackup, type BackupFile, type BackupSummary } from '@anycast/shared';

export interface ReadBackup {
  backup: BackupFile;
  summary: BackupSummary;
}

/**
 * Parses a backup file's text and checks enough to describe it; the server validates it fully on
 * restore. Throws an Error with a message for the user.
 */
export function readBackup(text: string): ReadBackup {
  if (text.length > BACKUP_MAX_BYTES) throw new Error(`This file is too large for a backup (over ${BACKUP_MAX_BYTES / 1024 / 1024} MB).`);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('This is not an AnyCast backup file (it is not JSON).');
  }
  const b = doc as Partial<BackupFile> | null;
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) throw new Error('This is not an AnyCast backup file.');
  if (typeof b.schemaVersion !== 'number') throw new Error('This backup file has no valid schema version.');
  if (b.schemaVersion > BACKUP_SCHEMA_VERSION) throw new Error('This backup was made by a newer version of AnyCast. Update AnyCast, then restore it.');
  const okUsers = Array.isArray(b.users) && b.users.every((u) => u && typeof u === 'object' && Array.isArray(u.profiles) && u.profiles.every(okProfile));
  if (!okUsers || !Array.isArray(b.pinnedChannels)) throw new Error('This backup file is damaged or incomplete.');
  const backup = b as BackupFile;
  return { backup, summary: summarizeBackup(backup) };
}

const okProfile = (p: unknown) => {
  const x = p as Record<string, unknown> | null;
  return !!x && ['favorites', 'progress', 'trackChoices', 'lists'].every((k) => Array.isArray(x[k])) && (x.lists as { channelIds?: unknown }[]).every((l) => Array.isArray(l?.channelIds));
};

const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en')} ${count === 1 ? one : many}`;

/** One line per kind for the confirm dialog, e.g. "2 accounts (1 admin)"; empty kinds are left out. */
export function describeSummary(s: BackupSummary): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    { label: 'Accounts', value: `${n(s.users, 'account')} (${n(s.admins, 'admin')})` },
    { label: 'Profiles', value: n(s.profiles, 'profile') },
    { label: 'Favorites', value: n(s.favorites, 'favorite') },
    { label: 'Continue watching', value: n(s.inProgress, 'title') },
    { label: 'Watched', value: n(s.finished, 'title') },
    { label: 'Channel lists', value: s.lists ? `${n(s.lists, 'list')}, ${n(s.listChannels, 'channel')}` : n(0, 'list') },
    { label: 'Movie & series lists', value: n(s.mediaListItems ?? 0, 'title') + (s.mediaLists ? ` (${n(s.mediaLists, 'own list')} + Watch Later)` : '') },
    { label: 'Audio & subtitle choices', value: n(s.trackChoices, 'title') },
    { label: 'Parental PINs', value: n(s.pins, 'profile') },
    { label: 'Always-buffered channels', value: n(s.pinnedChannels, 'channel') },
  ];
  return rows.filter((r, i) => i < 2 || !/^0 /.test(r.value));
}

/**
 * The signed-in account in a backup: 'admin', 'user' (there, but not as an admin) or 'missing'.
 * Matched like the server does, by id or username. A replace keeps the signed-in admin able to sign
 * in either way; the dialog warns when the backup's admins don't include them.
 */
export function accountInBackup(backup: Pick<BackupFile, 'users'>, me: { id: string; username: string }): 'admin' | 'user' | 'missing' {
  const u = backup.users.find((x) => x.id === me.id || x.username.toLowerCase() === me.username.toLowerCase());
  return !u ? 'missing' : u.isAdmin ? 'admin' : 'user';
}

/** "6 Nov 2026, 14:05" in the user's time zone */
export function fmtBackupDate(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Hands the user a JSON file to save (works the same in the demo, where nothing comes from a server). */
export function saveJsonFile(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
