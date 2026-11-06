/** Users, sessions (hashed tokens, 90 days) and profiles. */
import type { Me, Profile } from '@anycast/shared';
import { hash, verify } from '@node-rs/argon2';
import { newId, newToken, sha256 } from '../crypto';
import type { Db } from '../db';

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

  profiles(userId: string): Profile[] {
    return this.db.prepare('SELECT id, name FROM profiles WHERE user_id = ? ORDER BY created_at, rowid').all(userId) as Profile[];
  }

  createProfile(userId: string, name: string): Profile {
    const id = newId();
    this.db.prepare('INSERT INTO profiles (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, userId, name, Date.now());
    return { id, name };
  }

  renameProfile(userId: string, id: string, name: string): Profile {
    const r = this.db.prepare('UPDATE profiles SET name = ? WHERE id = ? AND user_id = ?').run(name, id, userId);
    if (!r.changes) throw new HttpError(404, 'not_found', 'Profile not found');
    return { id, name };
  }

  deleteProfile(userId: string, id: string): void {
    this.db.transaction(() => {
      const list = this.profiles(userId);
      if (!list.some((p) => p.id === id)) throw new HttpError(404, 'not_found', 'Profile not found');
      if (list.length <= 1) throw new HttpError(409, 'last_profile', 'The last profile cannot be deleted');
      this.db.prepare('DELETE FROM profiles WHERE id = ? AND user_id = ?').run(id, userId);
    })();
  }

  me(user: UserRow): Me {
    return {
      user: { id: user.id, username: user.username, isAdmin: user.is_admin === 1 },
      profiles: this.profiles(user.id),
    };
  }
}
