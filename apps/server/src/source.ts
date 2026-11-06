/** The single Xtream source: encrypted credentials at rest, cached account/server info. */
import type { SourceStatus } from '@anycast/shared';
import type { XtreamCredentials } from './config';
import { decrypt, encrypt } from './crypto';
import type { Db } from './db';
import { XtreamClient, type ClientOptions } from './xtream/client';
import type { AuthResponse } from './xtream/schemas';

interface SourceRow { credentials: string; account: string | null; server: string | null }

export class SourceService {
  private cachedClient: XtreamClient | null = null;

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly clientOptions: ClientOptions = {},
  ) {}

  /** Stores env credentials (encrypted) when they differ from what is saved. */
  seed(creds: XtreamCredentials | null): void {
    if (!creds) return;
    const current = this.credentials();
    if (current && current.url === creds.url && current.username === creds.username && current.password === creds.password) return;
    this.db
      .prepare(
        `INSERT INTO source (id, credentials, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET credentials = excluded.credentials, account = NULL, server = NULL, updated_at = excluded.updated_at`,
      )
      .run(encrypt(this.secret, JSON.stringify(creds)), Date.now());
    this.cachedClient = null;
  }

  private row(): SourceRow | undefined {
    return this.db.prepare('SELECT credentials, account, server FROM source WHERE id = 1').get() as SourceRow | undefined;
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
