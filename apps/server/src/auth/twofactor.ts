/**
 * Two-step sign-in: an authenticator app (TOTP), one-time recovery codes, and remembered browsers
 * that skip the code step. The TOTP secret is stored encrypted with ANYCAST_SECRET.
 */
import { RECOVERY_CODE_COUNT, TRUSTED_DEVICE_DAYS } from '@anycast/shared';
import { randomInt } from 'node:crypto';
import { decrypt, encrypt, newToken, sha256 } from '../crypto';
import type { Db } from '../db';
import { matchTotp, newTotpSecret, otpauthUri } from './totp';
import { HttpError } from './users';

const PURPOSE = 'two-factor';
export const TRUSTED_COOKIE = 'anycast_trusted';
export const TRUSTED_TTL_MS = TRUSTED_DEVICE_DAYS * 86400_000;
/** no 0/o, 1/l/i: easy to read off paper */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

interface Row { secret: string; enabled_at: number | null; last_step: number }

const recoveryHash = (userId: string, code: string) => sha256(`${userId}\n${code}`);
/** "ab3d-ef7h", "AB3D EF7H" and "ab3def7h" are the same code */
export const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

export class TwoFactor {
  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}

  private row(userId: string): Row | undefined {
    return this.db.prepare('SELECT secret, enabled_at, last_step FROM two_factor WHERE user_id = ?').get(userId) as Row | undefined;
  }

  enabled(userId: string): boolean {
    return this.row(userId)?.enabled_at != null;
  }

  status(userId: string): { enabled: boolean; enabledAt: number | null; recoveryCodesLeft: number } {
    const r = this.row(userId);
    const left = (this.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { n: number }).n;
    return { enabled: r?.enabled_at != null, enabledAt: r?.enabled_at ?? null, recoveryCodesLeft: r?.enabled_at != null ? left : 0 };
  }

  /** A new secret waiting for its first code. Replaces an unfinished setup; refused while enabled. */
  begin(userId: string, account: string): { secret: string; uri: string } {
    if (this.enabled(userId)) throw new HttpError(409, 'already_enabled', 'Two-step sign-in is already on');
    const secret = newTotpSecret();
    this.db
      .prepare(
        `INSERT INTO two_factor (user_id, secret, enabled_at, last_step, created_at) VALUES (?, ?, NULL, 0, ?)
         ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled_at = NULL, last_step = 0, created_at = excluded.created_at`,
      )
      .run(userId, encrypt(this.secret, secret, PURPOSE), this.now());
    return { secret, uri: otpauthUri(secret, account) };
  }

  /** Turns it on with a first code; answers fresh recovery codes. */
  enable(userId: string, code: string): string[] {
    const r = this.row(userId);
    if (!r) throw new HttpError(409, 'no_setup', 'Start the setup first');
    if (r.enabled_at != null) throw new HttpError(409, 'already_enabled', 'Two-step sign-in is already on');
    const step = matchTotp(decrypt(this.secret, r.secret, PURPOSE), code.trim(), this.now(), r.last_step);
    if (step === null) throw new HttpError(400, 'wrong_code', "That code didn't match. Check the time on your phone and try the newest code.");
    let codes: string[] = [];
    this.db.transaction(() => {
      this.db.prepare('UPDATE two_factor SET enabled_at = ?, last_step = ? WHERE user_id = ?').run(this.now(), step, userId);
      codes = this.newRecoveryCodes(userId);
    })();
    return codes;
  }

  disable(userId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM two_factor WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM trusted_devices WHERE user_id = ?').run(userId);
    })();
  }

  /** Replaces all recovery codes; answers them in plain text (the server keeps only hashes). */
  newRecoveryCodes(userId: string): string[] {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      let c = '';
      for (let i = 0; i < 8; i++) c += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
      return `${c.slice(0, 4)}-${c.slice(4)}`;
    });
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
      const ins = this.db.prepare('INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)');
      for (const c of codes) ins.run(userId, recoveryHash(userId, normalizeRecovery(c)));
    })();
    return codes;
  }

  /**
   * Checks a code from the authenticator (6 digits) or a recovery code (8 letters and digits; it is
   * used up). Answers what matched, or null.
   */
  verify(userId: string, input: string): 'totp' | 'recovery' | null {
    const r = this.row(userId);
    if (!r || r.enabled_at == null) return null;
    const code = input.replace(/\s/g, '');
    if (/^\d{6}$/.test(code)) {
      const step = matchTotp(decrypt(this.secret, r.secret, PURPOSE), code, this.now(), r.last_step);
      if (step === null) return null;
      // only the first use of a step counts (two requests racing for the same code: one wins)
      const ok = this.db.prepare('UPDATE two_factor SET last_step = ? WHERE user_id = ? AND last_step < ?').run(step, userId, step).changes === 1;
      return ok ? 'totp' : null;
    }
    const rc = normalizeRecovery(code);
    if (rc.length !== 8) return null;
    const used = this.db
      .prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
      .run(this.now(), userId, recoveryHash(userId, rc)).changes;
    return used === 1 ? 'recovery' : null;
  }

  /* ---------------- remembered browsers ---------------- */

  trust(userId: string, label: string | null): string {
    const token = newToken();
    const now = this.now();
    this.db
      .prepare('INSERT INTO trusted_devices (token_hash, user_id, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), userId, label, now, now, now + TRUSTED_TTL_MS);
    this.db.prepare('DELETE FROM trusted_devices WHERE expires_at < ?').run(now);
    return token;
  }

  /** Whether this browser's remembered token belongs to the user (and is still valid). */
  isTrusted(userId: string, token: string | undefined): boolean {
    if (!token) return false;
    const now = this.now();
    return this.db
      .prepare('UPDATE trusted_devices SET last_used_at = ? WHERE token_hash = ? AND user_id = ? AND expires_at > ?')
      .run(now, sha256(token), userId, now).changes === 1;
  }

  trustedCount(userId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM trusted_devices WHERE user_id = ? AND expires_at > ?').get(userId, this.now()) as { n: number }).n;
  }

  forgetTrusted(userId: string): void {
    this.db.prepare('DELETE FROM trusted_devices WHERE user_id = ?').run(userId);
  }
}
