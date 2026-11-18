/**
 * Settings › Security: two-step sign-in (authenticator app, recovery codes, remembered devices),
 * signing in a TV with its code, and the devices signed in to this account.
 */
import type { SecurityStatus, SignedInDevice } from '@anycast/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { call, errorMessage } from '../api/client';
import { Qr } from '../components/Qr';
import { Skeleton } from '../components/ui';
import { toast } from '../store/actions';
import { fmtRelativeAgo } from '../lib/time';
import { useAsync } from '../lib/hooks';
import '../theme/security.css';

type RowC = (p: { label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }) => ReactNode;

const METHOD: Record<NonNullable<SignedInDevice['method']>, string> = {
  password: 'signed in with password',
  two_factor: 'signed in with password and code',
  trusted: 'signed in with password (remembered device)',
  approved: 'approved from another device',
};

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

export function SecuritySection(props: { Row: RowC }) {
  const { Row } = props;
  const st = useAsync(() => call('GET /api/auth/security'), []);
  const s = st.data;
  if (!s && st.error) return <p className="notice error">Couldn't read the security settings: {errorMessage(st.error)}</p>;
  if (!s) return <Skeleton h="12rem" />;
  return (
    <div data-testid="security">
      <Connection s={s} />
      <TwoFactorRow Row={Row} s={s} reload={st.reload} />
      <SignInTv Row={Row} />
      <Devices Row={Row} s={s} reload={st.reload} />
    </div>
  );
}

function Connection({ s }: { s: SecurityStatus }) {
  const off = !s.twoFactor.enabled;
  return (
    <>
      <p className="muted sec-here">
        This device is connected {s.here.outside ? 'from the internet' : 'from your home network'} ({s.here.ip}).
      </p>
      {off && s.outsideNeedsTwoFactor && (
        <p className="notice sec-warn" role="note">
          Signing in from the internet only works with two-step sign-in. Turn it on below before you open AnyCast to the internet; until then, only your home
          network and Tailscale can sign in.
        </p>
      )}
    </>
  );
}

/* ---------------- two-step sign-in ---------------- */

function TwoFactorRow({ Row, s, reload }: { Row: RowC; s: SecurityStatus; reload: () => void }) {
  const [mode, setMode] = useState<null | 'setup' | 'disable' | 'codes'>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const tf = s.twoFactor;

  if (codes) return <RecoveryCodes codes={codes} onDone={() => (setCodes(null), setMode(null), reload())} />;

  return (
    <>
      <Row
        label="Two-step sign-in"
        hint={
          tf.enabled
            ? `On since ${fmtDate(tf.enabledAt!)}. Signing in asks for a code from your authenticator app. ${tf.recoveryCodesLeft} recovery code${tf.recoveryCodesLeft === 1 ? '' : 's'} left.`
            : 'Off. Turn it on to sign in with your password and a code from an authenticator app (Google Authenticator, 1Password, Authy, …).'
        }
      >
        {tf.enabled ? (
          <>
            <button type="button" className="btn" onClick={() => setMode(mode === 'codes' ? null : 'codes')} aria-expanded={mode === 'codes'}>
              New recovery codes
            </button>
            <button type="button" className="btn btn-danger" onClick={() => setMode(mode === 'disable' ? null : 'disable')} aria-expanded={mode === 'disable'}>
              Turn off
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => setMode(mode === 'setup' ? null : 'setup')} aria-expanded={mode === 'setup'} data-testid="2fa-setup">
            Set up
          </button>
        )}
      </Row>
      {mode === 'setup' && <Setup onEnabled={setCodes} onCancel={() => setMode(null)} />}
      {mode === 'codes' && <NewCodes onDone={setCodes} onCancel={() => setMode(null)} />}
      {mode === 'disable' && <Disable onDone={() => (setMode(null), reload(), toast('Two-step sign-in is off.'))} onCancel={() => setMode(null)} />}
      {tf.enabled && (
        <Row label="Remembered devices" hint={s.trustedDevices ? `${s.trustedDevices} browser${s.trustedDevices === 1 ? '' : 's'} skip the code at sign-in.` : 'No browser skips the code.'}>
          <button
            type="button"
            className="btn"
            disabled={!s.trustedDevices}
            onClick={() => void call('DELETE /api/auth/trusted').then(() => (reload(), toast('Every device asks for a code at its next sign-in.')), (e) => toast(errorMessage(e), 'error'))}
          >
            Forget all
          </button>
        </Row>
      )}
    </>
  );
}

