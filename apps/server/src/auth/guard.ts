/**
 * Wrong-password limits, on top of the per-route request rate limit:
 * - per address: IP_MAX failures in IP_WINDOW_MS lock that address out for the rest of the window;
 * - per account, from the internet only: ACCOUNT_MAX failures in ACCOUNT_WINDOW_MS stop sign-ins
 *   to that account from the internet for the rest of the window. The home network (and Tailscale)
 *   can still sign in, so someone guessing from outside can't lock the owner out at home.
 * Kept in memory: a restart clears it, which is fine for a home server.
 */
import { isHomeAddress } from './net';

export const IP_MAX = 10;
export const IP_WINDOW_MS = 15 * 60_000;
export const ACCOUNT_MAX = 20;
export const ACCOUNT_WINDOW_MS = 60 * 60_000;
const MAX_KEYS = 10_000;

export class SignInGuard {
  private readonly byIp = new Map<string, number[]>();
  private readonly byAccount = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private recent(map: Map<string, number[]>, key: string, window: number): number[] {
    const since = this.now() - window;
    const list = (map.get(key) ?? []).filter((t) => t > since);
    if (list.length) map.set(key, list);
    else map.delete(key);
    return list;
  }

  /** Seconds until this address or account may try again, or 0. `account` is the lower-cased username. */
  retryAfter(ip: string, account?: string): number {
    const now = this.now();
    let until = 0;
    const ipList = this.recent(this.byIp, ip, IP_WINDOW_MS);
    if (ipList.length >= IP_MAX) until = Math.max(until, ipList[ipList.length - IP_MAX]! + IP_WINDOW_MS);
    if (account && !isHomeAddress(ip)) {
      const acc = this.recent(this.byAccount, account, ACCOUNT_WINDOW_MS);
      if (acc.length >= ACCOUNT_MAX) until = Math.max(until, acc[acc.length - ACCOUNT_MAX]! + ACCOUNT_WINDOW_MS);
    }
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }

  fail(ip: string, account?: string): void {
    const now = this.now();
    this.push(this.byIp, ip, now);
    if (account && !isHomeAddress(ip)) this.push(this.byAccount, account, now);
  }

  /** A good sign-in clears the address's count (not the account's: that one counts the internet). */
  succeed(ip: string): void {
    this.byIp.delete(ip);
  }

  private push(map: Map<string, number[]>, key: string, t: number) {
    if (!map.has(key) && map.size >= MAX_KEYS) map.delete(map.keys().next().value!);
    map.set(key, [...(map.get(key) ?? []), t].slice(-50));
  }
}
