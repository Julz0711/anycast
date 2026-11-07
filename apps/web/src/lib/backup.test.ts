import { BACKUP_SCHEMA_VERSION, type BackupFile, type BackupProfile } from '@anycast/shared';
import { expect, test } from 'vitest';
import { accountInBackup, describeSummary, readBackup } from './backup';

const profile = (id: string, extra: Partial<BackupProfile> = {}): BackupProfile => ({
  id, name: id, createdAt: 0, preferences: null, hideRules: null, parental: null, favorites: [], progress: [], trackChoices: [], lists: [], mediaLists: [], ...extra,
});

const file: BackupFile = {
  format: 'anycast-backup', schemaVersion: BACKUP_SCHEMA_VERSION, appVersion: '0.1.0', createdAt: Date.UTC(2026, 10, 6),
  users: [
    {
      id: 'u1', username: 'Julz', passwordHash: '$argon2id$x', isAdmin: true, createdAt: 0,
      profiles: [
        profile('p1', {
          favorites: [{ kind: 'live', id: 'ch1', addedAt: 1 }, { kind: 'movie', id: 'm1', addedAt: 2 }],
          progress: [
            { kind: 'movie', id: 'm1', seriesId: null, position: 10, duration: 100, finished: false, updatedAt: 1 },
            { kind: 'episode', id: 'e1', seriesId: 's1', position: 99, duration: 100, finished: true, updatedAt: 1 },
            { kind: 'episode', id: 'e2', seriesId: 's1', position: 98, duration: 100, finished: true, updatedAt: 1 },
          ],
          lists: [{ id: 'l1', name: 'News', position: 0, createdAt: 0, channelIds: ['a', 'b', 'c'] }],
          parental: { mode: 'locked', unlockMinutes: 30, pinHash: '$argon2id$pin', updatedAt: 0 },
        }),
        profile('p2'),
      ],
    },
    { id: 'u2', username: 'sam', passwordHash: '$argon2id$y', isAdmin: false, createdAt: 0, profiles: [profile('p3', { favorites: [{ kind: 'series', id: 's1', addedAt: 1 }] })] },
  ],
  pinnedChannels: [],
};

test('summary: counts per kind, empty kinds left out', () => {
  const { summary } = readBackup(JSON.stringify(file));
  expect(summary).toMatchObject({ users: 2, admins: 1, profiles: 3, favorites: 3, inProgress: 1, finished: 2, lists: 1, listChannels: 3, pins: 1, pinnedChannels: 0 });
  expect(describeSummary(summary)).toEqual([
    { label: 'Accounts', value: '2 accounts (1 admin)' },
    { label: 'Profiles', value: '3 profiles' },
    { label: 'Favorites', value: '3 favorites' },
    { label: 'Continue watching', value: '1 title' },
    { label: 'Watched', value: '2 titles' },
    { label: 'Channel lists', value: '1 list, 3 channels' },
    { label: 'Parental PINs', value: '1 profile' },
  ]);
});

test('an empty backup still names accounts and profiles', () => {
  const { summary } = readBackup(JSON.stringify({ ...file, users: [] }));
  expect(describeSummary(summary)).toEqual([
    { label: 'Accounts', value: '0 accounts (0 admins)' },
    { label: 'Profiles', value: '0 profiles' },
  ]);
});

test('files that are not backups are refused with a message', () => {
  expect(() => readBackup('not json')).toThrow(/not JSON/);
  expect(() => readBackup('{"format":"other"}')).toThrow(/not an AnyCast backup/);
  expect(() => readBackup(JSON.stringify({ ...file, schemaVersion: BACKUP_SCHEMA_VERSION + 1 }))).toThrow(/newer version/);
  expect(() => readBackup(JSON.stringify({ ...file, users: [{ profiles: [{ favorites: [] }] }] }))).toThrow(/damaged/);
});

test('the signed-in account in the backup', () => {
  expect(accountInBackup(file, { id: 'other', username: 'julz' })).toBe('admin');
  expect(accountInBackup(file, { id: 'u2', username: 'renamed' })).toBe('user');
  expect(accountInBackup(file, { id: 'u9', username: 'nobody' })).toBe('missing');
});
