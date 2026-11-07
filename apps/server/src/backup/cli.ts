/**
 * Restores a backup file without the web app:
 *   pnpm --filter @anycast/server run restore <file> [--merge] [--yes]
 * In the Docker image: node --import tsx src/backup/cli.ts /data/backups/<file>
 *
 * Uses DATA_DIR (from the environment or .env, default ./data). Best run while the server is
 * stopped; a running server works too, but open devices only notice after a reload.
 * Replace (the default) replaces every account and profile with the backup's; --merge keeps
 * what is there and adds what the backup has on top. A safety backup of the current data is
 * written to DATA_DIR/backups first (unless ANYCAST_BACKUP_KEEP=0).
 */
import { BACKUP_MAX_BYTES, summarizeBackup } from '@anycast/shared';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadEnvFiles } from '../config';
import { openDb } from '../db';
import { AutoBackups, DEFAULT_BACKUP_KEEP } from './auto';
import { restoreBackup } from './backup';
import { BackupError, parseBackup } from './format';

export function parseCliArgs(argv: string[]): { file: string | null; merge: boolean; yes: boolean } {
  const file = argv.find((a) => !a.startsWith('-') && a !== '--') ?? null;
  return { file, merge: argv.includes('--merge'), yes: argv.includes('--yes') || argv.includes('-y') };
}

async function main(): Promise<number> {
  loadEnvFiles();
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Usage: pnpm --filter @anycast/server run restore <backup.json> [--merge] [--yes]');
    return 1;
  }
  const file = path.resolve(args.file);
  let raw: unknown;
  try {
    if (statSync(file).size > BACKUP_MAX_BYTES) throw new Error(`the file is larger than ${BACKUP_MAX_BYTES / 1024 / 1024} MB`);
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Can't read ${file}: ${(err as Error).message}`);
    return 1;
  }
  let backup;
  try {
    backup = parseBackup(raw);
  } catch (err) {
    console.error(err instanceof BackupError ? err.message : `Invalid backup: ${(err as Error).message}`);
    return 1;
  }
  const sum = summarizeBackup(backup);
  const mode = args.merge ? 'merge' : 'replace';
  console.log(
    `Backup from ${new Date(backup.createdAt).toISOString()} (AnyCast ${backup.appVersion}): ${sum.users} account(s), ${sum.admins} admin(s), ` +
      `${sum.profiles} profile(s), ${sum.favorites} favorite(s), ${sum.inProgress + sum.finished} progress entries, ${sum.lists} channel list(s).`,
  );
  if (sum.admins === 0 && mode === 'replace') console.warn('Warning: the backup has no admin account. Nobody will be able to restore or see diagnostics in the app.');

  const dataDir = path.resolve(process.env.DATA_DIR?.trim() || './data');
  if (!args.yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      mode === 'replace'
        ? `Replace ALL accounts, profiles and their data in ${dataDir} with this backup? [y/N] `
        : `Add this backup's data to ${dataDir}, keeping what is there? [y/N] `,
    );
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Nothing changed.');
      return 1;
    }
  }

  const db = openDb(path.join(dataDir, 'anycast.db'));
  try {
    const keep = Number(process.env.ANYCAST_BACKUP_KEEP?.trim() || DEFAULT_BACKUP_KEEP);
    const safety = new AutoBackups(db, path.join(dataDir, 'backups'), Number.isFinite(keep) ? keep : DEFAULT_BACKUP_KEEP).beforeRestore();
    if (safety) console.log(`Saved the current data first: ${path.join(dataDir, 'backups', safety)}`);
    const out = restoreBackup(db, backup, { mode });
    console.log(`Restored (${mode}): ${out.touchedProfiles.length} profile(s) changed. Restart AnyCast (or reload the app) to see it.`);
    return 0;
  } catch (err) {
    console.error(`Restore failed, nothing was changed: ${(err as Error).message}`);
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && /backup[\\/]cli\.ts$/.test(process.argv[1])) {
  main().then((code) => process.exit(code));
}
