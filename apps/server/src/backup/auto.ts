/**
 * Automatic backups: one file a day in DATA_DIR/backups (anycast-backup-YYYY-MM-DD.json, UTC date),
 * the newest `keep` are kept (ANYCAST_BACKUP_KEEP, default 7, 0 = off). A restore from the web app
 * first writes a safety backup there too (anycast-backup-YYYY-MM-DD-HHMMSS-before-restore.json).
 * Files are written to a temp name and renamed, so a crash never leaves half a backup.
 */
import { backupFileName, type AutoBackupFile } from '@anycast/shared';
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db';
import { exportBackup } from './backup';

export const DEFAULT_BACKUP_KEEP = 7;
/** names this module writes (and the only ones the routes serve) */
export const BACKUP_NAME = /^anycast-backup-\d{4}-\d{2}-\d{2}(-\d{6}-before-restore)?\.json$/;

export class AutoBackups {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    readonly dir: string,
    readonly keep: number,
    private readonly onError: (msg: string) => void = () => {},
  ) {}

  /** Backs up now if today's backup is missing, then once an hour checks again. */
  start(): void {
    if (this.keep <= 0 || this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 3600_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    try {
      this.daily();
    } catch (err) {
      this.onError(`automatic backup failed: ${(err as Error).message}`);
    }
  }

  /** Writes today's backup unless it exists, then rotates. Returns the file name written, or null. */
  daily(now = Date.now()): string | null {
    if (this.keep <= 0) return null;
    const name = backupFileName(now);
    if (this.list().some((f) => f.name === name)) return null;
    this.write(name, now);
    this.rotate();
    return name;
  }

  /** The safety copy taken just before a restore; null when automatic backups are off. */
  beforeRestore(now = Date.now()): string | null {
    if (this.keep <= 0) return null;
    const d = new Date(now).toISOString();
    const name = `${backupFileName(now).slice(0, -5)}-${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}-before-restore.json`;
    this.write(name, now);
    this.rotate();
    return name;
  }

  private write(name: string, now: number): void {
    mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, name);
    const tmp = `${file}.tmp`;
    // the file holds password and PIN hashes: readable by the server's user only
    writeFileSync(tmp, JSON.stringify(exportBackup(this.db, now)), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  /** Newest first. */
  list(): AutoBackupFile[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => BACKUP_NAME.test(n))
      .flatMap((name) => {
        try {
          const st = statSync(path.join(this.dir, name));
          return [{ name, bytes: st.size, createdAt: Math.round(st.mtimeMs) }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
  }

  /** Deletes all but the newest `keep` backups. */
  rotate(): string[] {
    const removed = this.list().slice(Math.max(0, this.keep)).map((f) => f.name);
    for (const name of removed) rmSync(path.join(this.dir, name), { force: true });
    return removed;
  }

  /** Path of a backup by name, or null for a name this module didn't write. */
  file(name: string): string | null {
    return BACKUP_NAME.test(name) && this.list().some((f) => f.name === name) ? path.join(this.dir, name) : null;
  }
}
