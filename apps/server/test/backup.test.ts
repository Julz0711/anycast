import { BACKUP_MAX_BYTES, BACKUP_SCHEMA_VERSION, summarizeBackup, type AutoBackups as AutoBackupList, type BackupFile, type RestoreResult, type SyncEvent } from '@anycast/shared';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AutoBackups } from '../src/backup/auto';
import { exportBackup, restoreBackup } from '../src/backup/backup';
import { parseCliArgs } from '../src/backup/cli';
import { parseBackup } from '../src/backup/format';
import { BACKUP_TABLES } from '../src/backup/tables';
import { openDb, type Db } from '../src/db';
import { ADMIN, createMockXtream, login, makeApp } from './helpers';

const exec = promisify(execFile);
const CREDS = { username: 'backup-user-7713', password: 'backup-pass-5519' };
const VIEWER = { username: 'viewer', password: 'viewer-password-1' };
let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let viewerCookie: string;
let adminProfile: string;
let ip = 0;

/** every request from its own address, so the restore rate limit only bites where a test wants it */
const call = (opts: InjectOptions, as = cookie) =>
  built.app.inject({ remoteAddress: `10.1.${Math.floor(++ip / 250)}.${ip % 250}`, ...opts, headers: { cookie: as, ...(opts.headers ?? {}) } });
const download = async (): Promise<BackupFile> => {
  const res = await call({ url: '/api/admin/backup' });
  expect(res.statusCode).toBe(200);
  return res.json() as BackupFile;
};
const restore = (backup: unknown, mode?: 'replace' | 'merge', password = ADMIN.password) =>
  call({ method: 'POST', url: '/api/admin/restore', payload: { backup, ...(mode ? { mode } : {}), password } });
const withoutTime = (b: BackupFile) => ({ ...b, createdAt: 0 });
const db = (): Db => built.services.db;
const favoriteIds = (profileId: string) => built.services.userData.favorites(profileId).map((f) => `${f.kind}:${f.id}`);

/** Fills the admin's and a viewer's profiles with one of everything. */
async function seed() {
  const { userData, users } = built.services;
  const adminId = (db().prepare('SELECT id FROM users WHERE username = ?').get(ADMIN.username) as { id: string }).id;
  adminProfile = users.profiles(adminId)[0]!.id;
  userData.setFavorite(adminProfile, 'live', 'ch-1', true);
  userData.setFavorite(adminProfile, 'movie', 'not-synced-yet', true);
  userData.saveProgress(adminProfile, { kind: 'movie', id: 'mv-1', position: 600, duration: 6000 });
  userData.saveProgress(adminProfile, { kind: 'episode', id: 'ep-1', seriesId: 'sr-1', position: 2990, duration: 3000 });
  userData.updatePreferences(adminProfile, { appearance: { accent: 'violet' }, setupDone: true });
  userData.setHideRules(adminProfile, { countries: ['TR'], languages: ['ar'], categoryIds: ['cat-9'] });
  userData.saveTrackChoice(adminProfile, 'movie', 'mv-1', { audio: 2, subtitle: null });
  const list = await call({ method: 'POST', url: '/api/lists', payload: { name: 'News', channelIds: ['ch-3', 'ch-1', 'gone-channel'] }, headers: { 'x-anycast-profile': adminProfile } });
  expect(list.statusCode).toBe(200);
  const h = { 'x-anycast-profile': adminProfile };
  const wl = (await call({ url: '/api/media-lists', headers: h })).json() as { id: string }[];
  expect((await call({ method: 'PUT', url: `/api/media-lists/${wl[0]!.id}/items`, payload: { items: [{ kind: 'movie', id: 'mv-1' }] }, headers: h })).statusCode).toBe(200);
  const own = await call({ method: 'POST', url: '/api/media-lists', payload: { name: 'Date night', items: [{ kind: 'series', id: 'sr-1' }, { kind: 'movie', id: 'gone-movie' }] }, headers: h });
  expect(own.statusCode).toBe(200);
  const pin = await call({ method: 'PUT', url: '/api/adult/pin', payload: { pin: '4321', password: ADMIN.password }, headers: { 'x-anycast-profile': adminProfile } });
  expect(pin.statusCode).toBe(200);
  db().prepare('INSERT INTO pinned_channels (channel_id, pinned_at) VALUES (?, ?)').run('ch-1', 1000);

  const viewer = await users.create(VIEWER.username, VIEWER.password, false);
  const kids = users.createProfile(viewer.id, 'Kids');
  userData.setFavorite(kids.id, 'series', 'sr-1', true);
}

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', ...CREDS });
  built = await makeApp({ url: mock.url, username: CREDS.username, password: CREDS.password }, { config: { backupKeep: 3 } });
  cookie = await login(built.app);
  await seed();
  viewerCookie = await login(built.app, VIEWER);
});

