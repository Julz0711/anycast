/**
 * Repeatable performance benchmark at a real provider's scale (not part of `pnpm test`):
 *
 *   pnpm run perf                       # real size (~195k items, ~4k guide channels), plus the web bundle
 *   pnpm run perf -- --size huge --no-web --json out.json
 *
 * Starts the mock provider and the server as separate processes (like production), runs the first
 * catalog + EPG sync into a temp DATA_DIR and reports: sync time per phase, peak and idle RSS, DB
 * size, p50/p95 of the list, search, guide, favorites and continue-watching endpoints with no rules,
 * with several countries hidden, and with the adult lock on; API latency while a re-sync runs; and
 * the web app's initial gzipped JS from a vite build.
 */
import type { Category, LiveChannelWithNow, Page, TagSummary } from '@anycast/shared';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { rssOf, SEARCH_QUERIES, startStack, timing, type Stack, type Timing } from './harness';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const ADMIN_PASSWORD = 'perf-admin-password-1';

const { values: args } = parseArgs({
  options: {
    size: { type: 'string', default: 'real' },
    'no-web': { type: 'boolean', default: false },
    json: { type: 'string' },
    runs: { type: 'string', default: '9' },
  },
});
const size = args.size as 'real' | 'huge' | 'full' | 'small';
const RUNS = Number(args.runs);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes: number) => Math.round(bytes / 1024 / 102.4) / 10;
const log = (s: string) => process.stderr.write(`[perf] ${s}\n`);

interface Report {
  size: string;
  node: string;
  cpus: number;
  counts?: Stack['counts'];
  sync?: { catalogMs: number; epgMs: number; programs?: number; catalogPhases?: Record<string, number>; epgPhases?: Record<string, number> };
  memory?: { peakDuringSyncMb: number; idleMb: number | null; peakDuringResyncMb?: number };
  dbMb?: number;
  scenarios?: Record<string, Record<string, Timing>>;
  duringResync?: { resyncMs: number; samples: number; requests: Record<string, Timing> };
  web?: { initialJsGzipKb: number; files: { file: string; gzipKb: number }[]; totalJsGzipKb: number };
}
const report: Report = { size, node: process.version, cpus: os.cpus().length };

function dirSize(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return n;
}

/** Times every url (one warm-up, then RUNS runs). */
async function timeAll(stack: Stack, urls: Record<string, string>): Promise<Record<string, Timing>> {
  const out: Record<string, Timing> = {};
  for (const [name, url] of Object.entries(urls)) {
    await stack.time(url, 1);
    out[name] = timing(await stack.time(url, RUNS));
  }
  return out;
}

async function searchTiming(stack: Stack): Promise<{ all: Timing; short: Timing; slowest: [string, number][] }> {
  const all: number[] = [];
  const short: number[] = [];
  const perQuery: [string, number][] = [];
  for (const q of SEARCH_QUERIES) {
    const t = await stack.time(`/api/search?q=${encodeURIComponent(q)}`, 5);
    all.push(...t);
    if (q.length <= 3) short.push(...t);
    perQuery.push([q, timing(t).p50]);
  }
  return { all: timing(all), short: timing(short), slowest: perQuery.sort((a, b) => b[1] - a[1]).slice(0, 3) };
}

