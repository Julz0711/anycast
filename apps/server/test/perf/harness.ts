/**
 * Scale harness: runs the mock provider and the AnyCast server as separate processes (like in
 * production), measures the first catalog + EPG sync and the server's memory, then times the
 * hot read paths over HTTP. Used by the opt-in perf suite (`pnpm --filter @anycast/server test:perf`)
 * with the `huge` mock, and by the default suite with a smaller one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const MOCK = { username: 'perf-user', password: 'perf-pass-5521' };
const ADMIN = { username: 'perf-admin', password: 'perf-admin-password-1' };

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** One node process running a package's src/main.ts through tsx (no tsx wrapper process, so the pid is the app). */
function startNode(
  cwd: string,
  env: Record<string, string>,
  onLine?: (line: string) => void,
): { child: ChildProcess; log: string[] } {
  const log: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let partial = '';
  const keep = (b: Buffer) => {
    log.push(String(b));
    if (log.length > 100) log.shift();
    if (process.env.PERF_DEBUG) process.stderr.write(b);
    if (onLine) {
      const lines = (partial + String(b)).split('\n');
      partial = lines.pop()!;
      lines.forEach(onLine);
    }
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  return { child, log };
}

/** A sync result line from the server log ("catalog sync finished" / "epg sync finished"). */
export interface SyncLog { msg: string; ms: number; phases?: Record<string, number>; programs?: number }

/** Resident set size (current and peak) in MB, from /proc (Linux); null elsewhere. */
export function rssOf(pid: number): { rss: number; peak: number } | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(status)?.[1] ?? NaN);
    return { rss: Math.round(kb('VmRSS') / 1024), peak: Math.round(kb('VmHWM') / 1024) };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Timing { p50: number; p95: number; max: number }
export function timing(samples: number[]): Timing {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  return { p50: Math.round(at(0.5) * 10) / 10, p95: Math.round(at(0.95) * 10) / 10, max: Math.round(s[s.length - 1]! * 10) / 10 };
}

export interface Stack {
  base: string;
  serverPid: number;
  dataDir: string;
  /** sync results logged by the server so far, oldest first */
  syncLogs: SyncLog[];
  cookie: string;
  catalogSyncMs: number;
  epgSyncMs: number;
  peakRssDuringSync: number;
  counts: { live: number; movie: number; series: number };
  get<T>(url: string, init?: RequestInit): Promise<T>;
  /** median-free raw timings of `url` over `n` runs */
  time(url: string, n?: number): Promise<number[]>;
  stop(): Promise<void>;
}

