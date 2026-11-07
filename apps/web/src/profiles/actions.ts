/** Profile actions: switching (with the profile lock's PIN), editing, pictures and the profile lock. */
import { create } from 'zustand';
import { PROFILE_IMAGE, type Profile } from '@anycast/shared';
import { call } from '../api/client';
import { useApp } from '../store/app';
import { refreshMe, selectProfile } from '../store/actions';
import { askPin } from '../store/parental';

/** The profile being switched to, for the full-screen hand-over (null when none). */
export const useSwitching = create<{ to: Profile | null }>(() => ({ to: null }));

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

let switchTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Switches to a profile: asks for its PIN when it is locked (always, like opening it fresh), then
 * shows a short hand-over and loads it. Resolves false when the PIN was cancelled.
 */
export async function switchProfile(p: Profile): Promise<boolean> {
  const current = useApp.getState().profileId;
  if (p.id === current) return true;
  if (p.locked && !(await enterWithPin(p))) return false;
  // every other locked profile needs its PIN again on this device
  void call('POST /api/profiles/leave', { body: { keep: p.id } })
    .catch(() => undefined)
    .then(refreshMe);
  clearTimeout(switchTimer);
  useSwitching.setState({ to: p });
  selectProfile(p.id);
  const reduced = document.documentElement.dataset.anim === 'reduced' || document.documentElement.dataset.anim === 'off';
  switchTimer = setTimeout(() => useSwitching.setState({ to: null }), reduced ? 250 : 900);
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
