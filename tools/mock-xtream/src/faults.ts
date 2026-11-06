/** Runtime-toggleable fault switches (via options or POST /__mock/faults). */

export interface Faults {
  /** Delay (ms) before the first byte of any stream response. */
  slowStartMs: number;
  /** Cut stream responses after this many seconds (0 = never). */
  dropAfterSeconds: number;
  /** Reject every new stream as if the account were at its connection limit. */
  connectionLimitReached: boolean;
  /** Account expired: user_info.status "Expired", exp_date in the past, streams get 403. */
  expired: boolean;
  /** EPG endpoints return malformed JSON / truncated XMLTV. */
  brokenEpg: boolean;
  /** Delay (ms) before every player_api.php / xmltv.php / get.php response. */
  slowApiMs: number;
  /** Answer stream requests with a 302 to the same URL plus ?token=..., like load-balanced panels. */
  redirectStreams: boolean;
  /** Status code used when the connection limit is hit (default 509; some panels use 403). */
  connectionLimitStatus: number;
}

export const DEFAULT_FAULTS: Faults = {
  slowStartMs: 0,
  dropAfterSeconds: 0,
  connectionLimitReached: false,
  expired: false,
  brokenEpg: false,
  slowApiMs: 0,
  redirectStreams: false,
  connectionLimitStatus: 509,
};

export class FaultState {
  private current: Faults;

  constructor(private readonly initial: Partial<Faults> = {}) {
    this.current = { ...DEFAULT_FAULTS, ...initial };
  }

  get(): Faults {
    return this.current;
  }

  /** Merges a partial update; unknown keys and wrongly typed values are rejected. */
  update(patch: unknown): Faults {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error('faults must be a JSON object');
    }
    const next: Faults = { ...this.current };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_FAULTS)) throw new Error(`unknown fault: ${key}`);
      const k = key as keyof Faults;
      if (typeof value !== typeof DEFAULT_FAULTS[k]) throw new Error(`fault ${key} must be a ${typeof DEFAULT_FAULTS[k]}`);
      (next as unknown as Record<string, unknown>)[k] = value;
    }
    this.current = next;
    return next;
  }

  /** Back to the options the server was created with. */
  reset(): Faults {
    this.current = { ...DEFAULT_FAULTS, ...this.initial };
    return this.current;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
