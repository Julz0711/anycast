/**
 * Parental lock for adult content (PRD AC-3), per profile. See packages/shared/src/parental.ts.
 *
 * Settings and the PIN's argon2 hash live in the `parental` table (never returned). Unlocks are
 * in memory: an httpOnly session cookie `anycast_unlock_<profileId>` holds a random token whose
 * sha256 maps to {session, profile, expiresAt}, so an unlock is per device, ends with the browser
 * session, after `unlockMinutes`, on POST /api/adult/lock, on a PIN change, or on a server restart.
 *
 * Every catalog route asks for an AdultView and passes its items through it: hidden categories
 * join the hide rules (so SQL filters them everywhere, counts included), locked items are masked.
 */
import {
  ADULT_MODE_RANK, DEFAULT_ADULT_MODE, DEFAULT_UNLOCK_MINUTES, isValidPin, LOCKED_NAME, PIN_MAX_ATTEMPTS, PIN_WINDOW_MS, UNLOCK_MINUTES,
  type AdultMode, type AdultStatus, type Category, type EpgProgram, type Episode, type HideRules, type PinError, type UnlockMinutes,
} from '@anycast/shared';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyRequest } from 'fastify';
import type { UserRow } from './auth/users';
import { auth } from './context';
import { newToken, sha256 } from './crypto';
import type { Db } from './db';
import type { EventBus } from './events';

export const UNLOCK_COOKIE_PREFIX = 'anycast_unlock_';
export const unlockCookieName = (profileId: string) => `${UNLOCK_COOKIE_PREFIX}${profileId}`;

/** A refusal with a ready JSON body (AdultLockedError or PinError); the app's error handler sends it as is. */
export class ParentalError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: { error: string; message: string } & Record<string, unknown>,
  ) {
    super(body.message);
  }
}

/** Who is asking: the profile, the sign-in session token and the request cookies. */
export interface ParentalCtx {
  profileId: string;
  token: string;
  cookies: Record<string, string | undefined>;
}

interface Row { mode: AdultMode; unlock_minutes: number; pin_hash: string | null }
interface Unlock { sessionHash: string; profileId: string; expiresAt: number }

type Item = { categoryId: string; locked?: boolean };

/** What one request may see of the adult categories. */
export class AdultView {
  /** adult categories whose items are masked (locked mode, not unlocked here) */
  readonly lockedIds: ReadonlySet<string>;
  /** adult categories that vanish (hidden mode) */
  readonly hiddenIds: readonly string[];

  constructor(
    readonly mode: AdultMode,
    readonly profileId: string,
    readonly adultIds: ReadonlySet<string>,
    readonly unlocked: boolean,
  ) {
    this.hiddenIds = mode === 'hidden' ? [...adultIds] : [];
    this.lockedIds = mode === 'locked' && !unlocked ? adultIds : new Set();
  }

  /**
   * The profile's hide rules plus the hidden adult categories. With `search`, locked categories too:
   * matching on names the profile may not see would reveal them.
   */
  rules(base: HideRules, opts: { search?: boolean } = {}): HideRules {
    const extra = [...this.hiddenIds, ...(opts.search ? this.lockedIds : [])];
    return extra.length ? { ...base, categoryIds: [...base.categoryIds, ...extra] } : base;
  }

  isLocked(categoryId: string): boolean {
    return this.lockedIds.has(categoryId);
  }

  canOpen(categoryId: string | null | undefined): boolean {
    return !categoryId || !this.adultIds.has(categoryId) || this.mode === 'shown' || (this.mode === 'locked' && this.unlocked);
  }

  /** Throws a 403 adult_locked unless the profile may open items of the category. */
  assertOpen(categoryId: string | null | undefined): void {
    if (this.canOpen(categoryId)) return;
    throw new ParentalError(403, {
      error: 'adult_locked',
      mode: this.mode,
      message: this.mode === 'locked' ? 'This is locked. Enter the PIN to open it.' : 'This is not available on this profile.',
    });
  }

  category<C extends Category>(c: C): C {
    return this.lockedIds.has(c.id) ? { ...c, locked: true } : c;
  }

