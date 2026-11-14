/**
 * Stream-copied video is cut on keyframes, so a slot's segment really ends on the keyframe after
 * its slot time. When playback goes on into a new FFmpeg run (the old one died: the provider
 * dropped it while paused, say), the new run has to start where the last segment ended. Started
 * at the slot time instead, it began at the keyframe before: the player got up to a GOP twice, and
 * Safari's own HLS player played that sound again and fell out of sync with the picture.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { packetsEnd, VodHlsSession } from '../src/playback/hls';

test('packetsEnd: the end of the last packet, whatever the order', () => {
  expect(packetsEnd('0.000000,0.041708\n0.041708,0.041708\n0.083417,0.041708\n')).toBeCloseTo(0.125125, 5);
  expect(packetsEnd('2.0,1.0\n1.0,0.5\n')).toBe(3);
  expect(packetsEnd('5.0,N/A\n')).toBe(5);
  expect(packetsEnd('')).toBeNull();
});

/** [first, last end] of the video and the audio of an init + segment pair */
function spans(init: string, seg: string) {
  const probe = (s: string) => {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', s, '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', '-i', `concat:${init}|${seg}`], { encoding: 'utf8' });
    const first = Math.min(...out.split('\n').filter(Boolean).map((l) => Number(l.split(',')[0])));
    return [first, packetsEnd(out)!] as const;
  };
  return { v: probe('v:0'), a: probe('a:0') };
}

test('a run that carries playback on starts where the last segment ended', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'anycast-splice-'));
  const src = path.join(dir, 'a.mkv');
  // a keyframe every 4 s, so slot times (every 6 s) fall inside GOPs
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
    '-t', '120', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '96', '-keyint_min', '96', '-sc_threshold', '0', '-c:a', 'aac', src,
  ]);
  const server = http.createServer((req, res) => {
    const size = statSync(src).size;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : size - 1;
    res.writeHead(m ? 206 : 200, { 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
    createReadStream(src, { start, end }).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/a.mkv`;
  const out = mkdtempSync(path.join(os.tmpdir(), 'anycast-splice-out-'));
  const session = new VodHlsSession(out, () => url, 'remux', 120, () => ({ release: () => undefined }), () => undefined, 'aac', undefined, { audio: 0, subtitles: [] });
  try {
    const [init1] = await session.init();
    for (let n = 0; n < 4; n++) await session.segment(n);
    const [seg4] = await session.segment(4);
    const before = spans(init1!, seg4!);
    // slot 4 ends past its slot time (on the keyframe at 32 s, not 30 s)
    expect(before.v[1]).toBeGreaterThan(31);
    // the run dies (the provider dropped it)
    const run = (session as unknown as { run: { proc: { kill: (s: string) => void }; exited: boolean } }).run;
    run.proc.kill('SIGKILL');
    await expect.poll(() => run.exited, { timeout: 5_000 }).toBe(true);
    const [seg5] = await session.segment(5);
    const [init2] = await session.init();
    const after = spans(init2!, seg5!);
    // the new run starts where slot 4 ended: no picture or sound twice, no hole
    expect(after.v[0]).toBeCloseTo(before.v[1], 1);
    expect(after.a[0]).toBeGreaterThanOrEqual(before.a[1] - 0.03);
    expect(after.a[0]).toBeLessThan(before.a[1] + 0.1);
  } finally {
    session.close();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
