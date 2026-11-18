/**
 * Sign in: username and password at home (or over Tailscale). From the internet, and on a TV, a
 * device signs in with a code instead: it shows the code and a QR code, a signed-in phone approves
 * it (/approve), and the device is in. TVs start on that view; a password tried from the internet
 * switches to it.
 */
import { DEVICE_POLL_MS, type AuthError, type DeviceCodeStart } from '@anycast/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { login, onSignedIn } from '../store/actions';
import { ApiError, call, errorMessage } from '../api/client';
import { BrandMark } from '../components/Icons';
import { Qr } from '../components/Qr';
import { isDemo } from '../demo/flag';
import { useFormFactor } from '../lib/hooks';
import '../theme/security.css';

type Step = { kind: 'password' } | { kind: 'device' };

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
        {step.kind === 'password' && <PasswordStep onDevice={(why) => (setNotice(why ?? null), setStep({ kind: 'device' }))} />}
        {step.kind === 'device' && <DeviceStep notice={notice} onPassword={() => (setNotice(null), setStep({ kind: 'password' }))} />}
      </div>
    </div>
  );
}

function PasswordStep(props: { onDevice: (why?: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      // from the internet a password doesn't sign in: show the code to approve on the phone
      if (authError(err)?.error === 'outside_needs_approval') return props.onDevice(authError(err)!.message);
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
        <button className="btn btn-lg" type="button" onClick={() => props.onDevice()} data-testid="login-device">
          Sign in with your phone
        </button>
      )}
      <p className="muted" style={{ fontSize: '0.8125rem' }}>
        {isDemo() ? 'Demo mode: any username, password "demo".' : 'Use the account from your AnyCast server. Your provider login never leaves the server.'}
      </p>
    </form>
  );
}

/** The TV side: shows a code, waits for a signed-in device to approve it. */
function DeviceStep(props: { notice: string | null; onPassword: () => void }) {
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
      {props.notice && <p className="muted" role="status">{props.notice}</p>}
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
