import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { rawBackdropUrl } from '../catalog/movieinfo';
import { rawArtUrl, shortHash } from '../catalog/store';
import type { Services } from '../context';
import { parentalCtx } from '../parental';

const MAX_BYTES = 5 * 1024 * 1024;
/** artwork kept on disk (DATA_DIR/art); the least recently used goes first */
const CACHE_MAX_BYTES = 512 * 1024 * 1024;

/** Content type from the first bytes (the cache keeps only the bytes). */
export function sniffImage(b: Buffer): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 4, 12) === 'ftypavif') return 'image/avif';
  const head = b.toString('utf8', 0, 256).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

/** Provider artwork on disk, keyed by the provider URL, capped at maxBytes. */
export class ArtCache {
  private size: number | null = null;
  private pruning = false;

  constructor(private readonly dir: string, private readonly maxBytes = CACHE_MAX_BYTES) {}

  private file(url: string) {
    return path.join(this.dir, createHash('sha256').update(url).digest('hex').slice(0, 32));
  }

  async get(url: string): Promise<Buffer | null> {
    const f = this.file(url);
    try {
      const b = await fs.readFile(f);
      const now = new Date();
      void fs.utimes(f, now, now).catch(() => undefined);
      return b;
    } catch {
      return null;
    }
  }

  async put(url: string, body: Buffer): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const f = this.file(url);
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, f);
      if (this.size === null) this.size = await this.measure();
      else this.size += body.length;
      if (this.size > this.maxBytes) void this.prune();
    } catch {
      // a full disk only costs the cache
    }
  }

  private async entries() {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const out: { f: string; size: number; at: number }[] = [];
    for (const n of names) {
      const f = path.join(this.dir, n);
      const st = await fs.stat(f).catch(() => null);
      if (st?.isFile()) out.push({ f, size: st.size, at: st.mtimeMs });
    }
    return out;
  }

  private async measure() {
    return (await this.entries()).reduce((n, e) => n + e.size, 0);
  }

  /** Deletes the least recently used files until the cache is at 80% of its cap. */
  async prune(): Promise<void> {
    if (this.pruning) return;
    this.pruning = true;
    try {
      const list = (await this.entries()).sort((a, b) => a.at - b.at);
      let size = list.reduce((n, e) => n + e.size, 0);
      for (const e of list) {
        if (size <= this.maxBytes * 0.8) break;
        await fs.rm(e.f, { force: true });
        size -= e.size;
      }
      this.size = size;
    } finally {
      this.pruning = false;
    }
  }
}

/**
 * Proxies provider artwork (logos, posters, backdrops) so the client never sees provider hosts,
 * and keeps it on disk so slow provider image hosts are hit once.
 */
export function artRoutes(app: FastifyInstance, s: Services, cache = new ArtCache(path.join(s.config.dataDir, 'art'))): void {
  app.get<{ Params: { kind: string; id: string }; Querystring: { v?: string } }>('/api/art/:kind/:id', async (req, reply) => {
    const kind = z.enum(['live', 'movie', 'series', 'backdrop', 'episode']).safeParse(req.params.kind);
    if (kind.success) {
      const adult = s.parental.view(parentalCtx(req));
      const of = kind.data === 'backdrop' ? 'movie' : kind.data;
      if (adult.adultIds.size) adult.assertOpen(s.parental.categoryOf(of, req.params.id));
    }
    const url = !kind.success ? null : kind.data === 'backdrop' ? rawBackdropUrl(s.db, req.params.id) : rawArtUrl(s.db, kind.data, req.params.id);
    if (!url || !/^https?:\/\//i.test(url)) return reply.code(404).send({ error: 'not_found', message: 'No artwork' });
    // a URL with the current version may be kept for good; it changes when the provider's does
    const forever = req.query.v === shortHash(url);
    const send = (body: Buffer, type: string) =>
      reply
        .header('content-type', type)
        .header('cache-control', forever ? 'private, max-age=31536000, immutable' : 'private, max-age=86400')
        .header('content-length', String(body.length))
        .send(body);

    const hit = await cache.get(url);
    const hitType = hit && sniffImage(hit);
    if (hit && hitType) return send(hit, hitType);

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'AnyCast/0.1' } });
    } catch {
      return reply.code(502).send({ error: 'upstream', message: 'Artwork could not be loaded' });
    }
    const type = res.headers.get('content-type') ?? '';
    const length = Number(res.headers.get('content-length') ?? 0);
    if (!res.ok || !res.body || !type.startsWith('image/') || length > MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      return reply.code(404).send({ error: 'not_found', message: 'No artwork' });
    }
    let body: Buffer;
    try {
      body = await readCapped(res.body, MAX_BYTES);
    } catch {
      return reply.code(404).send({ error: 'not_found', message: 'No artwork' });
    }
    // cached only when the bytes say what they are, so a hit can be served with the right type
    if (sniffImage(body)) void cache.put(url, body);
    return send(body, type);
  });
}

async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error('too big');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
