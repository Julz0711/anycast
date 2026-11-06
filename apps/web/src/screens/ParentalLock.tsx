/**
 * Settings › All › Parental lock: adult content mode, the PIN, how long an unlock lasts, and this
 * device's unlock. Changes that loosen the lock ask for the PIN in the PIN pad dialog.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ADULT_MODE_RANK, UNLOCK_MINUTES, type AdultMode, type AdultStatus, type PinError, type Profile, type UnlockMinutes } from '@anycast/shared';
import { ApiError, call, errorMessage } from '../api/client';
import { useApp } from '../store/app';
import { toast } from '../store/actions';
import { askPin, lockNow, loadAdult, refreshCatalog, requireUnlock, setAdultStatus, useParental } from '../store/parental';
import { fmtClock } from '../lib/time';
import { Segmented, Skeleton } from '../components/ui';
import { IconLock, IconUnlock } from '../components/Icons';
import '../theme/parental.css';

const MODE_HINT: Record<AdultMode, string> = {
  hidden: 'Adult categories and everything in them are hidden everywhere on this profile.',
  locked: 'Adult categories are listed with a lock. Names and artwork stay hidden until the PIN is entered on a device.',
  shown: 'Adult content is shown like everything else.',
};

const pinError = (e: unknown) => (e instanceof ApiError ? (e.body as Partial<PinError> | undefined) : undefined);

export function ParentalLock(props: { Row: (p: { label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }) => ReactNode }) {
  const { Row } = props;
  const status = useParental((s) => s.status);
  const me = useApp((s) => s.me);
  const profileId = useApp((s) => s.profileId);
  const [pwFor, setPwFor] = useState<'first' | 'forgot' | null>(null);
  useEffect(() => void loadAdult(), [profileId]);

  if (!status) {
    return (
      <div style={{ display: 'grid', gap: '0.75rem' }} aria-busy="true">
        <Skeleton h="2.5rem" />
        <Skeleton h="2.5rem" />
      </div>
    );
  }

  const apply = (st: AdultStatus) => {
    const changed = st.mode !== status.mode || st.unlocked !== status.unlocked;
    setAdultStatus(st);
    if (changed) refreshCatalog();
  };

  const setMode = async (mode: AdultMode) => {
    if (mode === status.mode) return;
    const looser = ADULT_MODE_RANK[mode] > ADULT_MODE_RANK[status.mode];
    if (looser && !status.hasPin) {
      toast('Set a PIN first.');
      setPwFor('first');
      return;
    }
    if (!looser) {
      try {
        apply(await call('PUT /api/adult/settings', { body: { mode } }));
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
      return;
    }
    await askPin({
      title: 'Enter PIN',
      subtitle: mode === 'shown' ? 'Show adult content on this profile.' : 'List adult categories with a lock.',
      submitLabel: 'OK',
      submit: async (pin) => apply(await call('PUT /api/adult/settings', { body: { mode, pin } })),
    });
  };

  const setMinutes = async (unlockMinutes: UnlockMinutes) => {
    if (unlockMinutes === status.unlockMinutes) return;
    if (!status.hasPin || status.mode === 'shown') {
      try {
        apply(await call('PUT /api/adult/settings', { body: { unlockMinutes } }));
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
      return;
    }
    await askPin({
      title: 'Enter PIN',
      subtitle: `Unlocks last ${unlockMinutes} minutes.`,
      submit: async (pin) => apply(await call('PUT /api/adult/settings', { body: { unlockMinutes, pin } })),
    });
  };

  /** New PIN twice, then `save` with it. */
  const newPin = async (save: (pin: string) => Promise<void>) => {
    let first = '';
    const got = await askPin({
      title: 'New PIN',
      subtitle: 'Choose 4 to 6 digits.',
      checksPin: false,
      submitLabel: 'Next',
      submit: async (pin) => {
        first = pin;
      },
    });
    if (!got) return false;
    return askPin({
      title: 'Repeat the new PIN',
      checksPin: false,
      submitLabel: 'Save',
      submit: async (pin) => {
        if (pin !== first) throw new ApiError(400, 'The PINs do not match.', { error: 'bad_pin', message: 'The PINs do not match. Try again.' });
        await save(pin);
      },
    });
  };

  const changePin = async () => {
    let current = '';
    const ok = await askPin({
      title: 'Current PIN',
      subtitle: 'Enter the PIN you use now.',
      submitLabel: 'Next',
      submit: async (pin) => {
        await call('PUT /api/adult/settings', { body: { pin } });
        current = pin;
      },
    });
    if (!ok) return;
    if (await newPin(async (pin) => apply(await call('PUT /api/adult/pin', { body: { pin, currentPin: current } })))) toast('PIN changed.');
  };

  return (
    <>
      <Row label="Adult content" hint={MODE_HINT[status.mode]} stack>
        <Segmented
          label="Adult content"
          value={status.mode}
          options={[
            { value: 'hidden', label: 'Hidden' },
            { value: 'locked', label: 'Locked with PIN' },
            { value: 'shown', label: 'Shown' },
          ]}
          onChange={(v) => void setMode(v)}
        />
      </Row>
      <Row label="PIN" hint={status.hasPin ? '4 to 6 digits, for this profile only. Needed to loosen the lock.' : 'No PIN yet. Setting the first PIN needs your account password.'}>
        <div className="parental-actions">
          {status.hasPin ? (
            <>
              <button type="button" className="btn" onClick={() => void changePin()}>
                Change PIN
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setPwFor(pwFor === 'forgot' ? null : 'forgot')} aria-expanded={pwFor === 'forgot'}>
                Forgot PIN
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setPwFor(pwFor ? null : 'first')} aria-expanded={pwFor === 'first'}>
              Set PIN
            </button>
          )}
        </div>
      </Row>
      {pwFor && (
        <PasswordStep
          title={pwFor === 'first' ? 'Your account password, to set the first PIN' : 'Your account password, to set a new PIN'}
          onCancel={() => setPwFor(null)}
          onDone={() => setPwFor(null)}
          newPin={newPin}
          apply={apply}
          username={me?.user.username ?? ''}
        />
      )}
      <Row label="Unlock lasts" hint="An unlock is for one device. It also ends when the app is closed.">
        <Segmented
          label="Unlock lasts"
          value={status.unlockMinutes}
          options={UNLOCK_MINUTES.map((m) => ({ value: m, label: m < 60 ? `${m} min` : `${m / 60} h` }))}
          onChange={(v) => void setMinutes(v)}
        />
      </Row>
      {status.mode === 'locked' && (
        <Row label="This device" hint={status.unlocked && status.unlockedUntil ? `Unlocked until ${fmtClock(status.unlockedUntil)}.` : 'Locked.'}>
          {status.unlocked ? (
            <button type="button" className="btn" onClick={() => void lockNow()}>
              <IconLock /> Lock now
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => void requireUnlock()} disabled={!status.hasPin}>
              <IconUnlock /> Unlock
            </button>
          )}
        </Row>
      )}
      {me?.user.isAdmin && me.profiles.length > 1 && <AdminReset profiles={me.profiles.filter((p) => p.id !== profileId)} />}
    </>
  );
}

