import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { formatReport, parseArgs, runDoctor } from '../src/doctor/report';
import type { ProbeResult } from '../src/playback/probe';
import { createMockXtream } from './helpers';

const run = promisify(execFile);
const CREDS = { username: 'doc-user-4410', password: 'doc-pass-9921' };
let mock: Awaited<ReturnType<typeof createMockXtream>>;

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', ...CREDS });
});
afterAll(() => mock.close());

const secrets = () => [CREDS.username, CREDS.password, new URL(mock.url).host, '127.0.0.1', 'http://'];

test('report covers account, catalog, tags, archive, EPG and streams without secrets', async () => {
  let calls = 0;
  // every 3rd probe fails with an error that echoes the provider URL, like ffprobe does
  const probe = async (url: string): Promise<ProbeResult> => {
    if (++calls % 3 === 0) throw new Error(`Server returned 403 Forbidden for ${url} (user ${CREDS.username})`);
    return { container: 'ts', duration: null, video: { codec: 'h264', width: 1280, height: 720 }, audio: [{ codec: 'aac', language: null, channels: 2 }], subtitles: [] };
  };
  const report = await runDoctor({ url: mock.url, ...CREDS }, { samples: 4, streams: true, probe });
  expect(report.account).toMatchObject({ status: 'Active', maxConnections: expect.any(Number) });
  expect(report.timezone).toBe('Europe/Berlin');
  expect(report.items).toEqual({ live: mock.catalog.live.length, movie: mock.catalog.movies.length, series: mock.catalog.series.length });
  expect(report.topCountries[0]!.code).toBe('de');
  expect(report.archive.percentChannels).toBeGreaterThan(0);
  expect(report.epg.percentWithProgramNow).toBeGreaterThan(50);
  expect(report.streams!.samples.length).toBe(4 + 5 + 3);
  expect(report.streams!.samples.some((s) => !s.ok)).toBe(true);
  expect(report.timeshift?.tested).toBe(true);
  const text = formatReport(report) + JSON.stringify(report);
  for (const s of secrets()) expect(text).not.toContain(s);
});

test('flags', () => {
  expect(parseArgs(['--samples', '3', '--json', '--no-streams'])).toEqual({ samples: 3, json: true, streams: false });
  expect(parseArgs([])).toEqual({ samples: 8, json: false, streams: true });
});

const cli = (env: Record<string, string>, args: string[]) =>
  run(path.resolve('node_modules/.bin/tsx'), ['src/doctor/cli.ts', ...args], { env: { ...process.env, ...env }, timeout: 60_000 }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
  );

test('CLI prints JSON without secrets', async () => {
  const r = await cli({ XTREAM_URL: mock.url, XTREAM_USERNAME: CREDS.username, XTREAM_PASSWORD: CREDS.password }, ['--json', '--no-streams']);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).items.live).toBe(mock.catalog.live.length);
  for (const s of secrets()) expect(r.out).not.toContain(s);
});

test('CLI exits non-zero with a friendly message on auth failure', async () => {
  const r = await cli({ XTREAM_URL: mock.url, XTREAM_USERNAME: CREDS.username, XTREAM_PASSWORD: 'wrong-pass-1234' }, ['--no-streams']);
  expect(r.code).toBe(2);
  expect(r.out).toContain('Login to your provider failed');
  for (const s of [...secrets(), 'wrong-pass-1234']) expect(r.out).not.toContain(s);
});
