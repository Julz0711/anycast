/** The single Xtream source: encrypted credentials at rest, cached account/server info. */
import { createHmac } from 'node:crypto';
import type { ProviderSettings, SourceStatus } from '@anycast/shared';
import type { XtreamCredentials } from './config';
import { decrypt, encrypt } from './crypto';
import type { Db } from './db';
import { XtreamClient, type ClientOptions } from './xtream/client';
import type { AuthResponse } from './xtream/schemas';

interface SourceRow { credentials: string; account: string | null; server: string | null; origin: string | null; env_hash: string | null; updated_at: number }

const same = (a: XtreamCredentials, b: XtreamCredentials) => a.url === b.url && a.username === b.username && a.password === b.password;

export class SourceService {
  private cachedClient: XtreamClient | null = null;

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly clientOptions: ClientOptions = {},
  ) {}

  /** whether the server's .env has a provider login (set by seed) */
  private envSet = false;

  /**
   * Applies the .env login (XTREAM_*) at startup. It is saved when nothing is saved yet or when the
   * .env values changed since they were last applied; an unchanged .env never overwrites a login an
   * admin entered in the app.
   */
  seed(creds: XtreamCredentials | null): void {
    this.envSet = creds !== null;
    if (!creds) return;
    const hash = this.envHash(creds);
    const row = this.row();
    if (row && row.env_hash === hash) return;
    const current = this.credentials();
    if (current && same(current, creds)) {
      // same login (e.g. saved before env_hash existed): remember the .env values, keep account info
      this.db.prepare('UPDATE source SET env_hash = ? WHERE id = 1').run(hash);
      return;
    }
    this.write(creds, 'env', hash);
  }

  /** Saves a login entered in the app (Settings › Provider). The .env values stay remembered. */
  save(creds: XtreamCredentials): void {
    const current = this.credentials();
    if (current && same(current, creds)) return;
    this.write(creds, 'app', this.row()?.env_hash ?? null);
  }

  private write(creds: XtreamCredentials, origin: 'env' | 'app', envHash: string | null): void {
    this.db
      .prepare(
        `INSERT INTO source (id, credentials, origin, env_hash, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET credentials = excluded.credentials, origin = excluded.origin, env_hash = excluded.env_hash,
           account = NULL, server = NULL, updated_at = excluded.updated_at`,
      )
      .run(encrypt(this.secret, JSON.stringify(creds)), origin, envHash, Date.now());
    this.cachedClient = null;
  }

  /** keyed with ANYCAST_SECRET, so the stored value says nothing about the login */
  private envHash(creds: XtreamCredentials): string {
    return createHmac('sha256', this.secret).update(JSON.stringify([creds.url, creds.username, creds.password])).digest('base64url');
  }

  /** What an admin sees in Settings › Provider: never the password. */
  settings(): ProviderSettings {
    const row = this.row();
    const creds = this.credentials();
    return {
      configured: creds !== null,
      url: creds?.url ?? null,
      username: creds?.username ?? null,
      origin: creds ? (row?.origin === 'app' ? 'app' : 'env') : null,
      envSet: this.envSet,
      updatedAt: creds ? (row?.updated_at ?? null) : null,
    };
  }

  private row(): SourceRow | undefined {
    return this.db.prepare('SELECT credentials, account, server, origin, env_hash, updated_at FROM source WHERE id = 1').get() as SourceRow | undefined;
  }

  credentials(): XtreamCredentials | null {
    const row = this.row();
    if (!row) return null;
    try {
      return JSON.parse(decrypt(this.secret, row.credentials)) as XtreamCredentials;
    } catch {
      return null;
    }
  }

  client(): XtreamClient | null {
    if (this.cachedClient) return this.cachedClient;
    const creds = this.credentials();
    this.cachedClient = creds ? new XtreamClient(creds, this.clientOptions) : null;
    return this.cachedClient;
  }

  saveAccount(auth: AuthResponse): void {
    this.db
      .prepare('UPDATE source SET account = ?, server = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(auth.user_info), JSON.stringify(auth.server_info), Date.now());
  }

  account(): AuthResponse['user_info'] | null {
    const a = this.row()?.account;
    return a ? (JSON.parse(a) as AuthResponse['user_info']) : null;
  }

  timezone(): string | null {
    const s = this.row()?.server;
    return s ? ((JSON.parse(s) as AuthResponse['server_info']).timezone ?? null) : null;
  }

  maxConnections(): number | null {
    const max = this.account()?.max_connections;
    return max && max > 0 ? max : null;
  }

  accountStatus(): SourceStatus['account'] {
    const a = this.account();
    if (!a) return null;
    return {
      status: a.status ?? 'Unknown',
      expiresAt: a.exp_date ? a.exp_date * 1000 : null,
      maxConnections: a.max_connections,
      activeConnections: a.active_cons,
    };
  }
}