  /** Masks a channel, movie or series of a locked category; adds the profile to visible adult artwork URLs. */
  item<T extends Item & { name: string; rawName: string }>(x: T): T {
    if (this.lockedIds.has(x.categoryId)) {
      const out = { ...x, name: LOCKED_NAME, rawName: LOCKED_NAME, locked: true } as Record<string, unknown>;
      for (const k of ['logo', 'poster', 'plot', 'year', 'rating', 'epgChannelId'] as const) if (k in out) out[k] = null;
      if ('now' in out) out.now = maskProgram(out.now as EpgProgram | null);
      if ('next' in out) out.next = maskProgram(out.next as EpgProgram | null);
      return out as T;
    }
    if (this.adultIds.has(x.categoryId)) {
      // <img> requests carry no profile header: name it in the URL so /api/art checks the right profile
      const out = { ...x } as Record<string, unknown>;
      for (const k of ['logo', 'poster'] as const) {
        if (typeof out[k] === 'string') out[k] = `${out[k] as string}?profile=${encodeURIComponent(this.profileId)}`;
      }
      return out as T;
    }
    return x;
  }

  episode<E extends Episode>(e: E, categoryId: string): E {
    return this.lockedIds.has(categoryId) ? { ...e, title: LOCKED_NAME, plot: null, locked: true } : e;
  }

  programs(list: EpgProgram[], categoryId: string): EpgProgram[] {
    return this.lockedIds.has(categoryId) ? list.map((p) => maskProgram(p)!) : list;
  }
}

function maskProgram(p: EpgProgram | null): EpgProgram | null {
  return p ? { ...p, title: LOCKED_NAME, description: null } : null;
}

const NO_ACCESS = (message: string) => new ParentalError(403, { error: 'forbidden', message });

export class Parental {
  private readonly unlocks = new Map<string, Unlock>();
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  private row(profileId: string): Row {
    const r = this.db.prepare('SELECT mode, unlock_minutes, pin_hash FROM parental WHERE profile_id = ?').get(profileId) as Row | undefined;
    return r ?? { mode: DEFAULT_ADULT_MODE, unlock_minutes: DEFAULT_UNLOCK_MINUTES, pin_hash: null };
  }

  private save(profileId: string, r: Row): void {
    this.db
      .prepare(
        `INSERT INTO parental (profile_id, mode, unlock_minutes, pin_hash, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET mode = excluded.mode, unlock_minutes = excluded.unlock_minutes,
           pin_hash = excluded.pin_hash, updated_at = excluded.updated_at`,
      )
      .run(profileId, r.mode, r.unlock_minutes, r.pin_hash, this.now());
    this.bus.emit({ type: 'parental', profileId });
  }

  adultCategoryIds(): Set<string> {
    return new Set((this.db.prepare('SELECT id FROM categories WHERE adult = 1').all() as { id: string }[]).map((r) => r.id));
  }

  /** The unlock this request's cookie holds for its session and profile, if still valid. */
  private unlockOf(ctx: ParentalCtx): Unlock | null {
    const raw = ctx.cookies[unlockCookieName(ctx.profileId)];
    if (!raw) return null;
    const key = sha256(raw);
    const u = this.unlocks.get(key);
    if (!u) return null;
    if (u.expiresAt <= this.now()) {
      this.unlocks.delete(key);
      return null;
    }
    return u.profileId === ctx.profileId && u.sessionHash === sha256(ctx.token) ? u : null;
  }

  view(ctx: ParentalCtx): AdultView {
    const r = this.row(ctx.profileId);
    const unlocked = r.mode === 'locked' && this.unlockOf(ctx) !== null;
    return new AdultView(r.mode, ctx.profileId, r.mode === 'shown' ? new Set() : this.adultCategoryIds(), unlocked);
  }

  status(ctx: ParentalCtx): AdultStatus {
    const r = this.row(ctx.profileId);
    const u = r.mode === 'locked' ? this.unlockOf(ctx) : null;
    const { attemptsLeft, lockedOutUntil } = this.attempts(ctx.profileId);
    return {
      mode: r.mode,
      hasPin: r.pin_hash !== null,
      unlockMinutes: (UNLOCK_MINUTES as readonly number[]).includes(r.unlock_minutes) ? (r.unlock_minutes as UnlockMinutes) : DEFAULT_UNLOCK_MINUTES,
      unlocked: u !== null,
      unlockedUntil: u?.expiresAt ?? null,
      attemptsLeft,
      lockedOutUntil,
    };
  }