/** The requests the app makes for its main screens. */
async function screenUrls(stack: Stack): Promise<Record<string, string>> {
  const liveCats = await stack.get<Category[]>('/api/categories?kind=live');
  const movieCats = await stack.get<Category[]>('/api/categories?kind=movie');
  const seriesCats = await stack.get<Category[]>('/api/categories?kind=series');
  const live = await stack.get<Page<LiveChannelWithNow>>('/api/live?limit=1');
  const movies = await stack.get<Page<unknown>>('/api/movies?limit=1');
  const guide = await stack.get<Page<LiveChannelWithNow>>('/api/live?hasEpg=1&offset=0&limit=30');
  const ids = guide.items.map((c) => c.id).join(',');
  const now = Date.now();
  const bigCat = (cats: Category[]) => cats[Math.min(3, cats.length - 1)]?.id ?? '';
  return {
    'categories (live)': '/api/categories?kind=live',
    'live: first page': '/api/live?offset=0&limit=60',
    'live: category page': `/api/live?categoryId=${liveCats[Math.floor(liveCats.length / 2)]?.id ?? ''}&offset=0&limit=60`,
    'live: deep page': `/api/live?offset=${Math.max(0, live.total - 60)}&limit=60`,
    'live: with guide only': '/api/live?hasEpg=1&offset=0&limit=60',
    'live: 500 (player zapping)': '/api/live?offset=0&limit=500',
    'movies: first page': '/api/movies?offset=0&limit=60',
    'movies: category row (20)': `/api/movies?categoryId=${bigCat(movieCats)}&offset=0&limit=20`,
    'movies: category page 3': `/api/movies?categoryId=${bigCat(movieCats)}&offset=120&limit=60`,
    'movies: deep page': `/api/movies?offset=${Math.max(0, movies.total - 60)}&limit=60`,
    'series: first page': '/api/series?offset=0&limit=60',
    'series: category page': `/api/series?categoryId=${bigCat(seriesCats)}&offset=0&limit=60`,
    'guide: 30 channels x 6 h': `/api/epg?channelIds=${ids}&from=${now - 2 * 3600_000}&to=${now + 4 * 3600_000}`,
    favorites: '/api/favorites',
    'favorites items': '', // filled in after seeding
    'continue watching': '/api/continue',
  };
}

async function seedUserData(stack: Stack): Promise<string> {
  const live = await stack.get<Page<{ id: string }>>('/api/live?offset=100&limit=20');
  const movies = await stack.get<Page<{ id: string }>>('/api/movies?offset=500&limit=40');
  const series = await stack.get<Page<{ id: string }>>('/api/series?offset=50&limit=10');
  const put = (url: string, body: unknown) => stack.get(url, { method: 'PUT', body: JSON.stringify(body) });
  for (const c of live.items) await put('/api/favorites', { kind: 'live', id: c.id, favorite: true });
  for (const m of movies.items.slice(0, 20)) await put('/api/favorites', { kind: 'movie', id: m.id, favorite: true });
  for (const x of series.items) await put('/api/favorites', { kind: 'series', id: x.id, favorite: true });
  for (const m of movies.items.slice(10)) await put('/api/progress', { kind: 'movie', id: m.id, position: 600, duration: 5400 });
  for (const x of series.items.slice(0, 5)) {
    const d = await stack.get<{ seasons: { episodes: { id: string }[] }[] }>(`/api/series/${x.id}`);
    const ep = d.seasons[0]?.episodes[0];
    if (ep) await put('/api/progress', { kind: 'episode', id: ep.id, position: 300, duration: 2700 });
  }
  return `/api/items?live=${live.items.map((c) => c.id).join(',')}&movie=${movies.items.slice(0, 20).map((m) => m.id).join(',')}&series=${series.items.map((x) => x.id).join(',')}`;
}

async function scenario(stack: Stack, itemsUrl: string): Promise<Record<string, Timing>> {
  const urls = await screenUrls(stack);
  urls['favorites items'] = itemsUrl;
  const out = await timeAll(stack, urls);
  const s = await searchTiming(stack);
  out['search: all queries'] = s.all;
  out['search: 1-3 letters'] = s.short;
  log(`  slowest searches: ${s.slowest.map(([q, ms]) => `"${q}" ${ms} ms`).join(', ')}`);
  return out;
}