function Setup(props: { onEnabled: (codes: string[]) => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSetup(await call('POST /api/auth/2fa/setup', { body: { password } }));
      setPassword('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call('POST /api/auth/2fa/enable', { body: { code } });
      props.onEnabled(r.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!setup) {
    return (
      <form className="sec-panel" onSubmit={start} aria-label="Confirm your password">
        <label className="field">
          Your AnyCast password
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={busy || !password}>
            Continue
          </button>
          <button className="btn btn-quiet" type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <form className="sec-panel sec-setup" onSubmit={enable} aria-label="Set up two-step sign-in">
      <div className="sec-qr">
        <Qr value={setup.uri} size="10rem" label="QR code for your authenticator app" />
      </div>
      <div className="sec-setup-text">
        <ol className="device-steps">
          <li>Open your authenticator app and add an account by scanning this QR code.</li>
          <li>
            On this phone? Tap{' '}
            <a href={setup.uri} className="link">
              open in authenticator
            </a>{' '}
            or type this key: <code className="sec-secret">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code>
          </li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        <label className="field">
          Code
          <input
            className="input code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            maxLength={6}
            value={code}
            onChange={(e) => (setCode(e.target.value.replace(/\D/g, '')), setError(null))}
            required
            autoFocus
            data-testid="2fa-code"
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={busy || code.length !== 6}>
            Turn on
          </button>
          <button className="btn btn-quiet" type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}

function RecoveryCodes(props: { codes: string[]; onDone: () => void }) {
  const text = `AnyCast recovery codes (${location.host}, ${new Date().toLocaleDateString()})\nEach code works once.\n\n${props.codes.join('\n')}\n`;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'anycast-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="sec-panel" role="region" aria-label="Recovery codes" data-testid="recovery-codes">
      <div className="set-label">Save your recovery codes</div>
      <p className="set-hint">
        If you lose your phone, each of these signs you in once instead of a code. They are shown only now. Keep them somewhere safe, like your password manager.
      </p>
      <ol className="sec-codes">
        {props.codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="actions">
        <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(text).then(() => toast('Copied.'), () => toast("Couldn't copy.", 'error'))}>
          Copy
        </button>
        <button type="button" className="btn" onClick={download}>
          Download
        </button>
        <button type="button" className="btn btn-primary" onClick={props.onDone}>
          I saved them
        </button>
      </div>
    </div>
  );
}

function NewCodes(props: { onDone: (codes: string[]) => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      props.onDone((await call('POST /api/auth/2fa/recovery-codes', { body: { code } })).recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <form className="sec-panel" onSubmit={submit} aria-label="New recovery codes">
      <p className="set-hint">Your old recovery codes stop working.</p>
      <label className="field">
        Code from your authenticator app
        <input className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={!code.trim()}>
          Make new codes
        </button>
        <button className="btn btn-quiet" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Disable(props: { onDone: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await call('POST /api/auth/2fa/disable', { body: { password, code } });
      props.onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <form className="sec-panel" onSubmit={submit} aria-label="Turn off two-step sign-in">
      <p className="set-hint">Without it, signing in from the internet stops working (your home network still can).</p>
      <label className="field">
        Your AnyCast password
        <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
      </label>
      <label className="field">
        Code from your authenticator app (or a recovery code)
        <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} required />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn btn-danger" type="submit" disabled={!password || !code.trim()}>
          Turn off
        </button>
        <button className="btn btn-quiet" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ---------------- TVs and signed-in devices ---------------- */

function SignInTv({ Row }: { Row: RowC }) {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  return (
    <Row label="Sign in a TV" hint="On the TV, choose “Sign in with your phone”. Then scan its QR code, or enter the code it shows here.">
      <form className="sec-tv" onSubmit={(e) => (e.preventDefault(), navigate(`/approve?code=${encodeURIComponent(code.trim())}`))}>
        <input
          className="input code-input"
          aria-label="Code shown on the TV"
          placeholder="ABCD-EFGH"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={12}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="btn" disabled={code.replace(/[^A-Za-z0-9]/g, '').length !== 8}>
          Continue
        </button>
      </form>
    </Row>
  );
}

function Devices({ Row, s, reload }: { Row: RowC; s: SecurityStatus; reload: () => void }) {
  const others = s.devices.filter((d) => !d.current).length;
  const signOut = (d: SignedInDevice) =>
    void call('DELETE /api/auth/sessions/:id', { params: { id: d.id } }).then(() => (reload(), toast(`Signed out ${d.label ?? 'that device'}.`)), (e) => toast(errorMessage(e), 'error'));
  const signOutOthers = () =>
    void call('POST /api/auth/sessions/sign-out-others').then((r) => (reload(), toast(`Signed out ${r.removed} device${r.removed === 1 ? '' : 's'}.`)), (e) => toast(errorMessage(e), 'error'));
  return (
    <>
      <Row label="Signed-in devices" hint="Everything signed in to this account. Sign out anything you don't recognize.">
        <button type="button" className="btn" disabled={!others} onClick={signOutOthers}>
          Sign out all others
        </button>
      </Row>
      <ul className="sec-devices" aria-label="Signed-in devices">
        {s.devices.map((d) => (
          <li key={d.id} className="sec-device">
            <div className="sec-device-text">
              <div className="set-label">
                {d.label ?? 'Unknown device'}
                {d.current && <span className="new-badge sec-this">This device</span>}
              </div>
              <div className="set-hint">
                {d.current ? 'Active now' : `Last used ${fmtRelativeAgo(d.lastSeenAt)}`}
                {d.ip ? ` · ${d.outside ? 'internet' : 'home network'} (${d.ip})` : ''}
                {d.method ? ` · ${METHOD[d.method]}` : ''} · since {fmtDate(d.createdAt)}
              </div>
            </div>
            {!d.current && (
              <button type="button" className="btn" onClick={() => signOut(d)}>
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