/** Starts mock + server, waits for the first catalog and EPG sync. */
export async function startStack(opts: {
  size: 'small' | 'full' | 'huge' | 'real';
  timezone?: string;
  syncTimeoutMs?: number;
  /** server LOG_LEVEL; sync timings are logged at info */
  logLevel?: string;
  /** called about every 200 ms while the first sync runs */
  onSyncTick?: () => void;
}): Promise<Stack> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'anycast-perf-'));
  const [mockPort, serverPort] = await Promise.all([freePort(), freePort()]);
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  const base = `http://127.0.0.1:${serverPort}`;
  const mock = startNode(path.join(repo, 'tools/mock-xtream'), {
    PORT: String(mockPort), HOST: '127.0.0.1', SIZE: opts.size, MAX_CONNECTIONS: '1',
    MOCK_USERNAME: MOCK.username, MOCK_PASSWORD: MOCK.password, MOCK_TIMEZONE: opts.timezone ?? 'Europe/Amsterdam',
  });
  let server: ReturnType<typeof startNode> | null = null;
  const stop = async () => {
    for (const p of [server?.child, mock.child]) {
      if (p && p.exitCode === null) {
        p.kill('SIGTERM');
        await new Promise((r) => {
          p.once('exit', r);
          setTimeout(() => (p.kill('SIGKILL'), r(null)), 5000);
        });
      }
    }
    if (process.env.PERF_KEEP_DATA) console.log(`[perf] data kept in ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  };
  const until = async <T>(what: string, fn: () => Promise<T | null | false | undefined>, ms: number, onTick?: () => void): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      onTick?.();
      try {
        const v = await fn();
        if (v) return v;
      } catch {
        /* not up yet */
      }
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${[...mock.log, ...(server?.log ?? [])].slice(-30).join('')}`);
      await sleep(200);
    }
  };

  try {
    await until('the mock', async () => (await fetch(`${mockUrl}/__mock/state`)).ok, 120_000);
    const started = Date.now();
    const syncLogs: SyncLog[] = [];
    const onLine = (line: string) => {
      if (!line.includes('sync finished')) return;
      try {
        const j = JSON.parse(line) as SyncLog;
        if (j.msg === 'catalog sync finished' || j.msg === 'epg sync finished') syncLogs.push(j);
      } catch {
        /* not a log line */
      }
    };
    server = startNode(path.join(repo, 'apps/server'), {
      PORT: String(serverPort), HOST: '127.0.0.1', DATA_DIR: path.join(tmp, 'data'), BUFFER_ENABLED: '0', WEB_DIST: path.join(tmp, 'no-web'),
      XTREAM_URL: mockUrl, XTREAM_USERNAME: MOCK.username, XTREAM_PASSWORD: MOCK.password,
      ANYCAST_SECRET: 'perf-secret-0123456789abcdef', ANYCAST_ADMIN_USER: ADMIN.username, ANYCAST_ADMIN_PASSWORD: ADMIN.password,
      LOG_LEVEL: opts.logLevel ?? 'warn',
    }, onLine);
    const pid = server.child.pid!;
    let peak = 0;
    const sample = () => {
      const r = rssOf(pid);
      if (r) peak = Math.max(peak, r.peak);
      opts.onSyncTick?.();
    };
    await until('the server', async () => (await fetch(`${base}/api/health`)).ok, 60_000);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) });
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('anycast_session='))!.split(';')[0]!;
    const get = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
      const res = await fetch(base + url, { ...init, headers: { cookie, 'content-type': 'application/json', ...init.headers } });
      if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
      return (await res.json()) as T;
    };
    type Src = { syncing: boolean; lastSync: { catalog: number | null; epg: number | null }; counts: Stack['counts'] };
    const cat = await until('the catalog sync', async () => (await get<Src>('/api/source')).lastSync.catalog, opts.syncTimeoutMs ?? 600_000, sample);
    const catalogSyncMs = cat - started;
    const done = await until('the EPG sync', async () => {
      const s = await get<Src>('/api/source');
      return !s.syncing && s.lastSync.epg ? s : null;
    }, opts.syncTimeoutMs ?? 600_000, sample);
    sample();
    return {
      base, serverPid: pid, dataDir: path.join(tmp, 'data'), syncLogs, cookie, catalogSyncMs, epgSyncMs: done.lastSync.epg! - cat, peakRssDuringSync: peak, counts: done.counts, get,
      time: async (url, n = 7) => {
        const out: number[] = [];
        for (let i = 0; i < n; i++) {
          const t = performance.now();
          const res = await fetch(base + url, { headers: { cookie } });
          await res.arrayBuffer();
          if (!res.ok) throw new Error(`${url}: ${res.status}`);
          out.push(performance.now() - t);
        }
        return out;
      },
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** Searches the perf suites run: whole words, prefixes down to one letter, several tokens, and misses. */
export const SEARCH_QUERIES = [
  'a', 'b', 'd', 'e', 's', 't', 'ar', 'th', 'de', 'sk', 'bbc', 'the', 'spo', 'sky sp', 'sky sports', 'news', 'river', 'golden r',
  'last', 'the last', 'winter', 'kingdom 2', 'ard', 'zdf', 'film', 'fluss', 'le', 'el río', 'tv', 'hd', 'zzzz', 'qx',
];
