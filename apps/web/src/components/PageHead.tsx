/**
 * Page head pieces shared by the main screens. On phones the tab bar has no Search or profile
 * tab: pages carry a Search button, and Home and Library the profile picture (to /me, which has
 * Settings and profile switching).
 */
import { useEffect, type ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useApp } from '../store/app';
import { useFormFactor } from '../lib/hooks';
import { readLocal, writeLocal } from '../lib/storage';
import { ProfileAvatar } from '../profiles/Avatar';
import { IconSearch } from './Icons';

export function SearchButton() {
  return (
    <Link to="/search" className="icon-btn" aria-label="Search">
      <IconSearch />
    </Link>
  );
}

export function ProfileButton() {
  const current = useApp((s) => s.me?.profiles.find((p) => p.id === s.profileId) ?? null);
  if (!current) return null;
  return (
    <Link to="/me" className="head-profile" aria-label={`${current.name}: profile and settings`}>
      <ProfileAvatar profile={current} size="xs" />
    </Link>
  );
}

/** Phones: Search and (optionally) the profile, at the end of a page head. */
export function PhoneHeadActions(props: { profile?: boolean; children?: ReactNode }) {
  const form = useFormFactor();
  if (form !== 'phone') return props.children ? <div className="head-actions">{props.children}</div> : null;
  return (
    <div className="head-actions">
      {props.children}
      <SearchButton />
      {props.profile && <ProfileButton />}
    </div>
  );
}

const LIB_KEY = 'anycast.libTab';
type LibPart = 'favorites' | 'lists';

/** /library: reopen Favorites or Lists, whichever was used last on this device. */
export function LibraryIndex() {
  return <Navigate to={readLocal(LIB_KEY) === 'lists' ? '/lists' : '/favorites'} replace />;
}

/** The head of Favorites and Lists, the two parts of Library. */
export function LibraryHead(props: { actions?: ReactNode }) {
  const { pathname } = useLocation();
  const part: LibPart = pathname.startsWith('/lists') ? 'lists' : 'favorites';
  useEffect(() => writeLocal(LIB_KEY, part), [part]);
  return (
    <>
      <div className="page-head">
        <h1 className="h1">Library</h1>
        <PhoneHeadActions profile>{props.actions}</PhoneHeadActions>
      </div>
      <nav className="lib-switch" aria-label="Library" data-nav-row="lib-switch">
        <Link to="/favorites" aria-current={part === 'favorites' ? 'page' : undefined}>
          Favorites
        </Link>
        <Link to="/lists" aria-current={part === 'lists' ? 'page' : undefined}>
          Lists
        </Link>
      </nav>
    </>
  );
}
