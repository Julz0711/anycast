/**
 * A profile's own page (/profiles/:id, /profiles/new): name and picture, the profile lock, the
 * profile's main settings (when it is the one in use), and delete. Opens without a profile in use
 * (from Manage profiles on the picker); a locked profile asks for its PIN first.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ACCENTS, ALL_TABS, defaultAvatar, PROFILE_NAME_MAX, type AccentId, type Profile, type TabId } from '@anycast/shared';
import { useApp } from '../store/app';
import { patchPrefs, setPref, toast } from '../store/actions';
import { ApiError, call, errorMessage } from '../api/client';
import { askPin } from '../store/parental';
import { TABS } from '../layout/tabs';
import { Segmented, Toggle } from '../components/ui';
import { IconBack, IconLock, IconPencil } from '../components/Icons';
import { ProfileAvatar } from './Avatar';
import { PictureChooser, type PictureValue } from './PictureChooser';
import { createProfile, deleteProfile, enterWithPin, setLock, switchProfile, updateProfile, uploadImage } from './actions';
import '../theme/profiles.css';
import '../theme/settings.css';

export default function ProfilePage() {
  const { id = 'new' } = useParams();
  const me = useApp((s) => s.me);
  const navigate = useNavigate();
  const isNew = id === 'new';
  const profile = me?.profiles.find((p) => p.id === id);
  const [gate, setGate] = useState<'checking' | 'open' | 'refused'>('checking');

  useEffect(() => {
    if (isNew || !profile) return setGate('open');
    if (!profile.needsPin) return setGate('open');
    let alive = true;
    void enterWithPin(profile, 'Enter the PIN to edit this profile.').then((ok) => alive && setGate(ok ? 'open' : 'refused'));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, !!profile]);

  const back = () => (history.state?.idx > 0 ? navigate(-1) : navigate('/profiles'));
  useEffect(() => {
    if (gate === 'refused') back();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate]);

  if (!me) return null;
  if (!isNew && !profile) {
    return (
      <div className="pp">
        <PageHead title="Profile" onBack={back} />
        <p className="muted pp-body">This profile no longer exists.</p>
      </div>
    );
  }
  if (gate !== 'open') return <div className="pp" aria-busy="true" />;
  return <Editor key={id} profile={profile ?? null} onBack={back} />;
}

function PageHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="pp-head">
      <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
        <IconBack />
      </button>
      <h1 className="h1">{title}</h1>
    </header>
  );
}

function Editor({ profile, onBack }: { profile: Profile | null; onBack: () => void }) {
  const me = useApp((s) => s.me)!;
  const current = useApp((s) => s.profileId);
  const navigate = useNavigate();
  const [name, setName] = useState(profile?.name ?? '');
  const [pic, setPic] = useState<PictureValue>({ avatar: profile?.avatar ?? defaultAvatar(me.profiles.length), image: profile?.image ?? null });
  const [blob, setBlob] = useState<Blob | null>(null);
  const [choosing, setChoosing] = useState(!profile);
  const [saving, setSaving] = useState(false);
  const objectUrl = useRef<string | null>(null);
  useEffect(() => () => void (objectUrl.current && URL.revokeObjectURL(objectUrl.current)), []);

  const shown = { id: profile?.id ?? 'new', name: name || '?', avatar: pic.avatar, image: pic.image };
  const dirty = !profile || name.trim() !== profile.name || blob !== null || pic.avatar !== profile.avatar || pic.image !== profile.image;
  const valid = name.trim().length > 0;

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      let p: Profile;
      if (!profile) {
        p = await createProfile(name.trim(), pic.avatar);
      } else {
        const patch: { name?: string; avatar?: string | null } = {};
        if (name.trim() !== profile.name) patch.name = name.trim();
        // a built-in picture replaces an upload; keeping the upload keeps the avatar as it is
        if (!blob && !pic.image && (pic.avatar !== profile.avatar || profile.image)) patch.avatar = pic.avatar;
        p = Object.keys(patch).length ? await updateProfile(profile.id, patch) : profile;
      }
      if (blob) p = await uploadImage(p.id, blob);
      setBlob(null);
      toast(profile ? 'Profile saved.' : `${p.name} added.`);
      if (!profile) navigate('/profiles', { replace: true });
      else setChoosing(false);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pp">
      <PageHead title={profile ? 'Edit profile' : 'Add profile'} onBack={onBack} />
      <div className="pp-body">
        <section className="pp-hero">
          <button type="button" className="pp-pic" onClick={() => setChoosing((v) => !v)} aria-expanded={choosing} aria-label="Change picture">
            <ProfileAvatar profile={shown} size="xl" />
            <span className="who-edit" aria-hidden="true">
              <IconPencil />
            </span>
          </button>
          <div className="pp-name">
            <label className="label" htmlFor="pp-name">
              Name
            </label>
            <input
              id="pp-name"
              className="input pp-name-input"
              value={name}
              maxLength={PROFILE_NAME_MAX}
              placeholder="Name"
              autoFocus={!profile}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
            {profile?.id === current && <span className="pp-badge">Watching now</span>}
          </div>
        </section>

        {choosing && (
          <section className="pp-section" aria-label="Picture">
            <h2 className="label">Picture</h2>
            <PictureChooser
              value={pic}
              onAvatar={(avatar) => {
                setBlob(null);
                setPic({ avatar, image: null });
              }}
              onImage={(b, url) => {
                if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
                objectUrl.current = url;
                setBlob(b);
                setPic((v) => ({ ...v, image: url }));
              }}
            />
          </section>
        )}

        <div className="pp-save">
          <button type="button" className="btn btn-primary btn-lg" disabled={!valid || !dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : profile ? 'Save' : 'Add profile'}
          </button>
          {profile && profile.id !== current && (
            <button
              type="button"
              className="btn btn-lg"
              onClick={() => void switchProfile(profile).then((ok) => ok && navigate('/', { replace: true }))}
            >
              Watch as {profile.name}
            </button>
          )}
        </div>

        {profile && <LockSection profile={profile} />}
        {profile && profile.id === current && <PrefsSection />}
        {profile && profile.id !== current && (
          <section className="pp-section">
            <h2 className="label">Settings</h2>
            <p className="muted">Colors, start tab, filters and the parental lock are set inside the profile. Switch to {profile.name} to change them.</p>
          </section>
        )}
        {profile && me.profiles.length > 1 && <DeleteSection profile={profile} />}
      </div>
    </div>
  );
}

/* ---------------- profile lock ---------------- */

