/** Counts concurrently open stream responses (and recent HLS sessions) per account. */

export type ConnectionKind = 'live' | 'hls' | 'timeshift' | 'movie' | 'series';

export interface ConnectionInfo {
  id: number;
  username: string;
  kind: ConnectionKind;
  streamId: number;
  ip: string;
  startedAt: number;
}

/** An HLS viewer counts as a connection while it fetched something within this window. */
export const HLS_SESSION_TIMEOUT_MS = 20_000;

export class ConnectionTracker {
  private nextId = 1;
  private readonly open = new Map<number, ConnectionInfo>();
  private readonly hls = new Map<string, ConnectionInfo & { lastSeen: number }>();
  /** most connections open at once since the start (or the last reset), per account */
  private readonly peaks = new Map<string, number>();

  private notePeak(username: string): void {
    this.peaks.set(username, Math.max(this.peaks.get(username) ?? 0, this.count(username)));
  }

  peak(username: string): number {
    return this.peaks.get(username) ?? 0;
  }

  private pruneHls(): void {
    const cutoff = Date.now() - HLS_SESSION_TIMEOUT_MS;
    for (const [k, v] of this.hls) if (v.lastSeen < cutoff) this.hls.delete(k);
  }

  count(username: string): number {
    this.pruneHls();
    let n = 0;
    for (const c of this.open.values()) if (c.username === username) n++;
    for (const c of this.hls.values()) if (c.username === username) n++;
    return n;
  }

  /** Registers an open stream response; returns null when the account is at its limit. */
  acquire(info: Omit<ConnectionInfo, 'id' | 'startedAt'>, max: number): number | null {
    if (this.count(info.username) >= max) return null;
    const id = this.nextId++;
    this.open.set(id, { ...info, id, startedAt: Date.now() });
    this.notePeak(info.username);
    return id;
  }

  release(id: number): void {
    this.open.delete(id);
  }

  /** Refreshes (or starts) an HLS session for this viewer+channel; false when over the limit. */
  touchHls(info: Omit<ConnectionInfo, 'id' | 'startedAt' | 'kind'>, max: number): boolean {
    const key = `${info.username}|${info.ip}|${info.streamId}`;
    const existing = this.hls.get(key);
    if (existing) {
      existing.lastSeen = Date.now();
      return true;
    }
    if (this.count(info.username) >= max) return false;
    const now = Date.now();
    this.hls.set(key, { ...info, kind: 'hls', id: this.nextId++, startedAt: now, lastSeen: now });
    this.notePeak(info.username);
    return true;
  }

  list(): ConnectionInfo[] {
    this.pruneHls();
    return [...this.open.values(), ...[...this.hls.values()].map(({ lastSeen: _l, ...c }) => c)];
  }

  clear(): void {
    this.open.clear();
    this.hls.clear();
    this.peaks.clear();
  }
}
