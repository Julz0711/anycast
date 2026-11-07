/**
 * Profiles: who's watching. Every profile shares the account's login and the one Xtream source,
 * and has its own picture, optional profile lock, favorites, progress, settings and filters.
 *
 * Picture: an uploaded image (`image`, a URL) wins over a built-in picture (`avatar`, "figure.color"),
 * and with neither the app shows the name's first letter.
 *
 * Profile lock: a 4–6 digit PIN that is asked for before the profile opens on a device (separate
 * from the parental lock's PIN for adult content). The server enforces it: until this sign-in
 * session has entered the PIN (POST /api/profiles/:id/enter), every request as the profile answers
 * 403 {error:'profile_locked'}. Switching profiles (POST /api/profiles/leave) ends the session's
 * entries, so the PIN is asked again next time.
 */
import type { AccentId } from './settings';

/**
 * Characters of the built-in pictures (drawn by the web app), each in any accent color.
 * Ids are "figure.color", e.g. "fox.amber".
 */
export const AVATAR_FIGURES = [
  'fox', 'owl', 'telly', 'cat', 'robot', 'ghost', 'frog', 'alien',
  'bear', 'astro', 'popcorn', 'octo', 'shroom', 'cyclops', 'penguin', 'dino',
] as const;
export type AvatarFigure = (typeof AVATAR_FIGURES)[number];
/**
 * The abstract shapes of the first picture set. Profiles saved with one of them keep working: each
 * is shown as the character it maps to here, in the same color.
 */
export const LEGACY_AVATAR_SHAPES: Readonly<Record<string, AvatarFigure>> = {
  ribbon: 'fox', orbit: 'alien', wave: 'octo', peak: 'dino', bloom: 'shroom', moon: 'owl',
  spark: 'astro', stack: 'robot', drop: 'ghost', leaf: 'frog', prism: 'cat', ring: 'cyclops',
};
/** Colors of the built-in pictures: the accent palette. */
export const AVATAR_COLORS: readonly AccentId[] = ['amber', 'coral', 'rose', 'orchid', 'violet', 'sky', 'aqua', 'mint', 'lime', 'sand'];

export const avatarId = (figure: AvatarFigure, color: AccentId) => `${figure}.${color}`;

/** A built-in picture id (current or legacy) as its character and color; null when unknown. */
export function parseAvatar(id: unknown): { figure: AvatarFigure; color: AccentId } | null {
  if (typeof id !== 'string') return null;
  const [name, color, extra] = id.split('.');
  if (extra !== undefined || !AVATAR_COLORS.includes(color as AccentId)) return null;
  const figure = (AVATAR_FIGURES as readonly string[]).includes(name!)
    ? (name as AvatarFigure)
    : Object.hasOwn(LEGACY_AVATAR_SHAPES, name!) ? LEGACY_AVATAR_SHAPES[name!]! : null;
  return figure ? { figure, color: color as AccentId } : null;
}

/** A picture for a new profile: the n-th profile gets the n-th combination, so neighbours differ. */
export function defaultAvatar(n: number): string {
  const figure = AVATAR_FIGURES[n % AVATAR_FIGURES.length]!;
  const color = AVATAR_COLORS[(n * 3) % AVATAR_COLORS.length]!;
  return avatarId(figure, color);
}

/** Uploaded pictures: the web app crops and scales them to a square before upload. */
export const PROFILE_IMAGE = { maxBytes: 256 * 1024, size: 320, types: ['image/webp', 'image/jpeg', 'image/png'] } as const;
export type ProfileImageType = (typeof PROFILE_IMAGE.types)[number];

export const PROFILE_NAME_MAX = 40;
export const PROFILES_MAX = 12;

export interface Profile {
  id: string;
  name: string;
  /** built-in picture "figure.color" (older "shape.color" ids still work); null: the first letter of the name */
  avatar: string | null;
  /** URL of the uploaded picture (wins over `avatar`); null: none */
  image: string | null;
  /** a profile lock PIN is set */
  locked: boolean;
  /** locked and not yet entered on this sign-in session: the PIN is needed to open it here */
  needsPin: boolean;
}
