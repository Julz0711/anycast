/**
 * Signing in from the internet and signed-in devices (Settings › Security).
 *
 * From the home network or Tailscale, a password signs in. From the internet it doesn't (403
 * outside_needs_approval, unless ANYCAST_PASSWORD_OUTSIDE): there a device (a TV) signs in with a
 * code. POST /api/auth/device/start shows the code, a signed-in phone approves it at /approve?code=…,
 * and the device's polling of POST /api/auth/device/poll then signs it in.
 */
import type { Me } from './api';

/** How long a TV's sign-in code waits for approval */
export const DEVICE_CODE_MS = 10 * 60_000;
export const DEVICE_POLL_MS = 2000;

/**
 * Login errors (besides 400/401 invalid_login):
 *   403 outside_needs_approval  a password from the internet: sign in with a code instead
 *   429 locked_out              too many wrong tries; `retryAfter` seconds
 */
export interface AuthError {
  error: 'outside_needs_approval' | 'locked_out' | 'invalid_login';
  message: string;
  retryAfter?: number;
}

export interface SignedInDevice {
  id: string;
  /** e.g. "Chrome on Mac", from the device that signed in */
  label: string | null;
  createdAt: number;
  lastSeenAt: number;
  /** the address it was last seen from, and whether that is the home network (or Tailscale) */
  ip: string | null;
  outside: boolean;
  /** how it signed in: password, or approved from another device */
  method: 'password' | 'approved' | null;
  current: boolean;
}

export interface SecurityStatus {
  devices: SignedInDevice[];
  /** this request: where the server sees it coming from */
  here: { ip: string; outside: boolean };
  /** a password alone also signs in from the internet (ANYCAST_PASSWORD_OUTSIDE) */
  passwordFromInternet: boolean;
}

export interface DeviceCodeStart {
  /** shown on the TV, e.g. "KDQ7-M2XP" */
  code: string;
  /** only the TV knows it: it polls with it */
  pollToken: string;
  expiresAt: number;
}
export type DeviceCodePoll =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; me: Me };

/** What the approving phone sees about the device asking to sign in */
export interface DeviceCodeInfo {
  code: string;
  label: string | null;
  ip: string;
  outside: boolean;
  createdAt: number;
  expiresAt: number;
}

/** Normalizes a typed device code: upper case, no spaces or dash, then "XXXX-XXXX". */
export function normalizeDeviceCode(input: string): string {
  const c = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}
