import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from './store/app';
import { useAsync, useFormFactor } from './lib/hooks';
import { applyTheme } from './theme/theme';
import { focusables, installSpatialNav } from './nav/spatial';
import { Shell, Toasts } from './layout/Shell';
import { LiveScreen } from './screens/Live';
import { HomeScreen } from './screens/Home';
import { MoviesScreen, MovieDetail } from './screens/Movies';
import { LibraryIndex } from './components/PageHead';
import { SeriesScreen } from './screens/Series';
import { SeriesDetailScreen } from './screens/SeriesDetail';
import { SearchScreen } from './screens/Search';
import { SwipeScreen } from './screens/Swipe';
import { FavoritesIndex, FavoritesScreen } from './screens/Favorites';
import { ListsIndex, ListsScreen } from './screens/Lists';
import { LoginScreen } from './screens/Login';
import { ProfilePicker } from './screens/Profiles';
import { ProfileHub, SwitchOverlay } from './profiles/ProfileMenu';
import { SetupScreen } from './screens/Setup';
import { markSetupDone } from './store/actions';
import { call } from './api/client';
import { readLocal } from './lib/storage';
import { Skeleton } from './components/ui';
import { AddToListHost } from './components/lists';
import { PinHost } from './components/Locks';
import { PlayerHost } from './player/PlayerHost';

const SettingsScreen = lazy(() => import('./screens/Settings'));
const ProfilePage = lazy(() => import('./profiles/ProfilePage'));
const RecapScreen = lazy(() => import('./screens/Recap'));

function subscribeMotion(cb: () => void) {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

function ThemeSync() {
  const prefs = useApp((s) => s.prefs);
  const form = useFormFactor();
  const reducedMotion = useSyncExternalStore(subscribeMotion, () => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useLayoutEffect(() => applyTheme(prefs, { reducedMotion, form }), [prefs, reducedMotion, form]);
  return null;
}

function SpatialNav() {
  const form = useFormFactor();
  const formRef = useRef(form);
  formRef.current = form;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // TV: after each navigation, put focus somewhere useful so the remote works immediately.
  useEffect(() => {
    if (form !== 'tv') return;
    const t = setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const main = document.getElementById('main') ?? document.body;
      (main.querySelector<HTMLElement>('[data-nav-autofocus]') ?? focusables(main).find((el) => !(el instanceof HTMLInputElement)))?.focus();
    }, 350);
    return () => clearTimeout(t);
  }, [pathname, form]);
  useEffect(
    () =>
      installSpatialNav({
        enabled: () => formRef.current === 'tv',
        onBack: () => {
          if ((history.state?.idx ?? 0) > 0) navigate(-1);
        },
      }),
    [navigate],
  );
  return null;
}

function StartRedirect() {
  const start = useApp((s) => s.prefs.start.startTab);
  const reopen = useApp((s) => s.prefs.live.reopenLastChannel);
  const last = readLocal('anycast.lastChannel');
  if (reopen && last) return <Navigate to={`/play/live/${last}`} replace />;
  return <Navigate to={`/${start}`} replace />;
}

function Splash() {
  return (
    <div className="center-screen" aria-busy="true">
      <div className="auth-card">
        <Skeleton h="2rem" w="40%" />
        <Skeleton h="1rem" />
        <Skeleton h="1rem" w="70%" />
      </div>
    </div>
  );
}

function AuthedRoutes() {
  const profileId = useApp((s) => s.profileId);
  const rules = useApp((s) => s.hideRules);
  const rulesLoaded = useApp((s) => s.hideRulesLoaded);
  const prefsLoaded = useApp((s) => s.prefsLoaded);
  const setupDone = useApp((s) => s.prefs.setupDone);
  const version = useApp((s) => s.catalogVersion);
  const source = useAsync(() => call('GET /api/source'), [profileId, version]);
  const hasRules = rules.countries.length + rules.languages.length + rules.categoryIds.length > 0;
  // A profile that has ever had filters is set up; clearing them later must not bring the setup back.
  useEffect(() => {
    if (profileId && rulesLoaded && prefsLoaded && hasRules && !setupDone) markSetupDone();
  }, [profileId, rulesLoaded, prefsLoaded, hasRules, setupDone]);

  if (!profileId) {
    // no profile open: the picker, and the profile pages behind Manage profiles
    return (
      <Suspense fallback={<Splash />}>
        <Routes>
          <Route path="/profiles" element={<ProfilePicker manage />} />
          <Route path="/profiles/:id" element={<ProfilePage />} />
          <Route path="*" element={<ProfilePicker />} />
        </Routes>
      </Suspense>
    );
  }
  if (!rulesLoaded || !prefsLoaded || (source.loading && !source.data)) return <Splash />;
  const noCatalog = source.data && (!source.data.configured || source.data.counts.live + source.data.counts.movie + source.data.counts.series === 0);
  const noFilters = !hasRules && !setupDone;
  if (noCatalog || noFilters) return <SetupScreen status={source.data ?? null} onRefresh={source.reload} />;

  return (
    <>
      <Suspense fallback={<Splash />}>
        <Routes>
          {/* the player itself is PlayerHost below: it stays mounted as the mini player after leaving this route */}
          <Route path="/play/:kind/:id" element={null} />
          <Route path="/profiles" element={<ProfilePicker manage />} />
          <Route path="/profiles/:id" element={<ProfilePage />} />
          <Route path="/recap" element={<RecapScreen />} />
          <Route element={<Shell />}>
            <Route path="/home" element={<HomeScreen />} />
            <Route path="/live" element={<LiveScreen />} />
            <Route path="/movies" element={<MoviesScreen />} />
            <Route path="/movies/:id" element={<MovieDetail />} />
            <Route path="/series" element={<SeriesScreen />} />
            <Route path="/series/:id" element={<SeriesDetailScreen />} />
            <Route path="/favorites" element={<FavoritesIndex />} />
            <Route path="/favorites/:tab" element={<FavoritesScreen />} />
            <Route path="/library" element={<LibraryIndex />} />
            <Route path="/lists" element={<ListsIndex />} />
            <Route path="/lists/:id" element={<ListsScreen />} />
            <Route path="/search" element={<SearchScreen />} />
            <Route path="/swipe" element={<SwipeScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="/me" element={<ProfileHub />} />
          </Route>
          <Route path="*" element={<StartRedirect />} />
        </Routes>
      </Suspense>
      {/* outside the Suspense above, so a lazy screen loading never hides the mini player */}
      <PlayerHost />
    </>
  );
}

export function App() {
  const auth = useApp((s) => s.auth);
  return (
    <BrowserRouter>
      <ThemeSync />
      <SpatialNav />
      {auth === 'unknown' ? <Splash /> : auth === 'anon' ? <LoginScreen /> : <AuthedRoutes />}
      {auth === 'authed' && <AddToListHost />}
      <PinHost />
      {auth === 'authed' && <SwitchOverlay />}
      <Toasts />
    </BrowserRouter>
  );
}
