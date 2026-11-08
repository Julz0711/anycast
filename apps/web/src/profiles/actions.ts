/** Profile actions: switching (with the profile lock's PIN), editing, pictures and the profile lock. */
import { create } from 'zustand';
import { PROFILE_IMAGE, type Profile } from '@anycast/shared';
import { call } from '../api/client';
import { useApp } from '../store/app';
import { refreshMe, selectProfile } from '../store/actions';
import { askPin } from '../store/parental';

/**
 * The full-screen hand-over while switching profiles (to is null when none):
 * 'in' fades the cover up over the current page, 'hold' keeps it while the next profile loads
 * underneath, 'out' fades it away to reveal the new profile's Home.
 */
export type SwitchPhase = 'in' | 'hold' | 'out';
export const useSwitching = create<{ to: Profile | null; phase: SwitchPhase }>(() => ({ to: null, phase: 'in' }));

/** Hand-over timings in ms per animation setting (exported for tests). */
export const SWITCH_TIMING = {
  full: { cover: 200, minHold: 520, maxHold: 1600, reveal: 320 },
  reduced: { cover: 80, minHold: 200, maxHold: 1200, reveal: 120 },
  off: { cover: 0, minHold: 120, maxHold: 1200, reveal: 0 },
} as const;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const animSetting = (): keyof typeof SWITCH_TIMING => {
  const a = document.documentElement.dataset.anim;
  return a === 'off' || a === 'reduced' ? a : 'full';
};

/** Resolves once the profile's own preferences (accent, layout...) are in, or after maxMs. */
function prefsReady(maxMs: number): Promise<void> {
  if (useApp.getState().prefsLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); unsub(); resolve(); };
    const t = setTimeout(done, maxMs);
    const unsub = useApp.subscribe((s) => { if (s.prefsLoaded) done(); });
  });
}

const replaceInMe = (p: Profile) => {
  const me = useApp.getState().me;
  if (me) useApp.setState({ me: { ...me, profiles: me.profiles.map((x) => (x.id === p.id ? p : x)) } });
};

/** Asks for a locked profile's PIN and opens it on this session; false when cancelled. */
export function enterWithPin(p: Profile, why = 'Enter the PIN to open this profile.'): Promise<boolean> {
  return askPin({
    title: p.name,
    subtitle: why,
    submitLabel: 'Open',
    checksPin: false,
    submit: async (pin) => {
      replaceInMe(await call('POST /api/profiles/:id/enter', { params: { id: p.id }, body: { pin } }));
    },
  });
}

let switchRun = 0;

/**
 * Switches to a profile: asks for its PIN when it is locked (always, like opening it fresh), then
 * covers the screen with a short hand-over, loads the profile underneath and reveals it once its
 * preferences are in, so the old page never flickers into the new one. Resolves (false when the
 * PIN was cancelled) once the screen is covered, so callers can navigate out of sight.
 */
export async function switchProfile(p: Profile): Promise<boolean> {
  const current = useApp.getState().profileId;
  if (p.id === current) return true;
  if (p.locked && !(await enterWithPin(p))) return false;
  // every other locked profile needs its PIN again on this device
  void call('POST /api/profiles/leave', { body: { keep: p.id } })
    .catch(() => undefined)
    .then(refreshMe);
  const run = ++switchRun;
  const t = SWITCH_TIMING[animSetting()];
  useSwitching.setState({ to: p, phase: 'in' });
  await wait(t.cover);
  if (run !== switchRun) return true;
  useSwitching.setState({ phase: 'hold' });
  const started = Date.now();
  selectProfile(p.id);
  void (async () => {
    await prefsReady(t.maxHold);
    await wait(Math.max(0, t.minHold - (Date.now() - started)));
    if (run !== switchRun) return;
    useSwitching.setState({ phase: 'out' });
    await wait(t.reveal);
    if (run === switchRun) useSwitching.setState({ to: null, phase: 'in' });
  })();
  return true;
}

export async function createProfile(name: string, avatar: string | null): Promise<Profile> {
  const p = await call('POST /api/profiles', { body: { name, avatar } });
  await refreshMe();
  return p;
}

export async function updateProfile(id: string, patch: { name?: string; avatar?: string | null }): Promise<Profile> {
  const p = await call('PATCH /api/profiles/:id', { params: { id }, body: patch });
  replaceInMe(p);
  return p;
}

export async function deleteProfile(id: string): Promise<void> {
  await call('DELETE /api/profiles/:id', { params: { id } });
  await refreshMe();
}

export async function uploadImage(id: string, blob: Blob): Promise<Profile> {
  const data = await blobToBase64(blob);
  const p = await call('PUT /api/profiles/:id/image', { params: { id }, body: { type: blob.type as (typeof PROFILE_IMAGE.types)[number], data } });
  replaceInMe(p);
  return p;
}

export async function removeImage(id: string): Promise<Profile> {
  const p = await call('DELETE /api/profiles/:id/image', { params: { id } });
  replaceInMe(p);
  return p;
}

export async function setLock(id: string, body: { pin: string | null; currentPin?: string; password?: string }): Promise<Profile> {
  const p = await call('PUT /api/profiles/:id/lock', { params: { id }, body });
  replaceInMe(p);
  return p;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the picture'));
    r.readAsDataURL(blob);
  });
}

/**
 * Crops a square out of an image (`zoom` ≥ 1, `x`/`y` the crop center as 0..1 of the free room)
 * and encodes it at PROFILE_IMAGE.size, as WebP where the browser can and JPEG otherwise, stepping
 * the quality down until it fits PROFILE_IMAGE.maxBytes.
 */
export async function cropToBlob(img: HTMLImageElement, crop: { zoom: number; x: number; y: number }): Promise<Blob> {
  const size = PROFILE_IMAGE.size;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const side = Math.min(img.naturalWidth, img.naturalHeight) / crop.zoom;
  const sx = (img.naturalWidth - side) * crop.x;
  const sy = (img.naturalHeight - side) * crop.y;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  for (const type of ['image/webp', 'image/jpeg']) {
    for (const q of [0.9, 0.8, 0.7, 0.55, 0.4]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
      // a browser that cannot encode WebP hands back a PNG
      if (blob && blob.type === type && blob.size <= PROFILE_IMAGE.maxBytes) return blob;
      if (!blob || blob.type !== type) break;
    }
  }
  throw new Error('This picture could not be made small enough. Try another one.');
}
