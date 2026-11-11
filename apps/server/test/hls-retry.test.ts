/**
 * A VOD conversion that fails before writing anything (the provider refused the first request,
 * say) must not answer every later request with the same failure: asking for the init again
 * starts it again. And the failure says what the provider answered.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ffmpegFailure, VodHlsSession } from '../src/playback/hls';

test('ffmpeg failures name the provider answer', () => {
  expect(ffmpegFailure('[http @ 0x1] HTTP error 403 Forbidden\nServer returned 403 Forbidden (access denied)', 'x')).toMatch(/refused the stream \(HTTP 403 Forbidden/);
  expect(ffmpegFailure('Server returned 404 Not Found', 'x')).toBe('The provider does not have this video (HTTP 404 Not Found).');
  expect(ffmpegFailure('Connection to tcp://1.2.3.4:80 failed: Connection timed out', 'x')).toBe('The server could not reach the provider.');
  expect(ffmpegFailure('Invalid data found when processing input', 'fallback')).toBe('fallback');
});

test('the init after a failed start starts the conversion again', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'anycast-retry-'));
  const src = path.join(dir, 'a.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=f=440',
    '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-c:a', 'aac', src,
  ]);
  const data = readFileSync(src);
  let refuse = true;
  const server = http.createServer((_req, res) => {
    if (refuse) return void res.writeHead(403).end();
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': data.length }).end(data);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/a.mp4`;
  const out = mkdtempSync(path.join(os.tmpdir(), 'anycast-retry-out-'));
  const session = new VodHlsSession(out, () => url, 'remux', 30, () => ({ release: () => undefined }), () => undefined, 'aac', undefined, { audio: 0, subtitles: [] });
  try {
    await expect(session.init()).rejects.toThrow(/refused the stream \(HTTP 403/);
    refuse = false;
    const [init] = await session.init();
    expect(readFileSync(init!).length).toBeGreaterThan(0);
  } finally {
    session.close();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