afterAll(async () => {
  await built.app.close();
  await mock.close();
});

describe('what a backup holds', () => {
  test('every table of the schema has an include / exclude decision', () => {
    const rows = db().prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[];
    const virtual = rows.filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql)).map((r) => r.name);
    // FTS5 keeps its data in shadow tables named after the virtual table
    const tables = rows.map((r) => r.name).filter((n) => !virtual.some((v) => n.startsWith(`${v}_`)));
    const undecided = tables.filter((t) => !(t in BACKUP_TABLES));
    expect(undecided, `add these tables to BACKUP_TABLES in src/backup/tables.ts: ${undecided.join(', ')}`).toEqual([]);
    expect(Object.keys(BACKUP_TABLES).filter((t) => !tables.includes(t)), 'BACKUP_TABLES names tables that no longer exist').toEqual([]);
  });

  test('the download has users, profiles and all their data, as an attachment', async () => {
    const res = await call({ url: '/api/admin/backup' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="anycast-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const b = res.json() as BackupFile;
    expect(b).toMatchObject({ format: 'anycast-backup', schemaVersion: BACKUP_SCHEMA_VERSION, appVersion: expect.any(String), createdAt: expect.any(Number) });
    expect(b.users.map((u) => [u.username, u.isAdmin])).toEqual([[ADMIN.username, true], [VIEWER.username, false]]);
    expect(b.users.every((u) => u.passwordHash.startsWith('$argon2'))).toBe(true);
    const admin = b.users[0]!.profiles[0]!;
    expect(admin.favorites.map((f) => `${f.kind}:${f.id}`)).toEqual(['live:ch-1', 'movie:not-synced-yet']);
    expect([...admin.progress].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      expect.objectContaining({ kind: 'episode', id: 'ep-1', seriesId: 'sr-1', finished: true }),
      expect.objectContaining({ kind: 'movie', id: 'mv-1', position: 600, finished: false, seriesId: null }),
    ]);
    expect(admin.preferences).toMatchObject({ appearance: { accent: 'violet' }, setupDone: true });
    expect(admin.hideRules).toEqual({ countries: ['tr'], languages: ['ar'], categoryIds: ['cat-9'] });
    expect(admin.trackChoices).toEqual([expect.objectContaining({ kind: 'movie', id: 'mv-1', audio: 2, subtitle: -1 })]);
    expect(admin.lists).toEqual([expect.objectContaining({ name: 'News', channelIds: ['ch-3', 'ch-1', 'gone-channel'] })]);
    expect(admin.mediaLists).toEqual([
      expect.objectContaining({ name: 'Watch Later', builtin: 'watch-later', items: [expect.objectContaining({ kind: 'movie', id: 'mv-1' })] }),
      expect.objectContaining({ name: 'Date night', builtin: null, items: [expect.objectContaining({ id: 'sr-1' }), expect.objectContaining({ id: 'gone-movie' })] }),
    ]);
    expect(admin.parental).toMatchObject({ pinHash: expect.stringMatching(/^\$argon2/) });
    expect(b.users[1]!.profiles.map((p) => p.name)).toEqual([VIEWER.username, 'Kids']);
    expect(b.pinnedChannels).toEqual([{ channelId: 'ch-1', pinnedAt: 1000 }]);
    expect(summarizeBackup(b)).toEqual({
      users: 2, admins: 1, profiles: 3, favorites: 3, inProgress: 1, finished: 1, lists: 1, listChannels: 3, mediaLists: 1, mediaListItems: 3, trackChoices: 1, pins: 1, pinnedChannels: 1,
    });
  });

  test('no provider login, sessions, tokens or the encryption key', async () => {
    const text = (await call({ url: '/api/admin/backup' })).body;
    const token = cookie.split('=')[1]!;
    const encrypted = (db().prepare('SELECT credentials FROM source').get() as { credentials: string }).credentials;
    const sessions = (db().prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[]).map((r) => r.token_hash);
    expect(sessions.length).toBeGreaterThan(0);
    for (const secret of [CREDS.username, CREDS.password, mock.url, new URL(mock.url).host, built.services.config.secret, token, viewerCookie.split('=')[1]!, encrypted, ...sessions]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/xtream|token|credential|secret|session/i);
  });

  test('only admins', async () => {
    for (const opts of [
      { url: '/api/admin/backup' },
      { url: '/api/admin/backups' },
      { url: '/api/admin/backups/anycast-backup-2026-01-01.json' },
      { method: 'POST' as const, url: '/api/admin/restore', payload: { backup: {}, password: VIEWER.password } },
    ]) {
      const res = await call(opts, viewerCookie);
      expect(res.statusCode, opts.url).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden' });
    }
    expect((await built.app.inject({ url: '/api/admin/backup' })).statusCode).toBe(401);
  });
});

