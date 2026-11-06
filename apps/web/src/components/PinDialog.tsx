/**
 * PIN pad dialog: numeric keys for touch, digits / Backspace / Enter / Escape on a keyboard, and
 * D-pad navigation between the keys on TV (the dialog traps spatial navigation). Masked dots shake
 * on a wrong PIN; the line under them says how many attempts are left or how long the lockout lasts.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { PIN_MAX, PIN_MIN, type PinError } from '@anycast/shared';
import { ApiError, errorMessage } from '../api/client';
import { canSubmit, EMPTY_PAD, keyToPad, padReducer, pinErrorText } from '../lib/pinpad';
import { closePrompt, useParental, type PinPrompt } from '../store/parental';
import { useNow } from '../lib/hooks';
import { IconBackspace, IconClose, IconLock } from './Icons';
import '../theme/parental.css';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export default function PinDialog({ prompt }: { prompt: PinPrompt }) {
  const [pad, dispatch] = useReducer(padReducer, EMPTY_PAD);
  const status = useParental((s) => s.status);
  const [err, setErr] = useState<Partial<PinError> | null>(() =>
    prompt.checksPin !== false && status?.lockedOutUntil ? { error: 'pin_locked_out', lockedOutUntil: status.lockedOutUntil, attemptsLeft: 0 } : null,
  );
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);
  const lockedOut = !!err?.lockedOutUntil && err.lockedOutUntil > now;
  const first = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const digitsRef = useRef(pad.digits);
  digitsRef.current = pad.digits;

  const submit = async () => {
    const pin = digitsRef.current;
    if (busy || lockedOut || !canSubmit(pin)) return;
    setBusy(true);
    try {
      await prompt.submit(pin);
      closePrompt(true);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as Partial<PinError> | undefined) : undefined;
      if (body?.error) {
        setErr(body);
        dispatch({ type: 'wrong' });
      } else {
        setErr({ message: errorMessage(e) });
        dispatch({ type: 'clear' });
      }
    } finally {
      setBusy(false);
    }
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    // TV: focus the 1 key so the D-pad works at once; elsewhere the dialog, so Enter submits
    const tv = document.documentElement.dataset.form === 'tv';
    (tv ? first.current : box.current)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const k = keyToPad(e);
      if (!k) return;
      // TV: OK on a focused key presses that key (D-pad); elsewhere Enter submits, and Escape and the close button cancel
      if (k.type === 'submit' && (document.documentElement.dataset.form === 'tv' || (e.target as Element).closest?.('.pin-close')) && e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      e.stopPropagation();
      if (k.type === 'cancel') closePrompt(false);
      else if (k.type === 'submit') void submitRef.current();
      else dispatch(k);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const slots = Math.max(PIN_MIN, Math.min(PIN_MAX, pad.digits.length + (pad.digits.length < PIN_MAX ? 1 : 0)));
  const message = pinErrorText(err, now);
  const ready = canSubmit(pad.digits) && !busy && !lockedOut;
  return (
    <div className="sheet-backdrop pin-backdrop" onClick={() => closePrompt(false)}>
      <div ref={box} tabIndex={-1} className="pin-dialog" role="dialog" aria-modal="true" aria-labelledby="pin-title" data-nav-trap="" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="icon-btn pin-close" onClick={() => closePrompt(false)} aria-label="Cancel">
          <IconClose />
        </button>
        <div className="pin-lock" aria-hidden="true">
          <IconLock />
        </div>
        <h2 id="pin-title" className="pin-title">
          {prompt.title}
        </h2>
        {prompt.subtitle && <p className="pin-sub">{prompt.subtitle}</p>}
        <div
          key={pad.shake}
          className={`pin-dots${pad.shake ? ' shake' : ''}`}
          role="img"
          aria-label={`${pad.digits.length} of ${PIN_MIN} to ${PIN_MAX} digits entered`}
          data-testid="pin-dots"
        >
          {Array.from({ length: slots }, (_, i) => (
            <i key={i} className={i < pad.digits.length ? 'on' : undefined} />
          ))}
        </div>
        <p className={`pin-msg${message ? ' err' : ''}`} role="status" aria-live="polite">
          {message ?? `${PIN_MIN} to ${PIN_MAX} digits`}
        </p>
        <div className="pin-pad" data-nav-row="pin-pad" aria-disabled={lockedOut || undefined}>
          {KEYS.map((d, i) => (
            <button key={d} ref={i === 0 ? first : undefined} type="button" className="pin-key" disabled={lockedOut} onClick={() => dispatch({ type: 'digit', digit: d })}>
              {d}
            </button>
          ))}
          <button type="button" className="pin-key pin-key--fn" aria-label="Delete digit" disabled={lockedOut || !pad.digits} onClick={() => dispatch({ type: 'back' })}>
            <IconBackspace />
          </button>
          <button type="button" className="pin-key" disabled={lockedOut} onClick={() => dispatch({ type: 'digit', digit: '0' })}>
            0
          </button>
          <button type="button" className="pin-key pin-key--ok" disabled={!ready} aria-busy={busy || undefined} onClick={() => void submit()}>
            {prompt.submitLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
