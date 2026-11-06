/** Helpers shared by the test files (not part of the public API). */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Reads a streaming response for `ms` milliseconds (or until `maxBytes`), then aborts. */
export async function readFor(url: string, ms: number, maxBytes = Infinity): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  const chunks: Buffer[] = [];
  let total = 0;
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
        total += chunk.length;
        if (total >= maxBytes) break;
      }
    }
  } catch {
    /* aborted */
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks) };
}

export function writeTemp(name: string, data: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'mock-xtream-test-'));
  const file = join(dir, name);
  writeFileSync(file, data);
  return file;
}

/** ffprobe JSON for a file. */
export function ffprobe(file: string, args: string[]): unknown {
  const r = spawnSync('ffprobe', ['-v', 'error', '-of', 'json', ...args, file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** pts_time (seconds) of the first video packet. */
export function firstVideoPts(file: string): number {
  const out = ffprobe(file, ['-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-read_intervals', '%+#1']) as {
    packets?: { pts_time?: string }[];
  };
  const pts = Number(out.packets?.[0]?.pts_time);
  if (!Number.isFinite(pts)) throw new Error('no video packet');
  return pts;
}

export function streamCodecs(file: string): { codec_type: string; codec_name: string; language?: string }[] {
  const out = ffprobe(file, ['-show_entries', 'stream=codec_type,codec_name:stream_tags=language']) as {
    streams: { codec_type: string; codec_name: string; tags?: { language?: string } }[];
  };
  return out.streams.map((s) => ({ codec_type: s.codec_type, codec_name: s.codec_name, language: s.tags?.language }));
}

/** Circular distance between two seconds-of-day values. */
export function dayDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 86400;
  return Math.min(d, 86400 - d);
}

export const waitFor = async (cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};