describe('restore', () => {
  let original: BackupFile;
  beforeAll(async () => {
    original = await download();
  });
  beforeEach(async () => {
    // every test starts from the seeded data
    const res = await restore(original);
    expect(res.statusCode, res.body).toBe(200);
  });

  test('round trip: export, wipe, restore gives identical data (in a fresh database too)', async () => {
    const fresh = openDb(':memory:');
    restoreBackup(fresh, original, { mode: 'replace' });
    expect(withoutTime(exportBackup(fresh))).toEqual(withoutTime(original));
    fresh.close();

    // wipe (all but the signed-in admin's account and profile, needed to call the API), then restore
    db().prepare('DELETE FROM profiles WHERE id != ?').run(adminProfile);
    for (const t of ['favorites', 'progress', 'preferences', 'hide_rules', 'parental', 'track_choices', 'channel_lists', 'pinned_channels']) db().prepare(`DELETE FROM ${t}`).run();
    db().prepare('DELETE FROM users WHERE username != ?').run(ADMIN.username);
    const res = await restore(original);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, mode: 'replace', keptCurrentAccount: false, summary: { profiles: 3, favorites: 3 } });
    expect(withoutTime(await download())).toEqual(withoutTime(original));
    // the viewer signs in with the restored password
    await login(built.app, VIEWER);
  });

  test('replace removes what the backup does not have; ids the catalog does not know are kept', async () => {
    built.services.userData.setFavorite(adminProfile, 'movie', 'added-later', true);
    const extra = built.services.users.createProfile(original.users[0]!.id, 'Extra');
    expect((await restore(original, 'replace')).statusCode).toBe(200);
    expect(favoriteIds(adminProfile)).toEqual(['live:ch-1', 'movie:not-synced-yet']);
    expect(built.services.users.profiles(original.users[0]!.id).map((p) => p.id)).not.toContain(extra.id);
  });

  test('merge keeps what exists and adds what is missing', async () => {
    const { userData } = built.services;
    userData.setFavorite(adminProfile, 'live', 'ch-1', false);
    userData.setFavorite(adminProfile, 'movie', 'only-here', true);
    userData.updatePreferences(adminProfile, { appearance: { accent: 'mint' } });
    userData.saveProgress(adminProfile, { kind: 'movie', id: 'mv-1', position: 1200, duration: 6000 });
    db().prepare('DELETE FROM channel_lists WHERE profile_id = ?').run(adminProfile);
    const mine = await call({ method: 'POST', url: '/api/lists', payload: { name: 'Mine' }, headers: { 'x-anycast-profile': adminProfile } });
    const kids = original.users[1]!.profiles[1]!.id;
    db().prepare('DELETE FROM profiles WHERE id = ?').run(kids);

    const res = await restore(original, 'merge');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'merge', keptCurrentAccount: false });
    expect(favoriteIds(adminProfile).sort()).toEqual(['live:ch-1', 'movie:not-synced-yet', 'movie:only-here']);
    expect(userData.preferences(adminProfile).appearance.accent).toBe('mint');
    expect(userData.progressFor(adminProfile, 'movie', 'mv-1')?.position).toBe(1200);
    const lists = await call({ url: '/api/lists', headers: { 'x-anycast-profile': adminProfile } });
    expect((lists.json() as { name: string }[]).map((l) => l.name)).toEqual([(mine.json() as { name: string }).name, 'News']);
    expect(favoriteIds(kids)).toEqual(['series:sr-1']);
  });

  test('the signed-in admin can still sign in: kept when missing from the backup, password kept when present', async () => {
    const viewerOnly: BackupFile = { ...original, users: [original.users[1]!] };
    const res = await restore(viewerOnly);
    expect(res.statusCode).toBe(200);
    expect((res.json() as RestoreResult).keptCurrentAccount).toBe(true);
    expect(favoriteIds(adminProfile)).toEqual(['live:ch-1', 'movie:not-synced-yet']);
    expect((await call({ url: '/api/me' })).statusCode).toBe(200);
    await login(built.app);

    // the backup has the admin, with another password and not as admin: the current password and admin stay
    const other = await built.services.users.create('someone', 'someone-password', false);
    const otherHash = (db().prepare('SELECT password_hash FROM users WHERE id = ?').get(other.id) as { password_hash: string }).password_hash;
    const changed: BackupFile = { ...original, users: original.users.map((u) => (u.username === ADMIN.username ? { ...u, id: 'other-id', passwordHash: otherHash, isAdmin: false } : u)) };
    const again = await restore(changed);
    expect(again.statusCode).toBe(200);
    expect((again.json() as RestoreResult).keptCurrentAccount).toBe(false);
    await login(built.app);
    expect((await call({ url: '/api/me' })).json()).toMatchObject({ user: { username: ADMIN.username, isAdmin: true } });
    expect(favoriteIds(adminProfile)).toEqual(['live:ch-1', 'movie:not-synced-yet']);
  });

  test('needs the admin password', async () => {
    built.services.userData.setFavorite(adminProfile, 'movie', 'stays', true);
    const res = await restore(original, 'replace', 'wrong-password');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'wrong_password' });
    expect(favoriteIds(adminProfile)).toContain('movie:stays');
    expect((await call({ method: 'POST', url: '/api/admin/restore', payload: { backup: original } })).statusCode).toBe(400);
  });

  test('a format 1 backup (before movie and series lists) still restores', async () => {
    const v1 = structuredClone(original) as unknown as { schemaVersion: number; users: { profiles: Record<string, unknown>[] }[] };
    v1.schemaVersion = 1;
    for (const u of v1.users) for (const p of u.profiles) delete p.mediaLists;
    const res = await restore(v1, 'merge');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ summary: { mediaLists: 0, mediaListItems: 0 } });
  });

  test('refuses files that are not valid backups, and changes nothing', async () => {
    built.services.userData.setFavorite(adminProfile, 'movie', 'stays', true);
    const u0 = original.users[0]!;
    const p0 = u0.profiles[0]!;
    const cases: [unknown, string, RegExp][] = [
      ['hello', 'bad_backup', /not an AnyCast backup/],
      [{ ...original, format: 'other' }, 'bad_backup', /not an AnyCast backup/],
      [{ ...original, schemaVersion: BACKUP_SCHEMA_VERSION + 1 }, 'backup_version', /newer version of AnyCast/],
      [{ ...original, schemaVersion: '1' }, 'bad_backup', /schema version/],
      [{ ...original, users: undefined }, 'bad_backup', /damaged/],
      [{ ...original, extra: 1 }, 'bad_backup', /damaged/],
      [{ ...original, users: [{ ...u0, passwordHash: 'plaintext' }] }, 'bad_backup', /argon2/],
      [{ ...original, users: [{ ...u0, profiles: [{ ...p0, favorites: [{ kind: 'podcast', id: 'x', addedAt: 1 }] }] }] }, 'bad_backup', /favorites/],
      [{ ...original, users: [{ ...u0, profiles: [p0, p0] }] }, 'bad_backup', /appears twice/],
      [{ ...original, users: [{ ...u0, profiles: [{ ...p0, parental: { ...p0.parental, unlockMinutes: 7 } }] }] }, 'bad_backup', /unlock duration/],
    ];
    for (const [backup, error, message] of cases) {
      const res = await restore(backup);
      expect(res.statusCode, JSON.stringify(backup).slice(0, 80)).toBe(400);
      expect(res.json()).toMatchObject({ error, message: expect.stringMatching(message) });
    }
    expect(favoriteIds(adminProfile)).toContain('movie:stays');

    const huge = await call({
      method: 'POST', url: '/api/admin/restore', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ backup: { ...original, pad: 'x'.repeat(BACKUP_MAX_BYTES + 100_000) }, password: ADMIN.password }),
    });
    expect(huge.statusCode).toBe(413);
  });

  test('is rate limited', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await built.app.inject({ remoteAddress: '10.9.9.9', method: 'POST', url: '/api/admin/restore', headers: { cookie }, payload: { backup: {}, password: 'x' } });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 403)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  test('open devices hear about it', async () => {
    const events: SyncEvent[] = [];
    const off = built.services.bus.subscribe(adminProfile, (e) => events.push(e));
    built.services.userData.setFavorite(adminProfile, 'live', 'ch-1', false);
    events.length = 0;
    expect((await restore(original, 'merge')).statusCode).toBe(200);
    off();
    expect(events.map((e) => e.type)).toEqual(['favorites', 'preferences', 'hide-rules', 'lists', 'media-lists', 'parental', 'restored']);
    expect(events[0]).toMatchObject({ favorites: [expect.objectContaining({ id: 'ch-1' }), expect.objectContaining({ id: 'not-synced-yet' })] });
  });

  test('takes a safety backup first', async () => {
    const res = (await restore(original)).json() as RestoreResult;
    expect(res.safetyBackup).toMatch(/^anycast-backup-\d{4}-\d{2}-\d{2}-\d{6}-before-restore\.json$/);
    const list = (await call({ url: '/api/admin/backups' })).json() as AutoBackupList;
    expect(list.keep).toBe(3);
    expect(list.files.length).toBeLessThanOrEqual(3);
    expect(list.files.map((f) => f.name)).toContain(res.safetyBackup);
    const file = await call({ url: `/api/admin/backups/${res.safetyBackup}` });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toContain(res.safetyBackup!);
    expect(parseBackup(file.json()).users.length).toBe(2);
    for (const bad of ['..%2Fanycast.db', 'anycast.db', 'anycast-backup-1999-01-01.json']) {
      expect((await call({ url: `/api/admin/backups/${bad}` })).statusCode, bad).toBe(404);
    }
  });
});

