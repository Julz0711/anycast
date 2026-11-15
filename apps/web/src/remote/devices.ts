/**
 * Remote control, the phone's side: the account's devices as the server last said (SSE
 * 'remote-devices', or GET /api/remote/devices), with the moment each arrived here, so a
 * playing position can move on between updates. This device itself is left out.
 */
import type { RemoteDevice, RemoteNowPlaying } from '@anycast/shared';
import { useSyncExternalStore } from 'react';
import { clientId } from '../lib/client-id';

export interface SeenDevice extends RemoteDevice {
  /** Date.now() here at which `playing` was true */
  seenAt: number;
}

let devices: SeenDevice[] = [];
let loaded = false;
const listeners = new Set<() => void>();

export function setRemoteDevices(list: RemoteDevice[]) {
  const t = Date.now();
  const me = clientId();
  devices = list.filter((d) => d.clientId !== me).map((d) => ({ ...d, seenAt: t - d.ageMs }));
  loaded = true;
  listeners.forEach((l) => l());
}

/** A command was sent: show its effect right away (the device's next announcement confirms it). */
export function patchRemotePlaying(id: string, fn: (p: RemoteNowPlaying) => RemoteNowPlaying) {
  const t = Date.now();
  devices = devices.map((d) => {
    if (d.clientId !== id || !d.playing) return d;
    // move the position to now first, so a pause or a seek starts from where it is
    const p = { ...d.playing, position: positionNow(d, t) };
    return { ...d, playing: fn(p), seenAt: t };
  });
  listeners.forEach((l) => l());
}

export function useRemoteDevices(): { devices: SeenDevice[]; loaded: boolean } {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => devices,
  );
  return { devices: list, loaded };
}

/** Where the device's picture is now: seconds (VOD) or epoch ms (live), moved on while it plays. */
export function positionNow(d: Pick<SeenDevice, 'playing' | 'seenAt'>, t = Date.now()): number {
  const p = d.playing;
  if (!p) return 0;
  if (p.paused || p.waiting || p.needsTap) return p.position;
  const elapsed = Math.max(0, t - d.seenAt);
  if (p.kind === 'live') return p.position + elapsed;
  return p.duration > 0 ? Math.min(p.duration, p.position + elapsed / 1000) : p.position + elapsed / 1000;
}
