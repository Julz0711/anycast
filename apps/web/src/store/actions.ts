/** State-changing actions: auth, profile, preferences (optimistic + debounced PUT), favorites, progress, sync events. */
import { mergePreferences, type Favorite, type HideRules, type Preferences, type Progress, type SyncEvent } from '@anycast/shared';
import { call, clearApiCache, errorMessage, requestHeaders, buildPath } from '../api/client';
import { connectEvents } from '../api/events';
import { readJson, readLocal, writeLocal } from '../lib/storage';
import type { DeviceOverride } from '../lib/device';
import { EMPTY_RULES, progressKey, useApp } from './app';
import { isDemo } from '../demo/flag';
import { clientId } from '../lib/client-id';
import { applyListsEvent } from './lists';
import { loadAdult } from './parental';

const get = useApp.getState;
const set = useApp.setState;

/* ---------------- toasts ---------------- */
let toastId = 0;
export function toast(text: string, tone: 'info' | 'error' = 'info', ms = 4000) {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

/* ---------------- auth & profile ---------------- */
const profileKey = (userId: string) => `anycast.profile.${userId}`;

export async function bootstrap() {
  try {
    const me = await call('GET /api/me');
    onSignedIn(me);
  } catch {
    // 401 sets anon via onUnauthorized; any other error: show login (which reports server problems)
    if (get().auth === 'unknown') set({ auth: 'anon' });
  }
}

export function onSignedIn(me: NonNullable<ReturnType<typeof get>['me']>) {
  set({ auth: 'authed', me });
  const stored = readLocal(profileKey(me.user.id));
  const valid = me.profiles.find((p) => p.id === stored);
  if (valid) selectProfile(valid.id);
  else if (me.profiles.length === 1) selectProfile(me.profiles[0]!.id);
  else set({ profileId: null });
}

export function onUnauthorized() {
  if (get().auth !== 'anon') set({ auth: 'anon', me: null, profileId: null, prefsLoaded: false });
  disconnect?.();
  disconnect = null;
}

export async function login(username: string, password: string) {
  const me = await call('POST /api/auth/login', { body: { username, password } });
  onSignedIn(me);
}

export async function logout() {
  try {
    await call('POST /api/auth/logout');
  } finally {
    onUnauthorized();
  }
}

let disconnect: (() => void) | null = null;

export function selectProfile(id: string) {
  const me = get().me;
  if (me) writeLocal(profileKey(me.user.id), id);
  clearApiCache();
  const cachedPrefs = readJson<Preferences>(`anycast.prefs.${id}`);
  set({
    profileId: id,
    prefs: mergePreferences(cachedPrefs ?? {}),
    prefsLoaded: false,
    favorites: [],
    progress: {},
    hideRules: EMPTY_RULES,
    hideRulesLoaded: false,
    lists: [],
    listsLoaded: false,
    catalogVersion: get().catalogVersion + 1,
  });
  void loadProfileData();
  void loadAdult();
  disconnect?.();
  disconnect = connectEvents(id, applyEvent, () => void loadProfileData());
}

export function clearProfile() {
  set({ profileId: null });
}

export async function loadProfileData() {
  const pid = get().profileId;
  const [prefs, favs, progress, rules, lists] = await Promise.allSettled([
    call('GET /api/preferences'),
    call('GET /api/favorites'),
    call('GET /api/progress'),
    call('GET /api/hide-rules'),
    call('GET /api/lists'),
  ]);
  if (get().profileId !== pid) return;
  if (prefs.status === 'fulfilled' && !pendingPrefs) setPrefsFromServer(prefs.value);
  // offline or a local edit pending: keep the cached copy rather than blocking the app
  else set({ prefsLoaded: true });
  if (favs.status === 'fulfilled') set({ favorites: favs.value });
  if (progress.status === 'fulfilled') set({ progress: Object.fromEntries(progress.value.map((p) => [progressKey(p.kind, p.id), p])) });
  if (rules.status === 'fulfilled') set({ hideRules: rules.value, hideRulesLoaded: true });
  else set({ hideRulesLoaded: true });
  if (lists.status === 'fulfilled') set({ lists: lists.value, listsLoaded: true });
  else set({ listsLoaded: true });
}

function setPrefsFromServer(p: Preferences) {
  const merged = mergePreferences(p);
  set({ prefs: merged, prefsLoaded: true });
  writeLocal(`anycast.prefs.${get().profileId}`, JSON.stringify(merged));
}

/* ---------------- preferences ---------------- */
type Section = Exclude<keyof Preferences, 'settingsMode' | 'setupDone'>;
let pendingPrefs: Partial<Preferences> | null = null;
let prefsTimer: ReturnType<typeof setTimeout> | undefined;

/** Optimistically change preferences; sends whole sections (the contract's PUT takes Partial<Preferences>). */
export function patchPrefs(partial: Partial<Preferences>) {
  const next = mergePreferences({ ...get().prefs, ...partial });
  set({ prefs: next });
  writeLocal(`anycast.prefs.${get().profileId}`, JSON.stringify(next));
  pendingPrefs = { ...pendingPrefs, ...partial };
  if (prefsTimer) clearTimeout(prefsTimer);
  prefsTimer = setTimeout(flushPrefs, 350);
}

export function setPref<S extends Section>(section: S, patch: Partial<Preferences[S]>) {
  patchPrefs({ [section]: { ...get().prefs[section], ...patch } } as Partial<Preferences>);
}

async function flushPrefs() {
  const body = pendingPrefs;
  pendingPrefs = null;
  if (!body) return;
  try {
    const saved = await call('PUT /api/preferences', { body });
    if (!pendingPrefs) setPrefsFromServer(saved);
  } catch (e) {
    toast(`Couldn't save settings: ${errorMessage(e)}`, 'error');
  }
}

/** First-run setup is per profile and stored on the server (Preferences.setupDone), so it syncs. */
export function markSetupDone() {
  if (!get().prefs.setupDone) patchPrefs({ setupDone: true });
}

/* ---------------- device override (per device, not synced) ---------------- */
export function setDeviceOverride(d: DeviceOverride) {
  writeLocal('anycast.device', d === 'auto' ? null : d);
  set({ deviceOverride: d });
}

/* ---------------- favorites (optimistic) ---------------- */
export async function toggleFavorite(kind: Favorite['kind'], id: string) {
  const before = get().favorites;
  const isFav = before.some((f) => f.kind === kind && f.id === id);
  set({ favorites: isFav ? before.filter((f) => !(f.kind === kind && f.id === id)) : [...before, { kind, id, addedAt: Date.now() }] });
  try {
    const favs = await call('PUT /api/favorites', { body: { kind, id, favorite: !isFav } });
    set({ favorites: favs });
  } catch (e) {
    set({ favorites: before });
    toast(`Couldn't update favorites: ${errorMessage(e)}`, 'error');
  }
}

/* ---------------- progress ---------------- */
export type ProgressBody = Omit<Progress, 'updatedAt' | 'finished'>;

function localProgress(body: ProgressBody) {
  const finished = body.duration > 0 && body.position / body.duration > 0.95;
  set((s) => ({ progress: { ...s.progress, [progressKey(body.kind, body.id)]: { ...body, finished, updatedAt: Date.now() } } }));
}

export async function saveProgress(body: ProgressBody) {
  if (!(body.duration > 0) || !Number.isFinite(body.position)) return;
  localProgress(body);
  try {
    const saved = await call('PUT /api/progress', { body });
    set((s) => ({ progress: { ...s.progress, [progressKey(saved.kind, saved.id)]: saved } }));
  } catch {
    /* next tick retries; never interrupt playback */
  }
}

/** For pagehide/unload: a keepalive PUT (sendBeacon can only POST). */
export function saveProgressOnUnload(body: ProgressBody) {
  if (!(body.duration > 0)) return;
  localProgress(body);
  if (isDemo()) {
    void call('PUT /api/progress', { body });
    return;
  }
  try {
    void fetch(buildPath('PUT /api/progress'), {
      method: 'PUT',
      headers: requestHeaders(true),
      body: JSON.stringify(body),
      keepalive: true,
      credentials: 'same-origin',
    });
  } catch {
    /* ignore */
  }
}

/* ---------------- hide rules ---------------- */
export async function saveHideRules(rules: HideRules) {
  const before = get().hideRules;
  set({ hideRules: rules, catalogVersion: get().catalogVersion + 1 });
  clearApiCache();
  try {
    const saved = await call('PUT /api/hide-rules', { body: rules });
    set({ hideRules: saved });
  } catch (e) {
    set({ hideRules: before });
    toast(`Couldn't save filters: ${errorMessage(e)}`, 'error');
  }
}

/* ---------------- realtime ---------------- */
export function applyEvent(ev: SyncEvent) {
  const pid = get().profileId;
  if ('profileId' in ev && ev.profileId !== pid) return;
  switch (ev.type) {
    case 'favorites':
      set({ favorites: ev.favorites });
      break;
    case 'progress':
      set((s) => ({ progress: { ...s.progress, [progressKey(ev.progress.kind, ev.progress.id)]: ev.progress } }));
      break;
    case 'preferences':
      if (!pendingPrefs) setPrefsFromServer(ev.preferences);
      break;
    case 'hide-rules':
      clearApiCache();
      set((s) => ({ hideRules: ev.rules, catalogVersion: s.catalogVersion + 1 }));
      break;
    case 'lists':
      applyListsEvent(ev.lists);
      break;
    case 'parental':
      // mode, PIN or duration changed on another device: reload the lock state and the lists
      void loadAdult({ refresh: true });
      break;
    case 'catalog-updated':
      clearApiCache();
      set((s) => ({ catalogVersion: s.catalogVersion + 1 }));
      break;
    case 'playback-stopped':
      // the profile may be open on several devices; only the stopped one reacts
      if (ev.clientId === clientId()) set({ playbackStopped: { by: ev.by, at: Date.now() } });
      break;
  }
}

export function setZapList(ids: string[]) {
  set({ zapList: ids });
}
