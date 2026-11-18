/**
 * /approve?code=…: a signed-in phone lets a TV sign in. Opened by scanning the TV's QR code, or from
 * Settings › Security › Sign in a TV. Shows what is asking (device, home network or internet) so a
 * code someone else sent can be spotted.
 */
import { normalizeDeviceCode, type DeviceCodeInfo } from '@anycast/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { call, errorMessage } from '../api/client';
import { BrandMark } from '../components/Icons';
import { fmtRelativeAgo } from '../lib/time';
import { useAsync } from '../lib/hooks';
import '../theme/security.css';

export default function ApproveScreen() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const code = params.get('code') ? normalizeDeviceCode(params.get('code')!) : null;
  const info = useAsync(() => (code ? call('GET /api/auth/device/:code', { params: { code } }) : Promise.resolve(null)), [code]);
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/approve?code=${encodeURIComponent(normalizeDeviceCode(typed))}`, { replace: true });
  };

  const act = async (what: 'approve' | 'deny', i: DeviceCodeInfo) => {
    setBusy(true);
    setError(null);
    try {
      await call(what === 'approve' ? 'POST /api/auth/device/:code/approve' : 'POST /api/auth/device/:code/deny', { params: { code: i.code } });
      setDone(what === 'approve' ? 'approved' : 'denied');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const close = (
    <button type="button" className="btn btn-lg" onClick={() => navigate('/', { replace: true })}>
      Done
    </button>
  );

  return (
    <div className="center-screen">
      <div className="auth-card" data-testid="approve">
        <div className="brand">
          <BrandMark />
          AnyCast
        </div>
        <h1 className="h1" style={{ fontSize: '1.5rem' }}>
          Sign in a TV
        </h1>
        {done === 'approved' ? (
          <>
            <p role="status">Done. The TV signs in within a few seconds.</p>
            {close}
          </>
        ) : done === 'denied' ? (
          <>
            <p role="status">Declined. That device is not signed in.</p>
            {close}
          </>
        ) : !code || info.error ? (
          <form className="auth-step" onSubmit={lookup}>
            {!!info.error && (
              <p className="form-error" role="alert">
                {errorMessage(info.error)}
              </p>
            )}
            <label className="field">
              Code shown on the TV
              <input
                className="input code-input"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder="ABCD-EFGH"
                maxLength={12}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                required
                autoFocus
              />
            </label>
            <button className="btn btn-primary btn-lg" type="submit" disabled={normalizeDeviceCode(typed).length !== 9}>
              Continue
            </button>
            {close}
          </form>
        ) : !info.data ? (
          <p className="muted">Looking up the code…</p>
        ) : (
          <>
            <div className="approve-card">
              <div className="approve-code">{info.data.code}</div>
              <dl className="approve-facts">
                <dt>Device</dt>
                <dd>{info.data.label ?? 'Unknown device'}</dd>
                <dt>Where</dt>
                <dd className={info.data.outside ? 'warn' : undefined}>
                  {info.data.outside ? `From the internet (${info.data.ip})` : `Your home network (${info.data.ip})`}
                </dd>
                <dt>Asked</dt>
                <dd>{fmtRelativeAgo(info.data.createdAt)}</dd>
              </dl>
            </div>
            <p className="muted" style={{ fontSize: '0.875rem' }}>
              Only continue if this code is on a screen in front of you. Approving signs that device in to your account.
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn-primary btn-lg" type="button" disabled={busy} onClick={() => void act('approve', info.data!)} data-testid="approve-yes">
              Sign it in
            </button>
            <button className="btn btn-lg" type="button" disabled={busy} onClick={() => void act('deny', info.data!)}>
              Decline
            </button>
          </>
        )}
      </div>
    </div>
  );
}
