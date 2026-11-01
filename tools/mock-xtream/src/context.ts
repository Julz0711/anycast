import type { Catalog } from './catalog.js';
import type { ConnectionTracker } from './connections.js';
import type { FaultState } from './faults.js';

/** Shared state of one mock server instance. */
export interface MockContext {
  catalog: Catalog;
  username: string;
  password: string;
  maxConnections: number;
  faults: FaultState;
  connections: ConnectionTracker;
  /** Current time in milliseconds (Date.now compatible). */
  now: () => number;
  /** Panel timezone: EPG strings, timeshift URLs and burned-in clocks use it. */
  timezone: string;
  cacheDir: string;
  /** Unix seconds when the account was "created". */
  createdAt: number;
}

export const nowSec = (ctx: MockContext): number => Math.floor(ctx.now() / 1000);

export function checkCredentials(ctx: MockContext, username: unknown, password: unknown): boolean {
  return username === ctx.username && password === ctx.password;
}
