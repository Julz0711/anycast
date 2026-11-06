/**
 * Parental lock for adult content (PRD AC-3), per profile.
 *
 * Categories carry `adult` (the server tagger flags XXX / ADULT / 18+). Each profile picks a mode:
 * - hidden (default): adult categories and their items vanish from every list, search, guide and
 *   items-by-id answer; play and detail routes answer 403 AdultLockedError.
 * - locked: adult categories are listed (`Category.locked`), their items appear as placeholders
 *   (`locked: true`, name LOCKED_NAME, no artwork, no plot); play and detail routes answer 403
 *   until this device unlocks with the PIN (POST /api/adult/unlock).
 * - shown: no restriction.
 *
 * The PIN (4–6 digits) is stored as an argon2 hash and never returned. An unlock is per device
 * (an httpOnly session cookie tied to the sign-in session and the profile) and ends when the
 * browser closes, after `unlockMinutes`, or on POST /api/adult/lock.
 */

export type AdultMode = 'hidden' | 'locked' | 'shown';
export const ADULT_MODES: readonly AdultMode[] = ['hidden', 'locked', 'shown'];
export const DEFAULT_ADULT_MODE: AdultMode = 'hidden';

/** How long an unlock lasts, in minutes. */
export const UNLOCK_MINUTES = [5, 15, 30, 60, 120] as const;
export type UnlockMinutes = (typeof UNLOCK_MINUTES)[number];
export const DEFAULT_UNLOCK_MINUTES: UnlockMinutes = 30;

export const PIN_MIN = 4;
export const PIN_MAX = 6;
export const isValidPin = (pin: unknown): pin is string => typeof pin === 'string' && /^\d{4,6}$/.test(pin);

/** Wrong PIN (or password) attempts per profile before a lockout, and the window they count in. */
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_WINDOW_MS = 10 * 60_000;

/** Name shown instead of a locked item's real name. */
export const LOCKED_NAME = 'Locked';

/** How permissive a mode is; moving to a more permissive mode needs the PIN. */
export const ADULT_MODE_RANK: Record<AdultMode, number> = { hidden: 0, locked: 1, shown: 2 };

export interface AdultStatus {
  mode: AdultMode;
  hasPin: boolean;
  unlockMinutes: UnlockMinutes;
  /** this device has unlocked locked content for this profile */
  unlocked: boolean;
  /** epoch ms the unlock ends, when unlocked */
  unlockedUntil: number | null;
  /** wrong PIN attempts left before a lockout */
  attemptsLeft: number;
  /** epoch ms the PIN lockout ends, when locked out */
  lockedOutUntil: number | null;
}

/** 403 from play, detail and art routes for adult items this profile cannot open right now. */
export interface AdultLockedError {
  error: 'adult_locked';
  /** 'locked': unlocking with the PIN opens it; 'hidden': it is not available on this profile */
  mode: AdultMode;
  message: string;
}

/**
 * Errors of the PIN routes:
 * 403 wrong_pin / wrong_password (attemptsLeft counts down), 429 pin_locked_out (lockedOutUntil),
 * 409 pin_required (the change needs the PIN), 409 no_pin (set a PIN first), 400 bad_pin.
 */
export interface PinError {
  error: 'wrong_pin' | 'wrong_password' | 'pin_locked_out' | 'pin_required' | 'no_pin' | 'bad_pin' | 'not_locked';
  message: string;
  attemptsLeft: number;
  lockedOutUntil: number | null;
}
