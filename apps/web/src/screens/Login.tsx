/**
 * Sign in: username and password, then the code step when the account has two-step sign-in.
 * A TV (or anything without a keyboard) signs in with a code instead: it shows the code and a QR
 * code, a signed-in phone approves it (/approve), and the TV is in. TVs start on that view.
 */
import { DEVICE_POLL_MS, type AuthError, type DeviceCodeStart } from '@anycast/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { login, loginWithCode, onSignedIn } from '../store/actions';
import { ApiError, call, errorMessage } from '../api/client';
import { BrandMark } from '../components/Icons';
import { Qr } from '../components/Qr';
import { isDemo } from '../demo/flag';
import { useFormFactor } from '../lib/hooks';
import '../theme/security.css';

type Step = { kind: 'password' } | { kind: 'code'; challenge: string } | { kind: 'device' };

const authError = (e: unknown): AuthError | undefined => (e instanceof ApiError ? (e.body as AuthError | undefined) : undefined);

function message(e: unknown): string {
  if (!(e instanceof ApiError)) return errorMessage(e);
  const b = authError(e);
  if (e.status === 401 && b?.error === 'invalid_login') return 'Wrong username or password.';
  if (e.status === 429 && !b?.retryAfter) return 'Too many attempts. Wait a minute and try again.';
  return errorMessage(e);
}

export function LoginScreen() {
  const form = useFormFactor();
  // the code (and QR) is the easy way on a TV; elsewhere it's one tap away
  const [step, setStep] = useState<Step>(() => (form === 'tv' && !isDemo() ? { kind: 'device' } : { kind: 'password' }));
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="center-screen">
      <div className={`auth-card${step.kind === 'device' ? ' auth-card-wide' : ''}`}>
        <div className="brand">
          <BrandMark />
          AnyCast
        </div>
        {step.kind === 'password' && <PasswordStep notice={notice} onCode={(challenge) => (setNotice(null), setStep({ kind: 'code', challenge }))} onDevice={() => setStep({ kind: 'device' })} />}
        {step.kind === 'code' && (
          <CodeStep
            challenge={step.challenge}
            onRestart={(why) => (setNotice(why), setStep({ kind: 'password' }))}
          />
        )}
        {step.kind === 'device' && <DeviceStep onPassword={() => setStep({ kind: 'password' })} />}
      </div>
    </div>
  );
}

function PasswordStep(props: { notice: string | null; onCode: (challenge: string) => void; onDevice: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(props.notice);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const challenge = await login(username.trim(), password);
      if (challenge) props.onCode(challenge.challenge);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-step" onSubmit={submit} aria-labelledby="login-title">
      <h1 id="login-title" className="h1" style={{ fontSize: '1.5rem' }}>
        Sign in
      </h1>
      <label className="field">
        Username
        <input className="input" autoComplete="username" autoCapitalize="off" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
      </label>
      <label className="field">
        Password
        <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {!isDemo() && (
        <button className="btn btn-lg" type="button" onClick={props.onDevice} data-testid="login-device">
          Sign in with your phone
        </button>
      )}
      <p className="muted" style={{ fontSize: '0.8125rem' }}>
        {isDemo() ? 'Demo mode: any username, password "demo".' : 'Use the account from your AnyCast server. Your provider login never leaves the server.'}
      </p>
    </form>
  );
}

