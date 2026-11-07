/**
 * Who's watching? The full-screen profile picker: shown when AnyCast opens (unless this device
 * turned that off), after "Switch profile", and as Manage profiles (every tile opens its profile
 * page). Locked profiles show a lock and ask for their PIN.
 */
import { PROFILES_MAX, type Profile } from '@anycast/shared';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useApp } from '../store/app';
import { askOnLaunch, lastProfileId, logout, setAskOnLaunch } from '../store/actions';
import { switchProfile } from '../profiles/actions';
import { ProfileAvatar } from '../profiles/Avatar';
import { BrandMark, IconLock, IconPencil, IconPlus } from '../components/Icons';
import { Toggle } from '../components/ui';
import '../theme/profiles.css';

export function ProfilePicker({ manage = false }: { manage?: boolean }) {
  const me = useApp((s) => s.me);
  const current = useApp((s) => s.profileId);
  const navigate = useNavigate();
  const [ask, setAsk] = useState(askOnLaunch);
  if (!me) return null;
  const last = current ?? lastProfileId();
  const focusId = me.profiles.some((p) => p.id === last) ? last : me.profiles[0]?.id;

  const pick = async (p: Profile) => {
    if (manage) return navigate(`/profiles/${p.id}`);
    if (await switchProfile(p)) navigate('/', { replace: true });
  };

  return (
    <div className={`who${manage ? ' managing' : ''}`}>
      <div className="who-brand">
        <BrandMark />
        AnyCast
      </div>
      <h1 className="who-title">{manage ? 'Manage profiles' : "Who's watching?"}</h1>
      {manage && <p className="who-sub">Pick a profile to change its name, picture, PIN and settings.</p>}
      <ul className="who-grid" data-nav-row="profiles" aria-label="Profiles">
        {me.profiles.map((p, i) => (
          <li key={p.id} style={{ '--i': i } as React.CSSProperties}>
            <button
              type="button"
              className="who-tile"
              onClick={() => void pick(p)}
              data-nav-autofocus={p.id === focusId ? '' : undefined}
              autoFocus={p.id === focusId}
              aria-label={`${manage ? 'Edit ' : ''}${p.name}${p.locked ? ', locked with a PIN' : ''}`}
            >
              <span className="who-pic">
                <ProfileAvatar profile={p} size="xl" />
                {manage && (
                  <span className="who-edit" aria-hidden="true">
                    <IconPencil />
                  </span>
                )}
              </span>
              <span className="who-name">
                <span className="ellipsis">{p.name}</span>
                {p.locked && <IconLock className="ico who-lock" />}
              </span>
            </button>
          </li>
        ))}
        {me.profiles.length < PROFILES_MAX && (
          <li style={{ '--i': me.profiles.length } as React.CSSProperties}>
            <button type="button" className="who-tile who-add" onClick={() => navigate('/profiles/new')}>
              <span className="who-pic">
                <span className="pic pic-xl pic-add" aria-hidden="true">
                  <IconPlus />
                </span>
              </span>
              <span className="who-name">Add profile</span>
            </button>
          </li>
        )}
      </ul>
      <div className="who-actions">
        {manage ? (
          <button type="button" className="btn btn-primary who-done" onClick={() => (current ? navigate(-1) : navigate('/'))}>
            Done
          </button>
        ) : (
          <button type="button" className="btn who-manage" onClick={() => navigate('/profiles')}>
            <IconPencil /> Manage profiles
          </button>
        )}
      </div>
      {manage ? (
        <label className="who-ask">
          <Toggle
            label="Ask who's watching when AnyCast opens"
            checked={ask}
            onChange={(v) => {
              setAskOnLaunch(v);
              setAsk(v);
            }}
          />
          <span>
            Ask who's watching each time AnyCast opens on this device
            <span className="muted"> · otherwise it opens the last profile</span>
          </span>
        </label>
      ) : (
        <button type="button" className="link-btn who-signout" onClick={() => void logout()}>
          Sign out of {me.user.username}
        </button>
      )}
    </div>
  );
}
