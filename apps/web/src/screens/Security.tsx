/**
 * Settings › Security: where this device connects from, signing in a TV with its code, and the
 * devices signed in to this account (a row here, the list in a sheet).
 */
import type { SecurityStatus, SignedInDevice } from '@anycast/shared';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { call, errorMessage } from '../api/client';
import { Skeleton } from '../components/ui';
import { Sheet } from '../components/lists';
import { toast } from '../store/actions';
import { fmtRelativeAgo } from '../lib/time';
import { useAsync } from '../lib/hooks';
import '../theme/security.css';

type RowC = (p: { label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }) => ReactNode;

const METHOD: Record<NonNullable<SignedInDevice['method']>, string> = {
  password: 'signed in with password',
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
      <SignInTv Row={Row} />
      <Devices Row={Row} s={s} reload={st.reload} />
    </div>
  );
}

function Connection({ s }: { s: SecurityStatus }) {
  return (
    <p className="muted sec-here">
      This device is connected {s.here.outside ? 'from the internet' : 'from your home network'} ({s.here.ip}).{' '}
      {s.passwordFromInternet
        ? 'A password signs in from anywhere.'
        : 'A password signs in only at home and over Tailscale. From the internet, a device signs in with a code you approve here.'}
    </p>
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

/** One row in Settings (how many, any from the internet); the list itself opens in a sheet. */
function Devices({ Row, s, reload }: { Row: RowC; s: SecurityStatus; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const n = s.devices.length;
  const outside = s.devices.filter((d) => d.outside).length;
  const hint = `${n} device${n === 1 ? '' : 's'} signed in, this one included${outside ? `, ${outside} from the internet` : ''}. Sign out anything you don't recognize.`;
  return (
    <>
      <Row label="Signed-in devices" hint={hint}>
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Show devices
        </button>
      </Row>
      {open && <DevicesSheet s={s} reload={reload} onClose={() => setOpen(false)} />}
    </>
  );
}

function DevicesSheet({ s, reload, onClose }: { s: SecurityStatus; reload: () => void; onClose: () => void }) {
  const others = s.devices.filter((d) => !d.current).length;
  const signOut = (d: SignedInDevice) =>
    void call('DELETE /api/auth/sessions/:id', { params: { id: d.id } }).then(() => (reload(), toast(`Signed out ${d.label ?? 'that device'}.`)), (e) => toast(errorMessage(e), 'error'));
  const signOutOthers = () =>
    void call('POST /api/auth/sessions/sign-out-others').then((r) => (reload(), toast(`Signed out ${r.removed} device${r.removed === 1 ? '' : 's'}.`)), (e) => toast(errorMessage(e), 'error'));
  return (
    <Sheet title="Signed-in devices" onClose={onClose} className="sec-sheet">
      <ul className="sec-devices" aria-label="Signed-in devices">
        {s.devices.map((d) => (
          <li key={d.id} className="sec-device" data-nav-row={`device-${d.id}`}>
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
      <div className="sec-sheet-foot">
        <span className="muted">{others ? `${others} other device${others === 1 ? '' : 's'}` : 'Only this device is signed in.'}</span>
        <button type="button" className="btn" disabled={!others} onClick={signOutOthers}>
          Sign out all others
        </button>
      </div>
    </Sheet>
  );
}