function CodeStep(props: { challenge: string; onRestart: (why: string) => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginWithCode(props.challenge, code.trim(), remember);
    } catch (err) {
      const b = authError(err);
      if (b?.error === 'challenge_expired') return props.onRestart(b.message);
      setError(message(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  // a full 6-digit code goes off by itself, like most sign-in pages
  const onCode = (v: string) => {
    const digits = recovery ? v : v.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    setError(null);
  };
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!recovery && code.length === 6 && !busy) formRef.current?.requestSubmit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  return (
    <form ref={formRef} className="auth-step" onSubmit={submit} aria-labelledby="code-title" data-testid="login-code">
      <h1 id="code-title" className="h1" style={{ fontSize: '1.5rem' }}>
        Two-step sign-in
      </h1>
      <p className="muted">
        {recovery ? 'Enter one of the recovery codes you saved when you set up two-step sign-in. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      <label className="field">
        {recovery ? 'Recovery code' : 'Code'}
        <input
          key={recovery ? 'r' : 'c'}
          className={`input${recovery ? '' : ' code-input'}`}
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={recovery ? 'abcd-efgh' : '123456'}
          maxLength={recovery ? 20 : 6}
          value={code}
          onChange={(e) => onCode(e.target.value)}
          required
          autoFocus
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>
          Remember this device
          <span className="field-hint">Next time, your password is enough here. Don't use this on a shared computer.</span>
        </span>
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !code.trim()}>
        {busy ? 'Checking…' : 'Continue'}
      </button>
      <button type="button" className="btn btn-quiet" onClick={() => (setRecovery((v) => !v), setCode(''), setError(null))}>
        {recovery ? 'Use the authenticator app instead' : 'Lost your phone? Use a recovery code'}
      </button>
      <button type="button" className="btn btn-quiet" onClick={() => props.onRestart('')}>
        Back
      </button>
    </form>
  );
}

/** The TV side: shows a code, waits for a signed-in device to approve it. */
function DeviceStep(props: { onPassword: () => void }) {
  const [start, setStart] = useState<DeviceCodeStart | null>(null);
  const [state, setState] = useState<'loading' | 'waiting' | 'denied' | 'expired' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState('loading');
    setStart(null);
    (async () => {
      let s: DeviceCodeStart;
      try {
        s = await call('POST /api/auth/device/start');
      } catch (e) {
        if (!stop) (setError(message(e)), setState('error'));
        return;
      }
      if (stop) return;
      setStart(s);
      setState('waiting');
      const poll = async () => {
        if (stop) return;
        try {
          const r = await call('POST /api/auth/device/poll', { body: { pollToken: s.pollToken } });
          if (stop) return;
          if (r.status === 'approved') return onSignedIn(r.me);
          if (r.status === 'denied' || r.status === 'expired') return setState(r.status);
        } catch {
          /* offline for a moment: keep trying until the code expires */
        }
        if (Date.now() > s.expiresAt) return setState('expired');
        timer = setTimeout(() => void poll(), DEVICE_POLL_MS);
      };
      timer = setTimeout(() => void poll(), DEVICE_POLL_MS);
    })();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [round]);

  const link = start ? `${location.origin}/approve?code=${encodeURIComponent(start.code)}` : '';
  const again = (
    <button type="button" className="btn btn-primary btn-lg" onClick={() => setRound((r) => r + 1)} autoFocus>
      Show a new code
    </button>
  );

  return (
    <div className="auth-step device-step" aria-labelledby="device-title" data-testid="login-device-code">
      <h1 id="device-title" className="h1" style={{ fontSize: '1.5rem' }}>
        Sign in with your phone
      </h1>
      {state === 'waiting' && start && (
        <div className="device-code-box">
          <Qr value={link} size="11rem" label="QR code that opens the approval page on your phone" />
          <div className="device-code-text">
            <ol className="device-steps">
              <li>Scan the code with a phone that is signed in to AnyCast.</li>
              <li>
                Or open AnyCast on it and go to <b>Settings › Security › Sign in a TV</b>, then enter:
              </li>
            </ol>
            <div className="device-code" aria-label={`Code ${start.code.split('').join(' ')}`} data-testid="device-code">
              {start.code}
            </div>
            <p className="muted device-wait" role="status">
              <span className="spinner" aria-hidden /> Waiting for your phone…
            </p>
          </div>
        </div>
      )}
      {state === 'loading' && <p className="muted">Getting a code…</p>}
      {state === 'denied' && (
        <>
          <p className="form-error" role="alert">The sign-in was declined on the other device.</p>
          {again}
        </>
      )}
      {state === 'expired' && (
        <>
          <p className="muted" role="status">The code has expired.</p>
          {again}
        </>
      )}
      {state === 'error' && (
        <>
          <p className="form-error" role="alert">{error}</p>
          {again}
        </>
      )}
      <button type="button" className="btn btn-quiet" onClick={props.onPassword} autoFocus={state === 'waiting'}>
        Sign in with a password instead
      </button>
    </div>
  );
}