describe('automatic backups', () => {
  test('one a day, newest kept, 0 turns them off', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'anycast-backups-'));
    const auto = new AutoBackups(db(), dir, 3);
    const day = (d: number) => Date.UTC(2026, 0, d, 12);
    for (let d = 1; d <= 5; d++) expect(auto.daily(day(d))).toBe(`anycast-backup-2026-01-0${d}.json`);
    expect(auto.daily(day(5) + 3600_000)).toBeNull();
    expect(auto.list().map((f) => f.name)).toEqual(['anycast-backup-2026-01-05.json', 'anycast-backup-2026-01-04.json', 'anycast-backup-2026-01-03.json']);
    expect(existsSync(path.join(dir, 'anycast-backup-2026-01-01.json'))).toBe(false);
    const file = path.join(dir, 'anycast-backup-2026-01-05.json');
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(parseBackup(JSON.parse(readFileSync(file, 'utf8'))).createdAt).toBe(day(5));
    // files it didn't write are left alone
    writeFileSync(path.join(dir, 'notes.txt'), 'hi');
    expect(auto.rotate()).toEqual([]);
    expect(existsSync(path.join(dir, 'notes.txt'))).toBe(true);

    const off = new AutoBackups(db(), mkdtempSync(path.join(os.tmpdir(), 'anycast-backups-')), 0);
    expect(off.daily()).toBeNull();
    expect(off.beforeRestore()).toBeNull();
    expect(off.list()).toEqual([]);
  });
});