  /* ---------- attempts ---------- */

  private recent(profileId: string): number[] {
    const since = this.now() - PIN_WINDOW_MS;
    const list = (this.failures.get(profileId) ?? []).filter((t) => t > since);
    if (list.length) this.failures.set(profileId, list);
    else this.failures.delete(profileId);
    return list;
  }

  private attempts(profileId: string): { attemptsLeft: number; lockedOutUntil: number | null } {
    const list = this.recent(profileId);
    const attemptsLeft = Math.max(0, PIN_MAX_ATTEMPTS - list.length);
    // locked out until enough failures leave the window to allow one more attempt
    const lockedOutUntil = attemptsLeft === 0 ? list[list.length - PIN_MAX_ATTEMPTS]! + PIN_WINDOW_MS : null;
    return { attemptsLeft, lockedOutUntil };
  }

  private pinError(status: number, error: PinError['error'], message: string, profileId: string): ParentalError {
    const body: PinError = { error, message, ...this.attempts(profileId) };
    return new ParentalError(status, body as unknown as ParentalError['body']);
  }

  private assertNotLockedOut(profileId: string): void {
    const a = this.attempts(profileId);
    if (a.lockedOutUntil === null) return;
    const mins = Math.max(1, Math.ceil((a.lockedOutUntil - this.now()) / 60_000));
    throw this.pinError(429, 'pin_locked_out', `Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, profileId);
  }

  private fail(profileId: string, error: 'wrong_pin' | 'wrong_password'): ParentalError {
    this.failures.set(profileId, [...this.recent(profileId), this.now()]);
    const a = this.attempts(profileId);
    if (a.lockedOutUntil !== null) {
      const mins = Math.max(1, Math.ceil((a.lockedOutUntil - this.now()) / 60_000));
      return this.pinError(429, 'pin_locked_out', `Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, profileId);
    }
    const what = error === 'wrong_pin' ? 'Wrong PIN' : 'Wrong password';
    return this.pinError(403, error, `${what}. ${a.attemptsLeft} attempt${a.attemptsLeft === 1 ? '' : 's'} left.`, profileId);
  }

  /** Verifies the profile's PIN, counting failures; throws a PinError. */
  private async checkPin(profileId: string, r: Row, pin: string | undefined): Promise<void> {
    if (!r.pin_hash) throw this.pinError(409, 'no_pin', 'Set a PIN first.', profileId);
    if (pin === undefined || pin === '') throw this.pinError(409, 'pin_required', 'Enter the PIN to change this.', profileId);
    this.assertNotLockedOut(profileId);
    const ok = isValidPin(pin) && (await verify(r.pin_hash, pin).catch(() => false));
    if (!ok) throw this.fail(profileId, 'wrong_pin');
    this.failures.delete(profileId);
  }

  private async checkPassword(profileId: string, user: UserRow, password: string): Promise<void> {
    this.assertNotLockedOut(profileId);
    const ok = password.length <= 500 && (await verify(user.password_hash, password).catch(() => false));
    if (!ok) throw this.fail(profileId, 'wrong_password');
    this.failures.delete(profileId);
  }

  /* ---------- actions ---------- */

  async unlock(ctx: ParentalCtx, pin: unknown): Promise<{ token: string; status: AdultStatus }> {
    const r = this.row(ctx.profileId);
    if (r.mode !== 'locked') throw this.pinError(409, 'not_locked', 'Adult content is not locked on this profile.', ctx.profileId);
    await this.checkPin(ctx.profileId, r, typeof pin === 'string' ? pin : '');
    this.lock(ctx);
    const token = newToken();
    this.unlocks.set(sha256(token), { sessionHash: sha256(ctx.token), profileId: ctx.profileId, expiresAt: this.now() + r.unlock_minutes * 60_000 });
    for (const [k, u] of this.unlocks) if (u.expiresAt <= this.now()) this.unlocks.delete(k);
    return { token, status: this.status({ ...ctx, cookies: { ...ctx.cookies, [unlockCookieName(ctx.profileId)]: token } }) };
  }

  /** Ends this session's unlocks of the profile. */
  lock(ctx: ParentalCtx): void {
    const sessionHash = sha256(ctx.token);
    for (const [k, u] of this.unlocks) if (u.profileId === ctx.profileId && u.sessionHash === sessionHash) this.unlocks.delete(k);
  }

  private revokeAll(profileId: string): void {
    for (const [k, u] of this.unlocks) if (u.profileId === profileId) this.unlocks.delete(k);
  }

  async updateSettings(ctx: ParentalCtx, body: { mode?: unknown; unlockMinutes?: unknown; pin?: unknown }): Promise<void> {
    const r = this.row(ctx.profileId);
    const mode = body.mode === undefined ? r.mode : body.mode;
    const minutes = body.unlockMinutes === undefined ? r.unlock_minutes : body.unlockMinutes;
    if (typeof mode !== 'string' || !(mode in ADULT_MODE_RANK)) throw new ParentalError(400, { error: 'bad_request', message: 'mode is hidden, locked or shown' });
    if (!(UNLOCK_MINUTES as readonly unknown[]).includes(minutes)) {
      throw new ParentalError(400, { error: 'bad_request', message: `unlockMinutes is one of ${UNLOCK_MINUTES.join(', ')}` });
    }
    const next: Row = { ...r, mode: mode as AdultMode, unlock_minutes: minutes as number };
    const morePermissive = ADULT_MODE_RANK[next.mode] > ADULT_MODE_RANK[r.mode];
    const longer = next.unlock_minutes !== r.unlock_minutes && r.pin_hash !== null && r.mode !== 'shown';
    // a PIN sent with no change just verifies it (the web app checks the current PIN before asking for a new one)
    if (morePermissive || longer || body.pin !== undefined) await this.checkPin(ctx.profileId, r, typeof body.pin === 'string' ? body.pin : '');
    if (next.mode === r.mode && next.unlock_minutes === r.unlock_minutes) return;
    if (next.mode !== 'locked') this.revokeAll(ctx.profileId);
    this.save(ctx.profileId, next);
  }

  async setPin(ctx: ParentalCtx, user: UserRow, body: { pin?: unknown; currentPin?: unknown; password?: unknown }): Promise<void> {
    if (!isValidPin(body.pin)) throw this.pinError(400, 'bad_pin', 'The PIN is 4 to 6 digits.', ctx.profileId);
    const r = this.row(ctx.profileId);
    if (typeof body.password === 'string' && body.password) await this.checkPassword(ctx.profileId, user, body.password);
    else if (r.pin_hash) await this.checkPin(ctx.profileId, r, typeof body.currentPin === 'string' ? body.currentPin : '');
    else throw this.pinError(409, 'pin_required', 'Enter your account password to set the first PIN.', ctx.profileId);
    this.revokeAll(ctx.profileId);
    this.save(ctx.profileId, { ...r, pin_hash: await hash(body.pin) });
  }

  /** Admin: forget a profile's PIN and hide adult content again. */
  reset(admin: UserRow, profileId: string): void {
    if (admin.is_admin !== 1) throw NO_ACCESS('Only an admin can reset another profile’s PIN.');
    if (!this.db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId)) throw new ParentalError(404, { error: 'not_found', message: 'Profile not found' });
    this.revokeAll(profileId);
    this.failures.delete(profileId);
    this.save(profileId, { ...this.row(profileId), mode: 'hidden', pin_hash: null });
  }

  /** Category of a playable item, or null if unknown. */
  categoryOf(kind: 'live' | 'movie' | 'series' | 'episode', id: string): string | null {
    const sql =
      kind === 'episode'
        ? 'SELECT s.category_id AS c FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?'
        : `SELECT category_id AS c FROM ${kind === 'live' ? 'channels' : kind === 'movie' ? 'movies' : 'series'} WHERE id = ?`;
    return (this.db.prepare(sql).get(id) as { c: string } | undefined)?.c ?? null;
  }
}

/** The parental context of an authenticated request. */
export function parentalCtx(req: FastifyRequest): ParentalCtx {
  const a = auth(req);
  return { profileId: a.profileId, token: a.token, cookies: req.cookies };
}