/** Re-syncs with the catalog in place and times app requests meanwhile (is the app usable?). */
async function duringResync(stack: Stack): Promise<NonNullable<Report['duringResync']> & { peak: number }> {
  const urls = {
    'live: first page': '/api/live?offset=0&limit=60',
    'movies: category row (20)': '/api/movies?offset=0&limit=20',
    'search "sky"': '/api/search?q=sky',
    'guide: 30 channels x 6 h': (await screenUrls(stack))['guide: 30 channels x 6 h']!,
  };
  const samples: Record<string, number[]> = Object.fromEntries(Object.keys(urls).map((k) => [k, []]));
  const before = stack.syncLogs.length;
  const started = Date.now();
  await stack.get('/api/source/sync', { method: 'POST', body: '{}' });
  let peak = 0;
  let n = 0;
  while (stack.syncLogs.length < before + 2 && Date.now() - started < 15 * 60_000) {
    for (const [name, url] of Object.entries(urls)) {
      samples[name]!.push(...(await stack.time(url, 1)));
      n++;
    }
    peak = Math.max(peak, rssOf(stack.serverPid)?.rss ?? 0);
    await sleep(100);
  }
  return {
    resyncMs: Date.now() - started,
    samples: n,
    requests: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, timing(v)])),
    peak,
  };
}

