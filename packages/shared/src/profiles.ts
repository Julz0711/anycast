/**
 * Profiles: who's watching. Every profile shares the account's login and the one Xtream source,
 * and has its own picture, optional profile lock, favorites, progress, settings and filters.
 *
 * Picture: an uploaded image (`image`, a URL) wins over a built-in picture (`avatar`, "shape.color"),
 * and with neither the app shows the name's first letter.
 *
 * Profile lock: a 4–6 digit PIN that is asked for before the profile opens on a device (separate
 * from the parental lock's PIN for adult content). The server enforces it: until this sign-in
 * session has entered the PIN (POST /api/profiles/:id/enter), every request as the profile answers
 * 403 {error:'profile_locked'}. Switching profiles (POST /api/profiles/leave) ends the session's
 * entries, so the PIN is asked again next time.
 */
import type { AccentId } from './settings';

/** Shapes of the built-in pictures (drawn by the web app). */
export const AVATAR_SHAPES = ['ribbon', 'orbit', 'wave', 'peak', 'bloom', 'moon', 'spark', 'stack', 'drop', 'leaf', 'prism', 'ring'] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];
/** Colors of the built-in pictures: the accent palette. */
export const AVATAR_COLORS: readonly AccentId[] = ['amber', 'coral', 'rose', 'orchid', 'violet', 'sky', 'aqua', 'mint', 'lime', 'sand'];

export const avatarId = (shape: AvatarShape, color: AccentId) => `${shape}.${color}`;

export function parseAvatar(id: unknown): { shape: AvatarShape; color: AccentId } | null {
  if (typeof id !== 'string') return null;
  const [shape, color, extra] = id.split('.');
  if (extra !== undefined || !(AVATAR_SHAPES as readonly string[]).includes(shape!) || !AVATAR_COLORS.includes(color as AccentId)) return null;
  return { shape: shape as AvatarShape, color: color as AccentId };
}

/** A picture for a new profile: the n-th profile gets the n-th combination, so neighbours differ. */
export function defaultAvatar(n: number): string {
  const shape = AVATAR_SHAPES[n % AVATAR_SHAPES.length]!;
  const color = AVATAR_COLORS[(n * 3) % AVATAR_COLORS.length]!;
  return avatarId(shape, color);
}

/** Uploaded pictures: the web app crops and scales them to a square before upload. */
export const PROFILE_IMAGE = { maxBytes: 256 * 1024, size: 320, types: ['image/webp', 'image/jpeg', 'image/png'] } as const;
export type ProfileImageType = (typeof PROFILE_IMAGE.types)[number];

export const PROFILE_NAME_MAX = 40;
export const PROFILES_MAX = 12;

export interface Profile {
  id: string;
  name: string;
  /** built-in picture "shape.color"; null: the first letter of the name */
  avatar: string | null;
  /** URL of the uploaded picture (wins over `avatar`); null: none */
  image: string | null;
  /** a profile lock PIN is set */
  locked: boolean;
  /** locked and not yet entered on this sign-in session: the PIN is needed to open it here */
  needsPin: boolean;
}
