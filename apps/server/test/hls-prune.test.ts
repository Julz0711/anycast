/**
 * A VOD session deletes segments far behind playback to save disk. With two viewers of the same
 * title, one far ahead, the other still needs an early slot: it must get a fresh run, never the
 * path of a deleted file (seen as ENOENT on every request until the run ended).
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { VodHlsSession } from '../src/playback/hls';

test('a slot deleted behind another viewer is made again, not served as a missing file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'anycast-prune-'));
  const src = path.join(dir, 'a.mkv');
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=f=440',
    '-t', '900', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-c:a', 'aac', src,
  ]);
  // served over HTTP with ranges, like a provider
  const server = http.createServer((req, res) => {
    const size = statSync(src).size;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : size - 1;
    res.writeHead(m ? 206 : 200, { 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
    // throttled (~200 KB/s), so the conversion can't finish the whole file before the session
    // pauses it ahead of playback: pruning only happens while a run is still going
    const rs = createReadStream(src, { start, end, highWaterMark: 16 * 1024 });
    rs.on('data', (chunk) => {
      rs.pause();
      res.write(chunk);
      setTimeout(() => rs.resume(), 80);
    });
    rs.on('end', () => res.end());
    res.on('close', () => rs.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/a.mkv`;
  const out = mkdtempSync(path.join(os.tmpdir(), 'anycast-prune-out-'));
  const session = new VodHlsSession(out, () => url, 'remux', 900, () => ({ release: () => undefined }), () => undefined, 'aac', undefined, {
    audio: 0, subtitles: [],
  });
  try {
    // viewer A plays from the start to slot 20 within one run
    const [first] = await session.segment(0);
    for (let n = 1; n <= 20; n++) await session.segment(n);
    // the session prunes slots more than 10 behind the last request (checked every second)
    await expect.poll(() => existsSync(first!), { timeout: 20_000, interval: 250 }).toBe(false);
    // viewer B starts the same title from the beginning
    const [again] = await session.segment(0);
    expect(existsSync(again!)).toBe(true);
  } finally {
    session.close();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
