/** The backup file format: strict validation and forward migration of older schema versions. */
import { ADULT_MODES, BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, CHANNEL_LIST_LIMITS, MEDIA_LIST_LIMITS, parseAvatar, PROFILE_IMAGE, UNLOCK_MINUTES, type BackupFile } from '@anycast/shared';
import { z } from 'zod';

export class BackupError extends Error {
  constructor(
    readonly code: 'bad_backup' | 'backup_version',
    message: string,
  ) {
    super(message);
  }
}

const id = z.string().min(1).max(200);
const time = z.number().int().nonnegative().max(8.64e15);
const argon2 = z.string().max(500).regex(/^\$argon2(id|i|d)\$/, 'not an argon2 hash');
const many = <T extends z.ZodTypeAny>(t: T, max: number) => z.array(t).max(max);
const text = z.string().max(200);

const Profile = z
  .object({
    id,
    name: z.string().min(1).max(200),
    createdAt: time,
    preferences: z.record(z.unknown()).nullable(),
    hideRules: z
      .object({ countries: many(text, 1000), languages: many(text, 1000), categoryIds: many(text, 100_000) })
      .strict()
      .nullable(),
    parental: z
      .object({
        mode: z.enum(ADULT_MODES as [string, ...string[]]),
        unlockMinutes: z.number().int().refine((n) => (UNLOCK_MINUTES as readonly number[]).includes(n), 'not a valid unlock duration'),
        pinHash: argon2.nullable(),
        updatedAt: time,
      })
      .strict()
      .nullable(),
    favorites: many(z.object({ kind: z.enum(['live', 'movie', 'series']), id, addedAt: time }).strict(), 100_000),
    progress: many(
      z
        .object({
          kind: z.enum(['movie', 'episode']),
          id,
          seriesId: id.nullable(),
          position: z.number().nonnegative().finite(),
          duration: z.number().nonnegative().finite(),
          finished: z.boolean(),
          updatedAt: time,
        })
        .strict(),
      500_000,
    ),
    watchHistory: many(
      z
        .object({
          hour: time,
          kind: z.enum(['live', 'movie', 'episode']),
          id,
          seriesId: id.nullable(),
          seconds: z.number().positive().max(3600 * 24).finite(),
        })
        .strict(),
      2_000_000,
    ).optional(),
    trackChoices: many(
      z
        .object({
          kind: z.enum(['movie', 'episode', 'live']),
          id,
          audio: z.number().int().min(0).max(1000).nullable(),
          subtitle: z.number().int().min(-1).max(1000).nullable(),
          updatedAt: time,
        })
        .strict(),
      500_000,
    ),
    lists: many(
      z
        .object({
          id,
          name: z.string().min(1).max(CHANNEL_LIST_LIMITS.name),
          position: z.number().int(),
          createdAt: time,
          channelIds: many(id, CHANNEL_LIST_LIMITS.channels),
        })
        .strict(),
      CHANNEL_LIST_LIMITS.lists,
    ),
    mediaLists: many(
      z
        .object({
          id,
          name: z.string().min(1).max(MEDIA_LIST_LIMITS.name),
          builtin: z.literal('watch-later').nullable(),
          position: z.number().int(),
          createdAt: time,
          items: many(z.object({ kind: z.enum(['movie', 'series']), id, addedAt: time }).strict(), MEDIA_LIST_LIMITS.items),
        })
        .strict(),
      MEDIA_LIST_LIMITS.lists + 1,
    ),
    avatar: z.string().max(40).refine((a) => parseAvatar(a) !== null, 'not a built-in picture').nullable().optional(),
    image: z
      .object({
        type: z.enum(PROFILE_IMAGE.types as unknown as [string, ...string[]]),
        data: z.string().max(Math.ceil(PROFILE_IMAGE.maxBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
        updatedAt: time,
      })
      .strict()
      .nullable()
      .optional(),
    lockHash: argon2.nullable().optional(),
  })
  .strict();

const User = z
  .object({
    id,
    username: z.string().min(1).max(200),
    passwordHash: argon2,
    isAdmin: z.boolean(),
    createdAt: time,
    profiles: many(Profile, 100),
  })
  .strict();

export const BackupSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
    appVersion: z.string().max(50),
    createdAt: time,
    users: many(User, 1000),
    pinnedChannels: many(z.object({ channelId: id, pinnedAt: time }).strict(), 1000),
  })
  .strict()
  .superRefine((b, ctx) => {
    const dup = (what: string, ids: string[]) => {
      const seen = new Set<string>();
      for (const x of ids) {
        if (seen.has(x)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${what} "${x}" appears twice` });
        seen.add(x);
      }
    };
    const profiles = b.users.flatMap((u) => u.profiles);
    dup('user id', b.users.map((u) => u.id));
    dup('username', b.users.map((u) => u.username.toLowerCase()));
    dup('profile id', profiles.map((p) => p.id));
    dup('list id', profiles.flatMap((p) => p.lists.map((l) => l.id)));
    dup('media list id', profiles.flatMap((p) => p.mediaLists.map((l) => l.id)));
  });

/**
 * Forward migrations: MIGRATE[n] turns a schema version n file into version n + 1. Add an entry here
 * (and bump BACKUP_SCHEMA_VERSION) whenever the format changes.
 */
const MIGRATE: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  // 1 -> 2: movie and series lists; older backups have none
  1: (raw) => ({
    ...raw,
    users: Array.isArray(raw.users)
      ? raw.users.map((u: Record<string, unknown>) =>
          u && typeof u === 'object' && Array.isArray(u.profiles)
            ? { ...u, profiles: u.profiles.map((p: Record<string, unknown>) => (p && typeof p === 'object' ? { mediaLists: [], ...p } : p)) }
            : u,
        )
      : raw.users,
  }),
};

/** Validates a parsed backup file, migrating an older schema version forward first. */
export function parseBackup(raw: unknown): BackupFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as { format?: unknown }).format !== BACKUP_FORMAT) {
    throw new BackupError('bad_backup', 'This is not an AnyCast backup file.');
  }
  let doc = raw as Record<string, unknown>;
  let version = doc.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new BackupError('bad_backup', 'This backup file has no valid schema version.');
  }
  if (version > BACKUP_SCHEMA_VERSION) {
    throw new BackupError(
      'backup_version',
      `This backup was made by a newer version of AnyCast (backup format ${version}, this server reads up to ${BACKUP_SCHEMA_VERSION}). Update AnyCast, then restore it.`,
    );
  }
  while (version < BACKUP_SCHEMA_VERSION) {
    const step = MIGRATE[version];
    if (!step) throw new BackupError('backup_version', `Backup format ${version} can no longer be restored.`);
    doc = { ...step(doc), schemaVersion: version + 1 };
    version += 1;
  }
  const parsed = BackupSchema.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length ? ` (at ${issue.path.join('.')})` : '';
    throw new BackupError('bad_backup', `This backup file is damaged or incomplete: ${issue.message}${where}.`);
  }
  return parsed.data as BackupFile;
}

/** For tests: lets a test register a migration from an older version. */
export const __migrations = MIGRATE;