const mismatch = () => new ApiError(400, 'The PINs do not match.', { error: 'bad_pin', message: 'The PINs do not match. Try again.' });

function LockSection({ profile }: { profile: Profile }) {
  const [forgot, setForgot] = useState(false);
  const [password, setPassword] = useState('');

  /** New PIN twice, then saves it with `extra` (the current PIN or password). */
  const newPin = async (extra: { currentPin?: string; password?: string }) => {
    let first = '';
    if (!(await askPin({ title: 'New profile PIN', subtitle: 'Choose 4 to 6 digits.', checksPin: false, submitLabel: 'Next', submit: async (pin) => void (first = pin) }))) return false;
    return askPin({
      title: 'Repeat the PIN',
      checksPin: false,
      submitLabel: 'Save',
      submit: async (pin) => {
        if (pin !== first) throw mismatch();
        await setLock(profile.id, { pin, ...extra });
      },
    });
  };

  /** Asks for the current PIN (checked by the server); null when cancelled. */
  const currentPin = async (title: string): Promise<string | null> => {
    let got: string | null = null;
    const ok = await askPin({
      title,
      subtitle: `Enter ${profile.name}'s current PIN.`,
      checksPin: false,
      submitLabel: 'Next',
      submit: async (pin) => {
        await enterCheck(profile.id, pin);
        got = pin;
      },
    });
    return ok ? got : null;
  };

  const set = async () => {
    if (await newPin({})) toast(`${profile.name} is locked. Other devices need the PIN to open it.`);
  };
  const change = async () => {
    const cur = await currentPin('Change PIN');
    if (cur && (await newPin({ currentPin: cur }))) toast('PIN changed.');
  };
  const remove = async () => {
    const cur = await currentPin('Remove profile lock');
    if (!cur) return;
    try {
      await setLock(profile.id, { pin: null, currentPin: cur });
      toast('Profile lock removed.');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const removeWithPassword = async () => {
    try {
      await setLock(profile.id, { pin: null, password });
      setForgot(false);
      setPassword('');
      toast('Profile lock removed.');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <section className="pp-section">
      <h2 className="label">Profile lock</h2>
      <div className="set-row">
        <div className="set-text">
          <div className="set-label">
            {profile.locked ? (
              <>
                <IconLock className="ico pp-lock-ico" /> Locked with a PIN
              </>
            ) : (
              'Off'
            )}
          </div>
          <div className="set-hint">
            {profile.locked
              ? 'Opening this profile asks for its PIN on every device, each time someone switches to it.'
              : 'Ask for a PIN before anyone can open this profile. Separate from the parental lock for adult content.'}
          </div>
        </div>
        <div className="set-ctl row-actions">
          {profile.locked ? (
            <>
              <button type="button" className="btn" onClick={() => void change()}>
                Change PIN
              </button>
              <button type="button" className="btn" onClick={() => void remove()}>
                Remove
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => void set()}>
              Set a PIN
            </button>
          )}
        </div>
      </div>
      {profile.locked &&
        (forgot ? (
          <form
            className="inline-form pp-forgot"
            onSubmit={(e) => {
              e.preventDefault();
              if (password) void removeWithPassword();
            }}
          >
            <input className="input" type="password" autoComplete="current-password" placeholder="Account password" aria-label="Account password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            <button className="btn btn-primary" type="submit" disabled={!password}>
              Remove lock
            </button>
            <button className="btn" type="button" onClick={() => setForgot(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="link-btn" onClick={() => setForgot(true)}>
            Forgot the PIN? Remove the lock with the account password
          </button>
        ))}
    </section>
  );
}

/** Checks a profile PIN (the enter route always checks a PIN that is sent). */
async function enterCheck(id: string, pin: string) {
  await call('POST /api/profiles/:id/enter', { params: { id }, body: { pin } });
}

/* ---------------- the profile's main settings (only for the profile in use) ---------------- */

function PrefsSection() {
  const prefs = useApp((s) => s.prefs);
  const navigate = useNavigate();
  const tabs: TabId[] = ALL_TABS.filter((t) => !prefs.start.hiddenTabs.includes(t));
  return (
    <section className="pp-section">
      <h2 className="label">Settings for this profile</h2>
      <div className="set-row">
        <div className="set-text">
          <div className="set-label">Accent color</div>
          <div className="set-hint">Progress, focus and the timeline.</div>
        </div>
        <div className="set-ctl">
          <div className="swatches" role="radiogroup" aria-label="Accent color" data-nav-row="pp-accent">
            {(Object.keys(ACCENTS) as AccentId[]).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={prefs.appearance.accent === c}
                aria-label={ACCENTS[c].name}
                title={ACCENTS[c].name}
                className="swatch"
                style={{ background: ACCENTS[c].hex, ['--sw' as string]: ACCENTS[c].hex }}
                onClick={() => setPref('appearance', { accent: c })}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="set-row stack">
        <div className="set-text">
          <div className="set-label">Opens on</div>
        </div>
        <div className="set-ctl">
          <Segmented label="Opens on" value={prefs.start.startTab} options={tabs.map((t) => ({ value: t, label: TABS[t].label }))} onChange={(v) => setPref('start', { startTab: v })} />
        </div>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-label">Autoplay next episode</div>
        </div>
        <div className="set-ctl">
          <Toggle label="Autoplay next episode" checked={prefs.player.autoplayNext} onChange={(v) => setPref('player', { autoplayNext: v })} />
        </div>
      </div>
      <div className="pp-links">
        <button type="button" className="btn" onClick={() => navigate('/settings')}>
          All settings
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            // the parental lock section is part of All settings
            if (prefs.settingsMode !== 'all') patchPrefs({ settingsMode: 'all' });
            navigate('/settings#set-parental');
          }}
        >
          Parental lock
        </button>
      </div>
    </section>
  );
}

/* ---------------- delete ---------------- */

function DeleteSection({ profile }: { profile: Profile }) {
  const current = useApp((s) => s.profileId);
  const me = useApp((s) => s.me)!;
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const del = async () => {
    try {
      await deleteProfile(profile.id);
      toast(`${profile.name} deleted.`);
      if (profile.id === current) {
        const other = me.profiles.find((p) => p.id !== profile.id);
        if (other && (await switchProfile(other))) navigate('/', { replace: true });
        else navigate('/profiles', { replace: true });
      } else navigate('/profiles', { replace: true });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <section className="pp-section pp-danger">
      <h2 className="label">Delete profile</h2>
      <p className="set-hint">Deletes {profile.name}'s favorites, progress, lists and settings. This can't be undone.</p>
      <div className="row-actions">
        {confirm ? (
          <>
            <button type="button" className="btn btn-danger" onClick={() => void del()}>
              Delete {profile.name}
            </button>
            <button type="button" className="btn" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-danger" onClick={() => setConfirm(true)}>
            Delete profile
          </button>
        )}
      </div>
    </section>
  );
}
