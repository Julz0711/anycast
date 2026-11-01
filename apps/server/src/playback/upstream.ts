import type { GapCause } from '@anycast/shared';
/** Counts provider connections. Leases with the same key share one connection slot. */

export class ConnectionLimitError extends Error {
  readonly code = 'connection_limit';
  constructor(max: number | null) {
    super(
      max === null
        ? 'The provider says all connections of your subscription are in use. Stop playback on another device and try again.'
        : `All ${max} provider connection${max === 1 ? ' is' : 's are'} in use. Stop playback on another device or tab and try again.`,
    );
  }
}

export interface Lease {
  release(): void;
}

export class UpstreamPool {
  private readonly refs = new Map<string, number>();

  constructor(private readonly maxConnections: () => number | null) {}

  get active(): number {
    return this.refs.size;
  }

  /** Keys holding a connection, oldest first. */
  keys(): string[] {
    return [...this.refs.keys()];
  }

  has(key: string): boolean {
    return this.refs.has(key);
  }

  /** Every provider connection is in use. */
  full(): boolean {
    const max = this.maxConnections();
    return max !== null && this.refs.size >= max;
  }

  /** Throws ConnectionLimitError if `key` is not already open and the provider limit is reached. */
  check(key: string): void {
    const max = this.maxConnections();
    if (max !== null && !this.refs.has(key) && this.refs.size >= max) throw new ConnectionLimitError(max);
  }

  acquire(key: string): Lease {
    this.check(key);
    this.refs.set(key, (this.refs.get(key) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const n = (this.refs.get(key) ?? 1) - 1;
        if (n <= 0) this.refs.delete(key);
        else this.refs.set(key, n);
      },
    };
  }
}

/**
 * Panels count a connection until they notice it closed, which can take a moment after we drop
 * one (zapping, taking over). So "limit reached" right after a release is retried a few times.
 */
const LIMIT_RETRY_MS = [250, 500, 1000, 1500];

/** Opens an upstream HTTP stream. Errors carry only the status, never the URL. */
export async function openUpstream(url: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'user-agent': 'AnyCast/0.1', ...headers }, signal, redirect: 'follow' });
    } catch {
      throw new UpstreamError(502, 'The provider stream could not be reached');
    }
    if (res.ok || res.status === 206) return res;
    await res.body?.cancel().catch(() => undefined);
    // panels signal "max connections reached" with 509 (some with 458 or 429)
    if (res.status === 509 || res.status === 458 || res.status === 429) {
      const wait = LIMIT_RETRY_MS[attempt];
      if (wait === undefined || signal.aborted) throw new ConnectionLimitError(null);
      await new Promise((r) => setTimeout(r, wait));
      if (signal.aborted) throw new ConnectionLimitError(null);
      continue;
    }
    throw new UpstreamError(502, `The provider refused the stream (HTTP ${res.status})`);
  }
}

export class UpstreamError extends Error {
  readonly code = 'upstream';
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** The asked-for time is in a timeline gap (422); `gap` lets clients format the reason themselves. */
export class GapError extends UpstreamError {
  constructor(
    message: string,
    readonly gap: GapCause,
  ) {
    super(422, message);
  }
}
