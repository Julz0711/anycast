/**
 * Parental lock on the client: the profile's AdultStatus, the PIN prompt (one at a time) and the
 * unlock / lock actions. The server enforces everything; this only asks for the PIN and refreshes
 * lists when what the profile may see changes.
 */
import { create } from 'zustand';
import type { AdultStatus, Category } from '@anycast/shared';
import { call, clearApiCache, errorMessage } from '../api/client';
import { useApp } from './app';
import { toast } from './actions';

export interface PinPrompt {
  title: string;
  subtitle?: string;
  submitLabel?: string;
  /** false for entering a new PIN: a PIN lockout does not apply */
  checksPin?: boolean;
  /** Runs with the entered PIN. Throw (an ApiError with a PinError body) to shake and stay open. */
  submit: (pin: string) => Promise<void>;
  resolve: (ok: boolean) => void;
  id: number;
}

interface ParentalState {
  status: AdultStatus | null;
  prompt: PinPrompt | null;
}

export const useParental = create<ParentalState>(() => ({ status: null, prompt: null }));
const get = useParental.getState;
const set = useParental.setState;

/** Lists refetch: what the profile may see changed. */
export function refreshCatalog() {
  clearApiCache();
  useApp.setState((s) => ({ catalogVersion: s.catalogVersion + 1 }));
}

let expiry: ReturnType<typeof setTimeout> | undefined;
let loadedFor: string | null = null;

export function setAdultStatus(status: AdultStatus) {
  set({ status });
  clearTimeout(expiry);
  if (status.unlocked && status.unlockedUntil) {
    // the server ends the unlock on its own; follow it so placeholders come back without a reload
    const ms = Math.min(2 ** 31 - 1, Math.max(0, status.unlockedUntil - Date.now()) + 500);
    expiry = setTimeout(() => void loadAdult({ refresh: true }), ms);
  }
}

export async function loadAdult(opts: { refresh?: boolean } = {}) {
  const pid = useApp.getState().profileId;
  if (pid !== loadedFor) {
    loadedFor = pid;
    clearTimeout(expiry);
    set({ status: null });
  }
  if (!pid) return;
  try {
    const status = await call('GET /api/adult');
    if (useApp.getState().profileId !== pid) return;
    const before = get().status;
    setAdultStatus(status);
    if (opts.refresh || (before && (before.mode !== status.mode || before.unlocked !== status.unlocked))) refreshCatalog();
  } catch {
    /* offline: the server still enforces the lock */
  }
}

/** Opens the PIN dialog; resolves true once `submit` succeeded, false when cancelled. */
let promptSeq = 0;
export function askPin(opts: Omit<PinPrompt, 'resolve' | 'id'>): Promise<boolean> {
  return new Promise((resolve) => {
    get().prompt?.resolve(false);
    set({ prompt: { ...opts, resolve, id: ++promptSeq } });
  });
}

export function closePrompt(ok: boolean) {
  const p = get().prompt;
  set({ prompt: null });
  p?.resolve(ok);
}

/** Locked categories and items: the category chip or item shows a lock and asks for the PIN first. */
export const isLockedCategory = (c: Pick<Category, 'locked'>) => c.locked === true;

let pending: Promise<boolean> | null = null;

/**
 * Makes sure locked adult content is unlocked on this device, asking for the PIN if needed.
 * `force`: the server just refused (403 adult_locked), whatever the cached status says.
 */
export function requireUnlock(opts: { force?: boolean } = {}): Promise<boolean> {
  const st = get().status;
  if (!opts.force && st && (st.mode === 'shown' || st.unlocked)) return Promise.resolve(true);
  if (st && st.mode === 'hidden') return Promise.resolve(false);
  pending ??= askPin({
    title: 'Enter PIN',
    subtitle: 'Adult content is locked on this profile.',
    submitLabel: 'Unlock',
    submit: async (pin) => {
      setAdultStatus(await call('POST /api/adult/unlock', { body: { pin } }));
    },
  }).then((ok) => {
    pending = null;
    if (ok) refreshCatalog();
    return ok;
  });
  return pending;
}

/** Runs `action` once the content is unlocked (right away when it is not locked). */
export function whenUnlocked(locked: boolean | undefined, action: () => void) {
  if (!locked) return action();
  void requireUnlock().then((ok) => ok && action());
}

export async function lockNow() {
  try {
    setAdultStatus(await call('POST /api/adult/lock'));
    refreshCatalog();
    toast('Adult content is locked again.');
  } catch (e) {
    toast(`Couldn't lock: ${errorMessage(e)}`, 'error');
  }
}
