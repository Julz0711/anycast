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
  private readonly aligned = new WeakSet<PassThrough>();
  private bytes = 0;
  private readonly abort = new AbortController();
  closed = false;

  constructor(
    private readonly lease: Lease,
    private readonly onClose: () => void,
  ) {}

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

  subscribe(): PassThrough {
    const sub = new PassThrough({ highWaterMark: 1024 * 1024 });
    this.subscribers.add(sub);
    sub.on('close', () => {
      this.subscribers.delete(sub);
      if (!this.subscribers.size) this.close();
    });
    return sub;
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

export class LiveFanouts {
  private readonly active = new Map<string, Promise<Fanout>>();

  constructor(private readonly pool: UpstreamPool) {}

  /** Subscribes to the live channel; opens the upstream if nobody is watching yet. */
  async subscribe(key: string, url: () => string, retry = true): Promise<PassThrough> {
    let pending = this.active.get(key);
    if (!pending) {
      const lease = this.pool.acquire(key);
      const fanout = new Fanout(lease, () => {
        if (this.active.get(key) === pending) this.active.delete(key);
      });
      pending = fanout.start(url()).then(() => fanout);
      this.active.set(key, pending);
      pending.catch(() => this.active.delete(key));
    }
    const fanout = await pending;
    if (fanout.closed) {
      if (this.active.get(key) === pending) this.active.delete(key);
      if (!retry) throw new UpstreamError(502, 'The live stream ended');
      return this.subscribe(key, url, false);
    }
    return fanout.subscribe();
  }

  isOpen(key: string): boolean {
    return this.active.has(key);
  }
}
