import { describe, expect, it } from 'vitest';
import { canSubmit, EMPTY_PAD, fmtWait, keyToPad, padReducer, pinErrorText, type PadAction } from './pinpad';

const run = (...actions: PadAction[]) => actions.reduce((s, a) => padReducer(s, a), EMPTY_PAD);
const digits = (s: string): PadAction[] => [...s].map((digit) => ({ type: 'digit', digit }));

describe('pin pad', () => {
  it('collects up to six digits and ignores anything else', () => {
    expect(run(...digits('12')).digits).toBe('12');
    expect(run(...digits('1234567')).digits).toBe('123456');
    expect(run({ type: 'digit', digit: 'a' }, { type: 'digit', digit: '12' }).digits).toBe('');
  });

  it('backspace and clear', () => {
    expect(run(...digits('123'), { type: 'back' }).digits).toBe('12');
    expect(run({ type: 'back' })).toBe(EMPTY_PAD);
    expect(run(...digits('123'), { type: 'clear' }).digits).toBe('');
  });

  it('a wrong PIN clears the entry and shakes again each time', () => {
    const once = run(...digits('1111'), { type: 'wrong' });
    expect(once).toEqual({ digits: '', shake: 1 });
    expect(padReducer(once, { type: 'wrong' }).shake).toBe(2);
  });

  it('can submit 4 to 6 digits', () => {
    expect(canSubmit('123')).toBe(false);
    expect(canSubmit('1234')).toBe(true);
    expect(canSubmit('123456')).toBe(true);
    expect(canSubmit('1234567')).toBe(false);
  });

  it('maps keyboard, numpad and remote keys', () => {
    expect(keyToPad({ key: '7' })).toEqual({ type: 'digit', digit: '7' });
    expect(keyToPad({ key: 'End', code: 'Numpad1' })).toEqual({ type: 'digit', digit: '1' });
    expect(keyToPad({ key: 'Backspace' })).toEqual({ type: 'back' });
    expect(keyToPad({ key: 'Enter' })).toEqual({ type: 'submit' });
    expect(keyToPad({ key: 'Escape' })).toEqual({ type: 'cancel' });
    expect(keyToPad({ key: 'GoBack' })).toEqual({ type: 'cancel' });
    // arrows stay with D-pad navigation
    expect(keyToPad({ key: 'ArrowLeft' })).toBeNull();
  });

  it('says how many attempts are left, or how long the lockout lasts', () => {
    const now = 1_000_000;
    expect(pinErrorText({ error: 'wrong_pin', attemptsLeft: 3 }, now)).toBe('Wrong PIN. 3 attempts left.');
    expect(pinErrorText({ error: 'wrong_pin', attemptsLeft: 1 }, now)).toBe('Wrong PIN. 1 attempt left.');
    expect(pinErrorText({ error: 'pin_locked_out', attemptsLeft: 0, lockedOutUntil: now + 245_000 }, now)).toBe('Too many wrong attempts. Try again in 4 min 05 s.');
    // a lockout that ended says nothing stale
    expect(pinErrorText({ error: 'pin_locked_out', lockedOutUntil: now - 1, message: 'm' }, now)).toBe('m');
    expect(pinErrorText(null, now)).toBeNull();
    expect(fmtWait(now + 35_000, now)).toBe('35 s');
  });
});
