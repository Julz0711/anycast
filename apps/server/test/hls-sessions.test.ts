/** The HLS session registry: shared creation, and sessions stopped while they were still starting. */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { HlsSessions } from '../src/playback/hls';

const registries: HlsSessions[] = [];
afterEach(() => registries.splice(0).forEach((r) => r.closeAll()));

function registry() {
  const r = new HlsSessions(mkdtempSync(path.join(os.tmpdir(), 'anycast-sessions-')));
  registries.push(r);
  return r;
}

/** A stand-in session; `closed` tells whether the registry stopped it. */
function fake(dir: string) {
  return { dir, lastAccess: Date.now(), closed: false, touch() {}, close() { this.closed = true; } };
}
const later = <T>(v: T, ms = 50) => new Promise<T>((r) => setTimeout(() => r(v), ms));

test('concurrent requests share one session', async () => {
  const r = registry();
  let made = 0;
  const make = (dir: string) => (made++, later(fake(dir)));
  const [a, b] = await Promise.all([r.getOrCreate('k', make as never), r.getOrCreate('k', make as never)]);
  expect(a).toBe(b);
  expect(made).toBe(1);
});

test('a session that matched closeWhere while it was starting is closed once it exists, not kept', async () => {
  const r = registry();
  let made: ReturnType<typeof fake> | null = null;
  const starting = r.getOrCreate('ts:1:100:6:remux', (dir) => later((made = fake(dir))) as never);
  const other = r.getOrCreate('ts:2:100:6:remux', (dir) => later(fake(dir)) as never);
  // a track switch (or zapping) stops channel 1's sessions while its old player's playlist request is still starting one
  r.closeWhere((k) => k.startsWith('ts:1:'));
  await expect(starting).rejects.toMatchObject({ statusCode: 409 });
  expect(made!.closed).toBe(true);
  await other;
  expect(r.size).toBe(1);
  // asking again starts a new one
  const again = (await r.getOrCreate('ts:1:100:6:remux', (dir) => fake(dir) as never)) as unknown as ReturnType<typeof fake>;
  expect(again.closed).toBe(false);
  expect(r.size).toBe(2);
});