function PasswordStep(props: {
  title: string;
  username: string;
  onCancel: () => void;
  onDone: () => void;
  newPin: (save: (pin: string) => Promise<void>) => Promise<boolean>;
  apply: (st: AdultStatus) => void;
}) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setErr(null);
    let refused: string | null = null;
    const ok = await props.newPin(async (pin) => {
      try {
        props.apply(await call('PUT /api/adult/pin', { body: { pin, password } }));
      } catch (e) {
        const b = pinError(e);
        // a wrong password is fixed here, not in the PIN pad
        if (b?.error === 'wrong_password' || b?.error === 'pin_locked_out') refused = b.message ?? errorMessage(e);
        else throw e;
      }
    });
    if (refused) setErr(refused);
    else if (ok) {
      toast('PIN saved.');
      props.onDone();
    }
  };
  return (
    <form
      className="parental-form set-row stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (password) void go();
      }}
    >
      <label className="set-label" htmlFor="parental-pw">
        {props.title}
      </label>
      {/* lets password managers fill the right account */}
      <input type="text" autoComplete="username" value={props.username} readOnly hidden />
      <input id="parental-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      {err && (
        <p className="set-hint" role="alert" style={{ color: '#FFB4A8' }}>
          {err}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!password}>
          Continue
        </button>
        <button type="button" className="btn btn-quiet" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AdminReset(props: { profiles: Profile[] }) {
  const [id, setId] = useState(props.profiles[0]?.id ?? '');
  const reset = async () => {
    const p = props.profiles.find((x) => x.id === id);
    if (!p) return;
    try {
      await call('POST /api/adult/reset', { body: { profileId: p.id } });
      toast(`${p.name}: PIN removed, adult content hidden.`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-label">Reset another profile’s PIN</div>
        <div className="set-hint">Admins only. Removes the PIN and hides adult content on that profile.</div>
      </div>
      <div className="set-ctl parental-actions">
        <select className="input set-select" aria-label="Profile" value={id} onChange={(e) => setId(e.target.value)}>
          {props.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={() => void reset()}>
          Reset PIN
        </button>
      </div>
    </div>
  );
}
