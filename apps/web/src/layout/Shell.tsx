/** Responsive shell: left rail on desktop/tablet/TV, bottom tab bar on phones. */
import { useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../store/app';
import { useFormFactor } from '../lib/hooks';
import { isTypingTarget } from '../lib/misc';
import { BrandMark } from '../components/Icons';
import { TABS, WATCH_KEY, phoneTabs, tabMatches, visibleTabs, watchMatches } from './tabs';
import { readLocal } from '../lib/storage';
import { IconMovie } from '../components/Icons';
import { LockNowButton } from '../components/Locks';
import { ProfileMenuButton } from '../profiles/ProfileMenu';

export function Shell() {
  const form = useFormFactor();
  const start = useApp((s) => s.prefs.start);
  const tabs = [...visibleTabs(start.tabOrder, start.hiddenTabs), 'settings' as const];
  const navigate = useNavigate();
  const loc = useLocation();

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
    const bar = phoneTabs(tabs);
    return (
      <div className="app">
        <main className={`main${fullBleed ? ' full' : ''}`} id="main">
          <Outlet />
        </main>
        {/* Search is a button on each page, the profile and Settings sit at the top of Home and Library */}
        <nav className={`tabbar${bar.length > 5 ? ' many' : ''}`} aria-label="Main">
          {bar.map((id) => {
            if (id === 'watch') {
              // Movies and Series in one place: back to the one used last
              const on = watchMatches(loc.pathname);
              return (
                <Link key={id} to={on ? loc.pathname.match(/^\/[a-z]+/)![0] : readLocal(WATCH_KEY) === 'series' ? '/series' : '/movies'} className="tab" aria-current={on ? 'page' : undefined}>
                  <IconMovie />
                  <span>Watch</span>
                </Link>
              );
            }
            const t = TABS[id];
            return (
              <Link key={id} to={t.path} className="tab" aria-current={tabMatches(id, loc.pathname) ? 'page' : undefined}>
                <t.Icon />
                <span>{t.short}</span>
              </Link>
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
            <Link key={id} to={t.path} className="rail-link" aria-current={tabMatches(id, loc.pathname) ? 'page' : undefined}>
              <t.Icon />
              <span className="lbl">{t.label}</span>
              {form === 'large' && <span className="key" aria-hidden="true">{t.key}</span>}
            </Link>
          );
        })}
        <div className="rail-foot rail-lock">
          <LockNowButton className="rail-profile lock-now" label="Lock adult content" />
        </div>
        <div className="rail-foot">
          <ProfileMenuButton />
        </div>
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
