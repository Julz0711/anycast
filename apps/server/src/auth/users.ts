/** Users, sessions (hashed tokens, 90 days) and profiles (pictures, profile lock). */
import {
  defaultAvatar, isValidPin, parseAvatar, PIN_MAX_ATTEMPTS, PIN_WINDOW_MS, PROFILE_IMAGE, PROFILES_MAX, type Me, type PinError, type Profile,
} from '@anycast/shared';
import { hash, verify } from '@node-rs/argon2';
import { newId, newToken, sha256 } from '../crypto';
import type { Db } from '../db';
import { ParentalError } from '../parental';

interface ProfileRow { id: string; name: string; avatar: string | null; locked: number; image_at: number | null; entered: number }

const toProfile = (r: ProfileRow): Profile => ({
  id: r.id,
  name: r.name,
  avatar: r.avatar,
  image: r.image_at === null ? null : `/api/profiles/${r.id}/image?v=${r.image_at}`,
  locked: r.locked === 1,
  needsPin: r.locked === 1 && r.entered !== 1,
});

/** The type of an image from its first bytes (WebP, JPEG, PNG), or null. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

export const SESSION_COOKIE = 'anycast_session';
export const SESSION_TTL_MS = 90 * 86400_000;

export interface UserRow { id: string; username: string; password_hash: string; is_admin: number }

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Users {
  constructor(private readonly db: Db) {}

  async create(username: string, password: string, isAdmin: boolean): Promise<UserRow> {
    const id = newId();
    const passwordHash = await hash(password);
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, username, passwordHash, isAdmin ? 1 : 0, Date.now());
      this.createProfile(id, username);
    })();
    return this.byId(id)!;
  }

  hasUsers(): boolean {
    return this.db.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined;
  }

  /** First start: create the admin from env when no user exists. */
  async ensureAdmin(admin: { username: string; password: string } | null): Promise<void> {
    if (!this.hasUsers() && admin) await this.create(admin.username, admin.password, true);
  }

  byId(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  async verifyLogin(username: string, password: string): Promise<UserRow | null> {
    const user = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    if (!user) {
      // equalize timing with a real verification
      await hash(password).catch(() => undefined);
      return null;
    }
    return (await verify(user.password_hash, password).catch(() => false)) ? user : null;
  }

  createSession(userId: string): string {
    const token = newToken();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, now, now + SESSION_TTL_MS);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    return token;
  }

  userForSession(token: string): UserRow | null {
    const row = this.db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
      .get(sha256(token), Date.now()) as UserRow | undefined;
    return row ?? null;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  /* ---------------- profiles ---------------- */

  /** The account's profiles, as seen from one sign-in session (`needsPin`). */
  profiles(userId: string, token?: string): Profile[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name, p.avatar, p.lock_hash IS NOT NULL AS locked, i.updated_at AS image_at,
           EXISTS (SELECT 1 FROM profile_entries e WHERE e.profile_id = p.id AND e.session_hash = ?) AS entered
         FROM profiles p LEFT JOIN profile_images i ON i.profile_id = p.id
         WHERE p.user_id = ? ORDER BY p.created_at, p.rowid`,
      )
      .all(token ? sha256(token) : '', userId) as ProfileRow[];
    return rows.map(toProfile);
  }

  profile(userId: string, id: string, token?: string): Profile {
    const p = this.profiles(userId, token).find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'not_found', 'Profile not found');
    return p;
  }

  createProfile(userId: string, name: string, avatar?: string | null): Profile {
    const id = newId();
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?').get(userId) as { n: number }).n;
    if (count >= PROFILES_MAX) throw new HttpError(409, 'too_many', `An account can have up to ${PROFILES_MAX} profiles`);
    const pic = avatar === undefined ? defaultAvatar(count) : avatar;
    if (pic !== null && !parseAvatar(pic)) throw new HttpError(400, 'bad_request', 'Unknown picture');
    this.db.prepare('INSERT INTO profiles (id, user_id, name, avatar, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, name, pic, Date.now());
    return this.profile(userId, id);
  }

  /** Throws 403 profile_locked unless the profile is unlocked or entered on this session. */
  assertCanChange(userId: string, id: string, token: string): Profile {
    const p = this.profile(userId, id, token);
    if (p.needsPin) throw new HttpError(403, 'profile_locked', 'Enter the profile PIN first');
    return p;
  }

  updateProfile(userId: string, id: string, token: string, patch: { name?: string; avatar?: string | null }): Profile {
    this.assertCanChange(userId, id, token);
    if (patch.avatar !== undefined && patch.avatar !== null && !parseAvatar(patch.avatar)) throw new HttpError(400, 'bad_request', 'Unknown picture');
    this.db.transaction(() => {
      if (patch.name !== undefined) this.db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(patch.name, id);
      if (patch.avatar !== undefined) {
        this.db.prepare('UPDATE profiles SET avatar = ? WHERE id = ?').run(patch.avatar, id);
        this.db.prepare('DELETE FROM profile_images WHERE profile_id = ?').run(id);
      }
    })();
    return this.profile(userId, id, token);
  }

  /** Stores an uploaded picture after checking that the bytes are what the type says. */
  setImage(userId: string, id: string, token: string, type: unknown, data: unknown): Profile {
    this.assertCanChange(userId, id, token);
    if (typeof type !== 'string' || !(PROFILE_IMAGE.types as readonly string[]).includes(type)) {
      throw new HttpError(400, 'bad_request', 'The picture must be a WebP, JPEG or PNG image');
    }
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, 'bad_request', 'The picture data is not base64');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > PROFILE_IMAGE.maxBytes) throw new HttpError(413, 'too_large', 'The picture is too large');
    if (sniffImage(bytes) !== type) throw new HttpError(400, 'bad_request', 'The picture is not a valid image');
    this.db
      .prepare(
        `INSERT INTO profile_images (profile_id, mime, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(id, type, bytes, Date.now());
    return this.profile(userId, id, token);
  }

  removeImage(userId: string, id: string, token: string): Profile {
    this.assertCanChange(userId, id, token);
    this.db.prepare('DELETE FROM profile_images WHERE profile_id = ?').run(id);
    return this.profile(userId, id, token);
  }

  image(userId: string, id: string): { mime: string; data: Buffer; updatedAt: number } | null {
    const r = this.db
      .prepare('SELECT i.mime, i.data, i.updated_at AS updatedAt FROM profile_images i JOIN profiles p ON p.id = i.profile_id WHERE i.profile_id = ? AND p.user_id = ?')
      .get(id, userId) as { mime: string; data: Buffer; updatedAt: number } | undefined;
    return r ?? null;
  }

  deleteProfile(userId: string, id: string, token: string): void {
    this.db.transaction(() => {
      const list = this.profiles(userId, token);
      const p = list.find((x) => x.id === id);
      if (!p) throw new HttpError(404, 'not_found', 'Profile not found');
      if (p.needsPin) throw new HttpError(403, 'profile_locked', 'Enter the profile PIN first');
      if (list.length <= 1) throw new HttpError(409, 'last_profile', 'The last profile cannot be deleted');
      this.db.prepare('DELETE FROM profiles WHERE id = ? AND user_id = ?').run(id, userId);
    })();
    this.failures.delete(id);
  }

  /* ---------------- profile lock ---------------- */

  /** Whether this session may act as the profile (unlocked, or entered with the PIN). */
  canUse(profileId: string, token: string): boolean {
    const r = this.db
      .prepare(
        `SELECT p.lock_hash IS NULL OR EXISTS (SELECT 1 FROM profile_entries e WHERE e.profile_id = p.id AND e.session_hash = ?) AS ok
         FROM profiles p WHERE p.id = ?`,
      )
      .get(sha256(token), profileId) as { ok: number } | undefined;
    return r?.ok === 1;
  }

  private lockHash(userId: string, id: string): string | null {
    const r = this.db.prepare('SELECT lock_hash FROM profiles WHERE id = ? AND user_id = ?').get(id, userId) as { lock_hash: string | null } | undefined;
    if (!r) throw new HttpError(404, 'not_found', 'Profile not found');
    return r.lock_hash;
  }

  /**
   * Opens a profile on this session. A locked one needs its PIN unless this session already entered
   * it; a PIN that is sent is always checked.
   */
  async enter(userId: string, id: string, token: string, pin: unknown): Promise<Profile> {
    const hashed = this.lockHash(userId, id);
    if (hashed) {
      const given = pin !== undefined && pin !== null && pin !== '';
      if (given || !this.canUse(id, token)) {
        await this.checkPin(id, hashed, pin);
        this.db
          .prepare('INSERT OR IGNORE INTO profile_entries (session_hash, profile_id, created_at) VALUES (?, ?, ?)')
          .run(sha256(token), id, Date.now());
      }
    }
    return this.profile(userId, id, token);
  }

  /** Ends this session's entries (but `keep`'s): locked profiles ask for their PIN again. */
  leave(token: string, keep?: string): void {
    this.db.prepare('DELETE FROM profile_entries WHERE session_hash = ? AND profile_id != ?').run(sha256(token), keep ?? '');
  }

  async setLock(user: UserRow, id: string, token: string, body: { pin?: unknown; currentPin?: unknown; password?: unknown }): Promise<Profile> {
    const current = this.lockHash(user.id, id);
    if (body.pin !== null && !isValidPin(body.pin)) throw this.pinError(400, 'bad_pin', 'The PIN is 4 to 6 digits.', id);
    if (current) {
      if (typeof body.password === 'string' && body.password) await this.checkPassword(id, user, body.password);
      else await this.checkPin(id, current, body.currentPin);
    } else if (!this.canUse(id, token)) {
      throw new HttpError(403, 'profile_locked', 'Enter the profile PIN first');
    }
    const next = body.pin === null ? null : await hash(body.pin as string);
    const sessionHash = sha256(token);
    this.db.transaction(() => {
      this.db.prepare('UPDATE profiles SET lock_hash = ? WHERE id = ?').run(next, id);
      // other devices need the new PIN; this one keeps the profile open
      this.db.prepare('DELETE FROM profile_entries WHERE profile_id = ? AND session_hash != ?').run(id, sessionHash);
      if (next) this.db.prepare('INSERT OR IGNORE INTO profile_entries (session_hash, profile_id, created_at) VALUES (?, ?, ?)').run(sessionHash, id, Date.now());
    })();
    return this.profile(user.id, id, token);
  }

  /* ---------- wrong PIN attempts (per profile, like the parental PIN) ---------- */

  private readonly failures = new Map<string, number[]>();

  private attempts(id: string): { attemptsLeft: number; lockedOutUntil: number | null } {
    const since = Date.now() - PIN_WINDOW_MS;
    const list = (this.failures.get(id) ?? []).filter((t) => t > since);
    if (list.length) this.failures.set(id, list);
    else this.failures.delete(id);
    const attemptsLeft = Math.max(0, PIN_MAX_ATTEMPTS - list.length);
    return { attemptsLeft, lockedOutUntil: attemptsLeft === 0 ? list[list.length - PIN_MAX_ATTEMPTS]! + PIN_WINDOW_MS : null };
  }

  private pinError(status: number, error: PinError['error'], message: string, id: string): ParentalError {
    const body: PinError = { error, message, ...this.attempts(id) };
    return new ParentalError(status, body as unknown as ParentalError['body']);
  }

  private lockedOut(id: string): ParentalError | null {
    const a = this.attempts(id);
    if (a.lockedOutUntil === null) return null;
    const mins = Math.max(1, Math.ceil((a.lockedOutUntil - Date.now()) / 60_000));
    return this.pinError(429, 'pin_locked_out', `Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, id);
  }

  private fail(id: string, what: 'wrong_pin' | 'wrong_password'): ParentalError {
    this.failures.set(id, [...(this.failures.get(id) ?? []), Date.now()]);
    const out = this.lockedOut(id);
    if (out) return out;
    const left = this.attempts(id).attemptsLeft;
    return this.pinError(403, what, `${what === 'wrong_pin' ? 'Wrong PIN' : 'Wrong password'}. ${left} attempt${left === 1 ? '' : 's'} left.`, id);
  }

  private async checkPin(id: string, hashed: string, pin: unknown): Promise<void> {
    if (pin === undefined || pin === null || pin === '') throw this.pinError(409, 'pin_required', 'Enter the profile PIN.', id);
    const out = this.lockedOut(id);
    if (out) throw out;
    if (!(isValidPin(pin) && (await verify(hashed, pin).catch(() => false)))) throw this.fail(id, 'wrong_pin');
    this.failures.delete(id);
  }

  private async checkPassword(id: string, user: UserRow, password: string): Promise<void> {
    const out = this.lockedOut(id);
    if (out) throw out;
    if (!(password.length <= 500 && (await verify(user.password_hash, password).catch(() => false)))) throw this.fail(id, 'wrong_password');
    this.failures.delete(id);
  }

  me(user: UserRow, token?: string): Me {
    return {
      user: { id: user.id, username: user.username, isAdmin: user.is_admin === 1 },
      profiles: this.profiles(user.id, token),
    };
  }
}
