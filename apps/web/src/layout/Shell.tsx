/** Responsive shell: left rail on desktop/tablet/TV, bottom tab bar on phones. */
import { useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../store/app';
import { useFormFactor } from '../lib/hooks';
import { isTypingTarget } from '../lib/misc';
import { BrandMark } from '../components/Icons';
import { TABS, visibleTabs } from './tabs';
import { clearProfile } from '../store/actions';
import { LockNowButton } from '../components/Locks';

export function Shell() {
  const form = useFormFactor();
  const start = useApp((s) => s.prefs.start);
  const me = useApp((s) => s.me);
  const profileId = useApp((s) => s.profileId);
  const tabs = [...visibleTabs(start.tabOrder, start.hiddenTabs), 'settings' as const];
  const navigate = useNavigate();
  const loc = useLocation();
  const profile = me?.profiles.find((p) => p.id === profileId);

  // Desktop keyboard shortcuts: L F M S / ,
  useEffect(() => {
    if (form !== 'large') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const t = tabs.find((id) => TABS[id].key.toLowerCase() === e.key.toLowerCase());
      if (t) {
        e.preventDefault();
        navigate(TABS[t].path);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [form, tabs, navigate]);

  const fullBleed = /^\/live\/?$/.test(loc.pathname);

  if (form === 'phone') {
    return (
      <div className="app">
        <main className={`main${fullBleed ? ' full' : ''}`} id="main">
          <Outlet />
        </main>
        <nav className={`tabbar${tabs.length > 5 ? ' many' : ''}`} aria-label="Main">
          {tabs.map((id) => {
            const t = TABS[id];
            return (
              <NavLink key={id} to={t.path} className="tab">
                <t.Icon />
                <span>{t.short}</span>
              </NavLink>
            );
          })}
        </nav>
        <LockNowButton className="lock-now-fab lock-now" label="Lock" />
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="rail" aria-label="Main" data-nav-row="rail">
        <div className="brand">
          <BrandMark />
          AnyCast
        </div>
        {tabs.map((id) => {
          const t = TABS[id];
          return (
            <NavLink key={id} to={t.path} className="rail-link">
              <t.Icon />
              <span className="lbl">{t.label}</span>
              {form === 'large' && <span className="key" aria-hidden="true">{t.key}</span>}
            </NavLink>
          );
        })}
        <div className="rail-foot rail-lock">
          <LockNowButton className="rail-profile lock-now" label="Lock adult content" />
        </div>
        {profile && (me?.profiles.length ?? 0) > 1 && (
          <div className="rail-foot">
            <button type="button" className="rail-profile" onClick={clearProfile} aria-label={`Profile ${profile.name}. Switch profile`}>
              <span className="avatar">{profile.name.slice(0, 1).toUpperCase()}</span>
              <span className="ellipsis">{profile.name}</span>
            </button>
          </div>
        )}
      </nav>
      <main className={`main${fullBleed ? ' full' : ''}`} id="main">
        <Outlet />
      </main>
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
