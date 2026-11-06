/**
 * One upstream connection per live channel, fanned out to every viewer (raw TS passthrough and
 * HLS sessions alike). New subscribers join on a 188-byte TS packet boundary.
 */
import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { openUpstream, UpstreamError, type Lease, type UpstreamPool } from './upstream';

const TS_PACKET = 188;
/** a subscriber further behind than this is dropped rather than buffering without bound */
const MAX_LAG_BYTES = 16 * 1024 * 1024;

class Fanout {
  readonly subscribers = new Set<PassThrough>();
  /** subscribers that are recorders, not viewers */
  readonly taps = new Set<PassThrough>();
  private readonly aligned = new WeakSet<PassThrough>();
  private bytes = 0;
  private readonly abort = new AbortController();
  closed = false;

  constructor(
    private readonly lease: Lease,
    private readonly onClose: () => void,
    private readonly onViewers: (viewers: number) => void,
  ) {}

  get viewers(): number {
    return this.subscribers.size - this.taps.size;
  }

  async start(url: string): Promise<void> {
    try {
      const res = await openUpstream(url, this.abort.signal);
      if (!res.body) throw new Error('empty upstream body');
      const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
      body.on('data', (chunk: Buffer) => this.broadcast(chunk));
      body.on('end', () => this.close());
      body.on('error', () => this.close());
    } catch (err) {
      this.close();
      throw err;
    }
  }

  private broadcast(chunk: Buffer): void {
    const offset = this.bytes % TS_PACKET;
    this.bytes += chunk.length;
    for (const sub of this.subscribers) {
      let data = chunk;
      if (!this.aligned.has(sub)) {
        const skip = (TS_PACKET - offset) % TS_PACKET;
        if (skip >= chunk.length) continue;
        data = chunk.subarray(skip);
        this.aligned.add(sub);
      }
      if (sub.writableLength > MAX_LAG_BYTES) {
        sub.destroy();
        continue;
      }
      sub.write(data);
    }
  }

  subscribe(tap: boolean): PassThrough {
    const sub = new PassThrough({ highWaterMark: 1024 * 1024 });
    this.subscribers.add(sub);
    if (tap) this.taps.add(sub);
    sub.on('close', () => {
      this.subscribers.delete(sub);
      this.taps.delete(sub);
      if (!tap) this.onViewers(this.viewers);
      if (!this.subscribers.size) this.close();
    });
    if (!tap) this.onViewers(this.viewers);
    return sub;
  }

  /** Ends every viewer (not the recorder taps). */
  dropViewers(): void {
    for (const sub of this.subscribers) if (!this.taps.has(sub)) sub.end();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.lease.release();
    for (const sub of this.subscribers) sub.end();
    this.onClose();
  }
}

export interface SubscribeOptions {
  /** a recorder: shares the upstream like a viewer but is not counted as one */
  tap?: boolean;
  /** only join an upstream that is already open (never open a provider connection) */
  onlyIfOpen?: boolean;
}

export class LiveFanouts {
  private readonly active = new Map<string, Promise<Fanout>>();
  /** the fan-out behind each entry of `active`, also while it is still connecting */
  private readonly objects = new Map<string, Fanout>();
  private readonly listeners = new Set<(key: string, viewers: number) => void>();

  constructor(private readonly pool: UpstreamPool) {}

  /** Called whenever the number of viewers (subscribers that are not taps) of a channel changes. */
  onViewers(fn: (key: string, viewers: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emitViewers(key: string, viewers: number): void {
    for (const fn of this.listeners) fn(key, viewers);
  }

  /** Subscribes to the live channel; opens the upstream if nobody is watching yet. */
  async subscribe(key: string, url: () => string, opts: SubscribeOptions = {}, retry = true): Promise<PassThrough> {
    let pending = this.active.get(key);
    if (!pending && opts.onlyIfOpen) throw new UpstreamError(409, 'The live stream is not open');
    if (!pending) {
      const lease = this.pool.acquire(key);
      const fanout: Fanout = new Fanout(
        lease,
        () => {
          if (this.active.get(key) === pending) this.active.delete(key);
          if (this.objects.get(key) === fanout) this.objects.delete(key);
        },
        (n) => this.emitViewers(key, n),
      );
      pending = fanout.start(url()).then(() => fanout);
      this.active.set(key, pending);
      this.objects.set(key, fanout);
      pending.catch(() => {
        if (this.objects.get(key) === fanout) this.objects.delete(key);
        this.active.delete(key);
      });
    }
    const fanout = await pending;
    if (fanout.closed) {
      if (this.active.get(key) === pending) this.active.delete(key);
      if (!retry || opts.onlyIfOpen) throw new UpstreamError(502, 'The live stream ended');
      return this.subscribe(key, url, opts, false);
    }
    return fanout.subscribe(opts.tap ?? false);
  }

  /** Viewers (not taps) of an open channel. */
  async viewers(key: string): Promise<number> {
    const pending = this.active.get(key);
    if (!pending) return 0;
    const f = await pending.catch(() => null);
    return f && !f.closed ? f.viewers : 0;
  }

  isOpen(key: string): boolean {
    return this.active.has(key);
  }

  /** Viewers of a channel right now (0 while it is still connecting). */
  viewersNow(key: string): number {
    const f = this.objects.get(key);
    return f && !f.closed ? f.viewers : 0;
  }

  /** Closes the channel's upstream now: viewers and recorders end, the provider connection is released. */
  close(key: string): void {
    this.objects.get(key)?.close();
  }

  /** Ends the channel's viewers; recorder taps keep the upstream open. */
  dropViewers(key: string): void {
    this.objects.get(key)?.dropViewers();
  }
}
