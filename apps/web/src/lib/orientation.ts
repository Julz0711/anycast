/**
 * Phones keep the app upright and let only the player turn sideways, as video apps do.
 *
 * A web app can't hold that everywhere: an installed app on Android may lock the screen
 * (`screen.orientation.lock`), and any phone may lock it to landscape while a video is full
 * screen, but iOS has no lock at all. So the app also watches how the phone is held, and when it
 * is sideways outside the player it shows a "turn your phone upright" screen instead of the page.
 */
import { useSyncExternalStore } from 'react';
import { PHONE_MAX_SHORT_SIDE } from './device';

/** A phone in the hand: touch is the only pointer and the screen is phone-sized (not a narrow desktop window). */
export function isHandheld(): boolean {
  if (typeof matchMedia !== 'function' || typeof screen !== 'object' || !screen.width) return false;
  return matchMedia('(hover: none) and (pointer: coarse)').matches && Math.min(screen.width, screen.height) < PHONE_MAX_SHORT_SIDE;
}

/**
 * Is the device held sideways? From the screen, not the window, so an on-screen keyboard that
 * shortens the window (some Android browsers) does not count as turning the phone.
 */
export function sidewaysFrom(env: { orientationType?: string; windowOrientation?: number; width: number; height: number }): boolean {
  if (env.orientationType) return env.orientationType.startsWith('landscape');
  if (typeof env.windowOrientation === 'number') return Math.abs(env.windowOrientation) === 90;
  return env.width > env.height;
}

function readSideways(): boolean {
  return sidewaysFrom({
    orientationType: screen.orientation?.type,
    windowOrientation: (window as { orientation?: number }).orientation,
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

function subscribe(on: () => void) {
  const so = screen.orientation;
  so?.addEventListener?.('change', on);
  window.addEventListener('orientationchange', on);
  window.addEventListener('resize', on);
  return () => {
    so?.removeEventListener?.('change', on);
    window.removeEventListener('orientationchange', on);
    window.removeEventListener('resize', on);
  };
}

export function useSideways(): boolean {
  return useSyncExternalStore(subscribe, readSideways, () => false);
}

type Lockable = ScreenOrientation & { lock?: (o: 'portrait' | 'landscape') => Promise<void>; unlock?: () => void };

/** Lock the screen where the browser lets us (installed Android apps, full screen); elsewhere nothing happens. */
export function lockOrientation(to: 'portrait' | 'landscape' | null) {
  const so = (typeof screen === 'object' ? screen.orientation : undefined) as Lockable | undefined;
  if (!so) return;
  try {
    if (to) void so.lock?.(to)?.catch(() => undefined);
    else so.unlock?.();
  } catch {
    // not supported here (iOS, desktop browsers)
  }
}