describe('restore CLI', () => {
  test('arguments', () => {
    expect(parseCliArgs(['--', 'file.json', '--merge'])).toEqual({ file: 'file.json', merge: true, yes: false });
    expect(parseCliArgs(['-y', 'x.json'])).toEqual({ file: 'x.json', merge: false, yes: true });
    expect(parseCliArgs([])).toMatchObject({ file: null });
  });

  test('restores a file into DATA_DIR', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'anycast-cli-'));
    const file = path.join(dataDir, 'in.json');
    writeFileSync(file, JSON.stringify(exportBackup(db())));
    const env = { ...process.env, DATA_DIR: dataDir, ANYCAST_BACKUP_KEEP: '2' };
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'src/backup/cli.ts', file, '--yes'], { cwd, env });
    expect(stdout).toMatch(/Restored \(replace\)/);
    const restored = openDb(path.join(dataDir, 'anycast.db'));
    expect(withoutTime(exportBackup(restored))).toEqual(withoutTime(exportBackup(db())));
    restored.close();

    writeFileSync(file, '{"format":"nope"}');
    await expect(exec(process.execPath, ['--import', 'tsx', 'src/backup/cli.ts', file, '--yes'], { cwd, env })).rejects.toMatchObject({
      stderr: expect.stringMatching(/not an AnyCast backup/),
    });
  });
});
