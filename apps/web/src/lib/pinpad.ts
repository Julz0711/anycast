/** PIN pad logic (pure): entry state, key mapping, error text. The dialog is components/PinDialog.tsx. */
import { PIN_MAX, PIN_MIN, type PinError } from '@anycast/shared';

export interface PadState {
  digits: string;
  /** bumps on every wrong PIN so the dots can shake again */
  shake: number;
}

export type PadAction =
  | { type: 'digit'; digit: string }
  | { type: 'back' }
  | { type: 'clear' }
  | { type: 'wrong' };

export const EMPTY_PAD: PadState = { digits: '', shake: 0 };

export function padReducer(s: PadState, a: PadAction, max = PIN_MAX): PadState {
  switch (a.type) {
    case 'digit':
      return /^\d$/.test(a.digit) && s.digits.length < max ? { ...s, digits: s.digits + a.digit } : s;
    case 'back':
      return s.digits ? { ...s, digits: s.digits.slice(0, -1) } : s;
    case 'clear':
      return s.digits ? { ...s, digits: '' } : s;
    case 'wrong':
      return { digits: '', shake: s.shake + 1 };
  }
}

export const canSubmit = (digits: string, min = PIN_MIN, max = PIN_MAX) => digits.length >= min && digits.length <= max && /^\d+$/.test(digits);

export type PadKey = PadAction | { type: 'submit' } | { type: 'cancel' };

/**
 * A keyboard or remote key -> pad action. Digits come from the top row, the numpad and TV remotes
 * (which send the same keys); arrows are left to D-pad navigation between the pad's buttons.
 */
export function keyToPad(e: { key: string; code?: string }): PadKey | null {
  if (/^\d$/.test(e.key)) return { type: 'digit', digit: e.key };
  const numpad = /^Numpad(\d)$/.exec(e.code ?? '');
  if (numpad) return { type: 'digit', digit: numpad[1]! };
  switch (e.key) {
    case 'Backspace':
    case 'Delete':
      return { type: 'back' };
    case 'Escape':
    case 'GoBack':
    case 'BrowserBack':
      return { type: 'cancel' };
    case 'Enter':
      return { type: 'submit' };
    default:
      return null;
  }
}

/** "4 min 05 s" / "35 s" until `until`. */
export function fmtWait(until: number, now: number): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** The line under the dots for a PIN error (null: nothing to say). */
export function pinErrorText(err: Partial<PinError> | null, now: number): string | null {
  if (!err) return null;
  if (err.lockedOutUntil && err.lockedOutUntil > now) return `Too many wrong attempts. Try again in ${fmtWait(err.lockedOutUntil, now)}.`;
  if (err.error === 'wrong_pin' || err.error === 'wrong_password') {
    const left = err.attemptsLeft ?? 0;
    return `${err.error === 'wrong_pin' ? 'Wrong PIN' : 'Wrong password'}. ${left} attempt${left === 1 ? '' : 's'} left.`;
  }
  return err.message ?? null;
}
