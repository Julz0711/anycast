/**
 * Sign-ins in progress, kept in memory: the code step after a good password, and TVs waiting for a
 * signed-in device to approve their code. Both are short-lived; a restart just means starting over.
 */
import { DEVICE_CODE_MS, TWO_FACTOR_CHALLENGE_MS } from '@anycast/shared';
import { randomInt } from 'node:crypto';
import { newToken, sha256 } from '../crypto';

export const CHALLENGE_TRIES = 5;
const MAX_PENDING = 200;
/** no 0/O, 1/I/L: easy to read off a TV across the room */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

interface Challenge { userId: string; expiresAt: number; triesLeft: number; label: string | null }

export class Challenges {
  private readonly map = new Map<string, Challenge>();
  constructor(private readonly now: () => number = Date.now) {}

  create(userId: string, label: string | null): { challenge: string; expiresAt: number } {
    this.prune();
    const challenge = newToken();
    const expiresAt = this.now() + TWO_FACTOR_CHALLENGE_MS;
    this.map.set(sha256(challenge), { userId, expiresAt, triesLeft: CHALLENGE_TRIES, label });
    return { challenge, expiresAt };
  }

  get(challenge: string): Challenge | null {
    const c = this.map.get(sha256(challenge));
    if (!c || c.expiresAt <= this.now() || c.triesLeft <= 0) return null;
    return c;
  }

  /** Counts a wrong code; answers the tries left (0: the challenge is gone). */
  miss(challenge: string): number {
    const key = sha256(challenge);
    const c = this.map.get(key);
    if (!c) return 0;
    c.triesLeft--;
    if (c.triesLeft <= 0) this.map.delete(key);
    return Math.max(0, c.triesLeft);
  }

  done(challenge: string): void {
    this.map.delete(sha256(challenge));
  }

  private prune() {
    const now = this.now();
    for (const [k, c] of this.map) if (c.expiresAt <= now) this.map.delete(k);
    while (this.map.size >= MAX_PENDING) this.map.delete(this.map.keys().next().value!);
  }
}

interface DeviceRequest {
  code: string;
  pollHash: string;
  label: string | null;
  ip: string;
  createdAt: number;
  expiresAt: number;
  approvedBy: string | null;
  denied: boolean;
}

export class DeviceCodes {
  private readonly byCode = new Map<string, DeviceRequest>();
  constructor(private readonly now: () => number = Date.now) {}

  start(label: string | null, ip: string): { code: string; pollToken: string; expiresAt: number } {
    this.prune();
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      code = `${code.slice(0, 4)}-${code.slice(4)}`;
    } while (this.byCode.has(code));
    const pollToken = newToken();
    const now = this.now();
    const expiresAt = now + DEVICE_CODE_MS;
    this.byCode.set(code, { code, pollHash: sha256(pollToken), label, ip, createdAt: now, expiresAt, approvedBy: null, denied: false });
    return { code, pollToken, expiresAt };
  }

  /** A waiting request by its code (for the approving device), or null */
  get(code: string): DeviceRequest | null {
    const r = this.byCode.get(code);
    return r && r.expiresAt > this.now() && !r.approvedBy && !r.denied ? r : null;
  }

  approve(code: string, userId: string): boolean {
    const r = this.get(code);
    if (!r) return false;
    r.approvedBy = userId;
    return true;
  }

  deny(code: string): boolean {
    const r = this.get(code);
    if (!r) return false;
    r.denied = true;
    return true;
  }

  /**
   * The TV's poll. 'approved' answers the user once and forgets the request, so the sign-in can't
   * be picked up twice.
   */
  poll(pollToken: string): { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; userId: string; label: string | null } {
    const hash = sha256(pollToken);
    for (const [code, r] of this.byCode) {
      if (r.pollHash !== hash) continue;
      if (r.approvedBy) {
        this.byCode.delete(code);
        return { status: 'approved', userId: r.approvedBy, label: r.label };
      }
      if (r.denied) {
        this.byCode.delete(code);
        return { status: 'denied' };
      }
      if (r.expiresAt <= this.now()) {
        this.byCode.delete(code);
        return { status: 'expired' };
      }
      return { status: 'pending' };
    }
    return { status: 'expired' };
  }

  private prune() {
    const now = this.now();
    // approved requests the TV never picked up go too
    for (const [k, r] of this.byCode) if (r.expiresAt <= now) this.byCode.delete(k);
    while (this.byCode.size >= MAX_PENDING) this.byCode.delete(this.byCode.keys().next().value!);
  }
}
