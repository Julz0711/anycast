/** Who's watching? Shown after sign-in when there is more than one profile. */
import { useApp } from '../store/app';
import { logout, selectProfile } from '../store/actions';
import { BrandMark } from '../components/Icons';

export function ProfilePicker() {
  const me = useApp((s) => s.me);
  if (!me) return null;
  return (
    <div className="center-screen">
      <div style={{ textAlign: 'center' }}>
        <div className="brand" style={{ justifyContent: 'center' }}>
          <BrandMark />
          AnyCast
        </div>
        <h1 className="h1">Who's watching?</h1>
        <div className="profiles" data-nav-row="profiles">
          {me.profiles.map((p, i) => (
            <button key={p.id} type="button" className="profile-tile" onClick={() => selectProfile(p.id)} data-nav-autofocus={i === 0 ? '' : undefined} autoFocus={i === 0}>
              <span className="big" aria-hidden="true">
                {p.name.slice(0, 1).toUpperCase()}
              </span>
              {p.name}
            </button>
          ))}
        </div>
        <p className="muted" style={{ marginTop: '2.5rem', fontSize: '0.875rem' }}>
          Add or rename profiles in Settings › Profiles.{' '}
          <button type="button" className="link-btn" onClick={() => void logout()}>
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
