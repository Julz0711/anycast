/**
 * Remote control, the steered side. While the setting allows it (Settings > Remote, on by default
 * on computers and TVs), this AnyCast tells the server it can be steered and what it plays, so a
 * phone's remote can show it. Commands arrive over the realtime stream (store/actions.ts hands
 * them here): the player that is open runs them, and "open" starts something new.
 */
import { REMOTE_HEARTBEAT_MS, type RemoteCommand, type RemoteForm, type RemoteNowPlaying } from '@anycast/shared';
import { useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../lib/storage';

export const ALLOW_KEY = 'anycast.remote.allow';
export const NAME_KEY = 'anycast.remote.name';

/** The open player: what it plays and how to run a command on it. */
export interface PlayerHandle {
  snapshot: () => RemoteNowPlaying | null;
  run: (c: RemoteCommand) => void;
}

let player: PlayerHandle | null = null;
let opener: ((c: Extract<RemoteCommand, { type: 'open' }>) => void) | null = null;
let changed: (() => void) | null = null;

/** PlayerScreen registers itself while it is mounted (full or mini). */
export function setRemotePlayer(h: PlayerHandle | null) {
  player = h;
  changed?.();
}

/** The player's state changed (play, pause, seek, volume, another item): tell the phones soon. */
export function remoteStateChanged() {
  changed?.();
}

/** How "open" starts an item (the app's router). */
export function setRemoteOpener(fn: typeof opener) {
  opener = fn;
}

export function currentSnapshot(): RemoteNowPlaying | null {
  try {
    return player?.snapshot() ?? null;
  } catch {
    return null;
  }
}

/** A command from a phone for this device. */
export function runRemoteCommand(c: RemoteCommand) {
  if (c.type === 'open') return opener?.(c);
  player?.run(c);
}

/* ---------------- the setting ---------------- */
const allowListeners = new Set<() => void>();

/** Whether this device may be steered: its own choice, else everything but phones. */
export function remoteAllowed(form: RemoteForm): boolean {
  const v = readLocal(ALLOW_KEY);
  return v === null ? form !== 'phone' : v === '1';
}
export function setRemoteAllowed(on: boolean) {
  writeLocal(ALLOW_KEY, on ? '1' : '0');
  allowListeners.forEach((l) => l());
}
export function useRemoteAllowed(form: RemoteForm): boolean {
  return useSyncExternalStore(
    (l) => {
      allowListeners.add(l);
      return () => allowListeners.delete(l);
    },
    () => remoteAllowed(form),
  );
}

export function remoteName(): string {
  return (readLocal(NAME_KEY) ?? '').trim();
}
export function setRemoteName(name: string) {
  writeLocal(NAME_KEY, name.trim().slice(0, 60) || null);
  allowListeners.forEach((l) => l());
}
export function useRemoteName(): string {
  return useSyncExternalStore(
    (l) => {
      allowListeners.add(l);
      return () => allowListeners.delete(l);
    },
    remoteName,
  );
}

/* ---------------- announcing ---------------- */

/** What decides whether the phones need to hear again (the position is extrapolated there). */
export function signature(p: RemoteNowPlaying | null): string {
  if (!p) return '-';
  return [p.kind, p.id, p.title, p.subtitle, p.image, p.paused, p.waiting, p.needsTap, p.volume, p.muted, p.canPrev, p.canNext, p.casting, p.duration, p.program?.start].join('|');
}

/** True when the position is off from where the phones think it is by more than `slackS` seconds. */
export function drifted(sent: { p: RemoteNowPlaying; at: number } | null, now: RemoteNowPlaying | null, t: number, slackS = 3): boolean {
  if (!sent || !now) return false;
  const live = now.kind === 'live';
  const elapsed = sent.p.paused || sent.p.waiting ? 0 : t - sent.at;
  const expected = sent.p.position + (live ? elapsed : elapsed / 1000);
  const diff = Math.abs(now.position - expected);
  return live ? diff > slackS * 1000 : diff > slackS;
}

export interface Announcer {
  stop: () => void;
}

/**
 * Announces this device now, when the player says something changed (gathered for 250 ms),
 * when the position jumps, and every REMOTE_HEARTBEAT_MS. `send(null)` takes it off the list.
 */
export function startAnnouncing(form: RemoteForm, send: (body: { name: string | null; form: RemoteForm; playing: RemoteNowPlaying | null } | null) => Promise<unknown>): Announcer {
  let lastSig = '';
  let sent: { p: RemoteNowPlaying; at: number } | null = null;
  let lastSent = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const announce = () => {
    if (stopped) return;
    pending = undefined;
    const p = currentSnapshot();
    lastSig = signature(p) + '|' + remoteName();
    sent = p ? { p, at: Date.now() } : null;
    lastSent = Date.now();
    void send({ name: remoteName() || null, form, playing: p }).catch(() => undefined);
  };
  const soon = () => {
    if (stopped || pending) return;
    pending = setTimeout(announce, 250);
  };
  changed = soon;

  const tick = setInterval(() => {
    const p = currentSnapshot();
    const t = Date.now();
    if (signature(p) + '|' + remoteName() !== lastSig || drifted(sent, p, t) || t - lastSent >= REMOTE_HEARTBEAT_MS) soon();
  }, 1000);
  const onAllow = () => soon();
  allowListeners.add(onAllow);
  // a phone, a laptop lid: the next announcement after waking comes at once
  const onVisible = () => document.visibilityState === 'visible' && soon();
  document.addEventListener('visibilitychange', onVisible);
  // closing the tab: off the list now rather than after the TTL
  const onHide = (e: PageTransitionEvent) => {
    if (!e.persisted) void send(null).catch(() => undefined);
  };
  window.addEventListener('pagehide', onHide);
  announce();

  return {
    stop: () => {
      stopped = true;
      if (pending) clearTimeout(pending);
      clearInterval(tick);
      if (changed === soon) changed = null;
      allowListeners.delete(onAllow);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onHide);
      void send(null).catch(() => undefined);
    },
  };
}

/** The freshest position: the <video>'s own clock for movies and episodes (renders may lag behind it). */
export function remotePosition(p: RemoteNowPlaying, video: HTMLVideoElement | null, casting: boolean): number {
  if (p.kind === 'live' || casting || !video) return p.position;
  return Number.isFinite(video.currentTime) ? video.currentTime : p.position;
}

/* ---------------- the Remote button on the phone's Home ---------------- */
export const BUTTON_KEY = 'anycast.remote.homeButton';
export function setRemoteButton(on: boolean) {
  writeLocal(BUTTON_KEY, on ? null : '0');
  allowListeners.forEach((l) => l());
}
export function useRemoteButton(): boolean {
  return useSyncExternalStore(
    (l) => {
      allowListeners.add(l);
      return () => allowListeners.delete(l);
    },
    () => readLocal(BUTTON_KEY) !== '0',
  );
}
