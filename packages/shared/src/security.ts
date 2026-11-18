/**
 * Two-step sign-in and signed-in devices (Settings › Security).
 *
 * Sign-in: POST /api/auth/login answers Me, or `{ twoFactor }` when the account has two-step sign-in
 * and this browser isn't remembered. The code then goes to POST /api/auth/2fa with the challenge.
 *
 * A TV signs in without typing: POST /api/auth/device/start shows a code, a signed-in phone approves
 * it at /approve?code=…, and the TV's polling of POST /api/auth/device/poll then signs it in.
 */
import type { Me } from './api';

/** The code step of a sign-in: valid for TWO_FACTOR_CHALLENGE_MS, a few tries. */
export interface TwoFactorChallenge {
  twoFactor: { challenge: string; expiresAt: number };
}
export type LoginResult = Me | TwoFactorChallenge;
export const isTwoFactorChallenge = (r: LoginResult): r is TwoFactorChallenge => 'twoFactor' in r;

export const TWO_FACTOR_CHALLENGE_MS = 5 * 60_000;
/** "Remember this device": how long a browser skips the code step */
export const TRUSTED_DEVICE_DAYS = 180;
export const RECOVERY_CODE_COUNT = 10;
/** How long a TV's sign-in code waits for approval */
export const DEVICE_CODE_MS = 10 * 60_000;
export const DEVICE_POLL_MS = 2000;

/**
 * Login errors (besides 400/401):
 *   403 two_factor_required  this account has no two-step sign-in and the request comes from the internet
 *   429 locked_out           too many wrong tries; `retryAfter` seconds
 *   401 wrong_code           a wrong code in the code step; `attemptsLeft`
 *   410 challenge_expired    the code step took too long or had too many wrong tries: sign in again
 */
export interface AuthError {
  error: 'two_factor_required' | 'locked_out' | 'wrong_code' | 'challenge_expired' | 'invalid_login' | 'wrong_password';
  message: string;
  attemptsLeft?: number;
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
  /** how it signed in: password, password + code, approved from another device */
  method: 'password' | 'two_factor' | 'trusted' | 'approved' | null;
  current: boolean;
}

export interface SecurityStatus {
  twoFactor: { enabled: boolean; enabledAt: number | null; recoveryCodesLeft: number };
  /** browsers that skip the code step */
  trustedDevices: number;
  devices: SignedInDevice[];
  /** this request: where the server sees it coming from */
  here: { ip: string; outside: boolean };
  /** sign-ins from the internet need two-step sign-in (ANYCAST_2FA_OUTSIDE) */
  outsideNeedsTwoFactor: boolean;
}

export interface TwoFactorSetup {
  /** base32, for typing into an authenticator by hand */
  secret: string;
  /** otpauth:// link, shown as a QR code */
  uri: string;
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