/** Initial JS of the production web build: the entry script and its modulepreloads, gzipped. */
function webBundle(): Report['web'] {
  const out = mkdtempSync(path.join(os.tmpdir(), 'anycast-web-'));
  try {
    const r = spawnSync('pnpm', ['--filter', '@anycast/web', 'exec', 'vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: repo, stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (r.status !== 0) throw new Error('vite build failed');
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    const initial = new Set<string>();
    for (const m of html.matchAll(/<script[^>]+src="\/?([^"]+\.js)"/g)) initial.add(m[1]!);
    for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?([^"]+\.js)"/g)) initial.add(m[1]!);
    const gz = (f: string) => Math.round(gzipSync(readFileSync(path.join(out, f)), { level: 9 }).length / 102.4) / 10;
    const files = [...initial].map((file) => ({ file, gzipKb: gz(file) }));
    const all = readdirSync(path.join(out, 'assets')).filter((f) => f.endsWith('.js'));
    return {
      initialJsGzipKb: Math.round(files.reduce((a, f) => a + f.gzipKb, 0) * 10) / 10,
      files,
      totalJsGzipKb: Math.round(all.reduce((a, f) => a + gz(`assets/${f}`), 0) * 10) / 10,
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function printTable(): void {
  const lines: string[] = [];
  const p = (s = '') => lines.push(s);
  p(`\n## AnyCast performance (${size} mock, Node ${report.node}, ${report.cpus} CPUs)\n`);
  if (report.counts) p(`Catalog: ${report.counts.live} live, ${report.counts.movie} movies, ${report.counts.series} series; ${report.sync?.programs ?? '?'} guide programmes\n`);
  if (report.sync) {
    p('| Sync | ms |\n|---|---:|');
    p(`| catalog total | ${report.sync.catalogMs} |`);
    for (const [k, v] of Object.entries(report.sync.catalogPhases ?? {})) p(`| catalog: ${k} | ${v} |`);
    p(`| EPG total | ${report.sync.epgMs} |`);
    for (const [k, v] of Object.entries(report.sync.epgPhases ?? {})) p(`| EPG: ${k} | ${v} |`);
    p();
  }
  if (report.memory) {
    p(`Memory: peak during first sync ${report.memory.peakDuringSyncMb} MB, idle ${report.memory.idleMb} MB, peak during re-sync ${report.memory.peakDuringResyncMb ?? '?'} MB. DB ${report.dbMb} MB.\n`);
  }
  if (report.scenarios) {
    const names = Object.keys(report.scenarios);
    const rows = Object.keys(report.scenarios[names[0]!]!);
    p(`| Request (p50 / p95 ms) | ${names.join(' | ')} |`);
    p(`|---|${names.map(() => '---:').join('|')}|`);
    for (const r of rows) p(`| ${r} | ${names.map((n) => { const t = report.scenarios![n]![r]; return t ? `${t.p50} / ${t.p95}` : '-'; }).join(' | ')} |`);
    p();
  }
  if (report.duringResync) {
    p(`During a re-sync (${Math.round(report.duringResync.resyncMs / 1000)} s, ${report.duringResync.samples} requests):\n`);
    p('| Request | p50 | p95 | max |\n|---|---:|---:|---:|');
    for (const [k, t] of Object.entries(report.duringResync.requests)) p(`| ${k} | ${t.p50} | ${t.p95} | ${t.max} |`);
    p();
  }
  if (report.web) p(`Web: initial JS ${report.web.initialJsGzipKb} KB gzipped (${report.web.files.map((f) => `${f.file} ${f.gzipKb}`).join(', ')}); all JS ${report.web.totalJsGzipKb} KB.\n`);
  // PRD targets (sized for 50k items; this runs ~4x that)
  const searchP95 = Math.max(...Object.values(report.scenarios ?? {}).map((s) => s['search: all queries']?.p95 ?? 0));
  const checks: [string, number | null | undefined, number, string][] = [
    ['catalog sync', report.sync?.catalogMs, 120_000, 'ms'],
    ['idle RSS', report.memory?.idleMb, 300, 'MB'],
    ['search p95', searchP95, 150, 'ms'],
    ['initial JS gzipped', report.web?.initialJsGzipKb, 300, 'KB'],
  ];
  p('| PRD target | measured | limit | |\n|---|---:|---:|---|');
  for (const [name, v, limit, unit] of checks) {
    if (v === undefined || v === null) continue;
    p(`| ${name} | ${v} ${unit} | ${limit} ${unit} | ${v < limit ? 'ok' : 'MISSED'} |`);
  }
  p();
  process.stdout.write(lines.join('\n'));
}

async function main(): Promise<void> {
  log(`starting mock (${size}) and server, first sync...`);
  const stack = await startStack({ size, logLevel: 'info', syncTimeoutMs: 15 * 60_000 });
  try {
    report.counts = stack.counts;
    const cat = stack.syncLogs.find((l) => l.msg === 'catalog sync finished');
    const epg = stack.syncLogs.find((l) => l.msg === 'epg sync finished');
    report.sync = {
      catalogMs: stack.catalogSyncMs, epgMs: stack.epgSyncMs, programs: epg?.programs, catalogPhases: cat?.phases, epgPhases: epg?.phases,
    };
    log(`synced: catalog ${stack.catalogSyncMs} ms, EPG ${stack.epgSyncMs} ms; settling 10 s`);
    await sleep(10_000);
    report.memory = { peakDuringSyncMb: stack.peakRssDuringSync, idleMb: rssOf(stack.serverPid)?.rss ?? null };
    report.dbMb = mb(dirSize(stack.dataDir));

    const itemsUrl = await seedUserData(stack);
    report.scenarios = {};
    log('measuring: no hide rules');
    report.scenarios['no rules'] = await scenario(stack, itemsUrl);

    const tags = await stack.get<{ countries: TagSummary[] }>('/api/tags');
    // hide the biggest countries except the user's own (de) and the English ones
    const hidden = tags.countries.map((c) => c.country!).filter((c) => !['de', 'gb', 'us'].includes(c)).slice(0, 8);
    await stack.get('/api/hide-rules', { method: 'PUT', body: JSON.stringify({ countries: hidden, languages: [], categoryIds: [] }) });
    log(`measuring: ${hidden.length} countries hidden (${hidden.join(', ')})`);
    report.scenarios[`${hidden.length} countries hidden`] = await scenario(stack, itemsUrl);

    await stack.get('/api/adult/pin', { method: 'PUT', body: JSON.stringify({ pin: '2468', password: ADMIN_PASSWORD }) });
    await stack.get('/api/adult/settings', { method: 'PUT', body: JSON.stringify({ mode: 'locked', pin: '2468' }) });
    log('measuring: countries hidden + adult lock on');
    report.scenarios['+ adult locked'] = await scenario(stack, itemsUrl);

    log('measuring: requests during a re-sync');
    const rs = await duringResync(stack);
    report.duringResync = { resyncMs: rs.resyncMs, samples: rs.samples, requests: rs.requests };
    report.memory.peakDuringResyncMb = rs.peak;
  } finally {
    await stack.stop();
  }
  if (!args['no-web']) {
    log('building the web app');
    report.web = webBundle();
  }
  printTable();
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
}

await main();
