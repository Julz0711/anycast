/**
 * Switching profiles from inside the app: the profile button and its menu at the foot of the rail
 * (desktop, tablet, TV), the "You" page behind the last tab on phones, and the short full-screen
 * hand-over that shows whose profile is opening.
 */
import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { Profile } from '@anycast/shared';
import { useApp } from '../store/app';
import { logout, showPicker } from '../store/actions';
import { ProfileAvatar } from './Avatar';
import { switchProfile, useSwitching } from './actions';
import { IconChevron, IconLock, IconPencil, IconSettings, IconSignOut, IconSparkle, IconSwitch } from '../components/Icons';
import '../theme/profiles.css';

function useProfiles() {
  const me = useApp((s) => s.me);
  const currentId = useApp((s) => s.profileId);
  const current = me?.profiles.find((p) => p.id === currentId) ?? null;
  const others = me?.profiles.filter((p) => p.id !== currentId) ?? [];
  return { me, current, others };
}

/** The rail's profile button: opens a menu to switch to another profile in one step. */
export function ProfileMenuButton() {
  const { current, others } = useProfiles();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        box.current?.querySelector<HTMLElement>('.rail-profile')?.focus();
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    // the first entry takes focus so the keyboard and the D-pad work at once
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('.pm-menu button')?.focus());
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!current) return null;
  const go = (f: () => void) => () => {
    setOpen(false);
    f();
  };
  return (
    <div className="pm" ref={box}>
      {open && (
        <div className="pm-menu" role="menu" aria-label="Profiles" data-nav-trap="">
          {others.map((p) => (
            <button key={p.id} type="button" role="menuitem" className="pm-item" onClick={go(() => void switchProfile(p).then((ok) => ok && navigate('/', { replace: true })))}>
              <ProfileAvatar profile={p} size="sm" />
              <span className="ellipsis">{p.name}</span>
              {p.locked && <IconLock className="ico pm-lock" aria-label="Locked" />}
            </button>
          ))}
          {others.length > 0 && <div className="pm-sep" role="separator" />}
          <button type="button" role="menuitem" className="pm-item" onClick={go(() => navigate('/recap'))}>
            <IconSparkle /> Your recap
          </button>
          <button type="button" role="menuitem" className="pm-item" onClick={go(() => navigate(`/profiles/${current.id}`))}>
            <IconPencil /> Edit profile
          </button>
          <button type="button" role="menuitem" className="pm-item" onClick={go(() => navigate('/profiles'))}>
            <IconSettings /> Manage profiles
          </button>
          <button type="button" role="menuitem" className="pm-item" onClick={go(showPicker)}>
            <IconSwitch /> Who's watching?
          </button>
          <div className="pm-sep" role="separator" />
          <button type="button" role="menuitem" className="pm-item" onClick={go(() => void logout())}>
            <IconSignOut /> Sign out
          </button>
        </div>
      )}
      <button type="button" className="rail-profile" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} aria-label={`Profile: ${current.name}. Switch or edit profiles`}>
        <ProfileAvatar profile={current} size="sm" />
        <span className="ellipsis pm-name">{current.name}</span>
        <IconChevron className="ico pm-chev" />
      </button>
    </div>
  );
}

/** Phones: the last tab, the profile's picture and name. */
export function ProfileTab() {
  const { current } = useProfiles();
  if (!current) return null;
  return (
    <NavLink to="/me" className="tab tab-profile">
      <ProfileAvatar profile={current} size="xs" />
      <span className="ellipsis">{current.name}</span>
    </NavLink>
  );
}

/** Phones: the profile page behind the last tab (switch, edit, settings, sign out). */
export function ProfileHub() {
  const { me, current, others } = useProfiles();
  const navigate = useNavigate();
  if (!me || !current) return null;
  const open = (p: Profile) => void switchProfile(p).then((ok) => ok && navigate('/', { replace: true }));
  return (
    <div className="hub pad-x">
      <section className="hub-me">
        <ProfileAvatar profile={current} size="lg" />
        <div className="hub-who">
          <h1 className="h1 ellipsis">{current.name}</h1>
          <button type="button" className="link-btn" onClick={() => navigate(`/profiles/${current.id}`)}>
            Edit profile
          </button>
        </div>
      </section>
      {others.length > 0 && (
        <section className="hub-switch" aria-labelledby="hub-switch-h">
          <h2 id="hub-switch-h" className="label">
            Switch to
          </h2>
          <div className="hub-others" data-nav-row="hub-others">
            {others.map((p) => (
              <button key={p.id} type="button" className="hub-other" onClick={() => open(p)} aria-label={`Switch to ${p.name}${p.locked ? ', locked with a PIN' : ''}`}>
                <ProfileAvatar profile={p} size="md" />
                <span className="hub-other-name">
                  <span className="ellipsis">{p.name}</span>
                  {p.locked && <IconLock className="ico who-lock" />}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      <nav className="hub-list" aria-label="Profile and app">
        <HubRow icon={<IconSparkle />} label="Your recap" onClick={() => navigate('/recap')} />
        <HubRow icon={<IconSettings />} label="Settings" onClick={() => navigate('/settings')} />
        <HubRow icon={<IconPencil />} label="Manage profiles" onClick={() => navigate('/profiles')} />
        <HubRow icon={<IconSwitch />} label="Who's watching?" onClick={showPicker} />
        <HubRow icon={<IconSignOut />} label={`Sign out of ${me.user.username}`} onClick={() => void logout()} />
      </nav>
    </div>
  );
}

function HubRow(props: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" className="hub-row" onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
      <IconChevron className="ico hub-chev" />
    </button>
  );
}

/** A short full-screen hand-over while the next profile opens. */
export function SwitchOverlay() {
  const to = useSwitching((s) => s.to);
  const phase = useSwitching((s) => s.phase);
  if (!to) return null;
  return (
    <div className="switching" data-phase={phase} role="status" aria-live="polite">
      <ProfileAvatar profile={to} size="xl" />
      <span className="switching-name">{to.name}</span>
    </div>
  );
}
