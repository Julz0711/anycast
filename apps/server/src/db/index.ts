import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations';

export type Db = Database.Database;

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // A sync commits every few ms (to keep requests flowing) and touches index pages all over:
  // checkpointing every 4 MB of WAL (the default) wrote the same pages to the database file again
  // and again. 16 MB between checkpoints makes a 195k item catalog sync ~20% faster; a checkpoint
  // then holds the event loop ~90 ms (40 MB: ~30% faster, but ~140 ms). The WAL file is cut
  // back to 64 MB after a checkpoint.
  db.pragma('wal_autocheckpoint = 4000');
  db.pragma(`journal_size_limit = ${64 * 1024 * 1024}`);
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function kvGet(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
