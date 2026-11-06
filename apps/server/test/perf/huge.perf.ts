/**
 * Opt-in scale test against a provider the size of a large real panel (~195k items):
 *   pnpm --filter @anycast/server test:perf
 * Takes a few minutes. Prints a report and fails when a target is missed.
 */
import type { Category, HideRules, LiveChannelWithNow, Page, SearchResults, TagSummary } from '@anycast/shared';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { rssOf, SEARCH_QUERIES, startStack, timing, type Stack, type Timing } from './harness';

const TARGETS = { catalogSyncMs: 120_000, idleRssMb: 300, searchP95Ms: 150, pageP95Ms: 100 };

let stack: Stack;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  stack = await startStack({ size: 'huge' });
  report.counts = stack.counts;
  report.catalogSyncS = Math.round(stack.catalogSyncMs / 100) / 10;
  report.epgSyncS = Math.round(stack.epgSyncMs / 100) / 10;
  report.peakRssDuringSyncMb = stack.peakRssDuringSync;
}, 900_000);

afterAll(async () => {
  console.log(`\nscale report (huge mock)\n${JSON.stringify(report, null, 2)}\n`);
  await stack?.stop();
});

async function searchTimings(): Promise<{ all: Timing; perQuery: Record<string, number> }> {
  const all: number[] = [];
  const perQuery: Record<string, number> = {};
  for (const q of SEARCH_QUERIES) {
    const t = await stack.time(`/api/search?q=${encodeURIComponent(q)}`, 5);
    all.push(...t);
    perQuery[q] = timing(t).p50;
  }
  return { all: timing(all), perQuery };
}

async function pageTimings(): Promise<Record<string, Timing>> {
  const cats = await stack.get<Category[]>('/api/categories?kind=live');
  const movieCats = await stack.get<Category[]>('/api/categories?kind=movie');
  const live = await stack.get<Page<LiveChannelWithNow>>('/api/live?limit=1');
  const movies = await stack.get<Page<unknown>>('/api/movies?limit=1');
  const ids = (await stack.get<Page<LiveChannelWithNow>>('/api/live?offset=0&limit=40')).items.map((c) => c.id).join(',');
  const now = Date.now();
  const urls: Record<string, string> = {
    'live first page': '/api/live?offset=0&limit=100',
    'live deep page': `/api/live?offset=${Math.max(0, live.total - 100)}&limit=100`,
    'live category': `/api/live?categoryId=${cats[Math.floor(cats.length / 2)]?.id ?? ''}&limit=100`,
    'live with guide': '/api/live?hasEpg=1&offset=0&limit=100',
    'movies first page': '/api/movies?offset=0&limit=100',
    'movies deep page': `/api/movies?offset=${Math.max(0, movies.total - 100)}&limit=100`,
    'movies category': `/api/movies?categoryId=${movieCats[3]?.id ?? ''}&limit=100`,
    'series first page': '/api/series?offset=0&limit=100',
    'categories live': '/api/categories?kind=live',
    'categories movie': '/api/categories?kind=movie',
    tags: '/api/tags',
    'epg 40 channels, 6 h': `/api/epg?channelIds=${ids}&from=${now - 3 * 3600_000}&to=${now + 3 * 3600_000}`,
  };
  const out: Record<string, Timing> = {};
  for (const [name, url] of Object.entries(urls)) {
    await stack.time(url, 1); // warm up (caches, first statement preparation)
    out[name] = timing(await stack.time(url, 7));
  }
  return out;
}

test('catalog sync time and memory', async () => {
  expect(stack.counts.live).toBeGreaterThan(19_000);
  expect(stack.counts.movie).toBeGreaterThan(139_000);
  expect(stack.counts.series).toBeGreaterThan(35_000);
  // settle, then look at the idle footprint
  await new Promise((r) => setTimeout(r, 10_000));
  const mem = rssOf(stack.serverPid);
  report.idleRssMb = mem?.rss ?? null;
  expect(stack.catalogSyncMs).toBeLessThan(TARGETS.catalogSyncMs);
  if (mem) expect(mem.rss).toBeLessThan(TARGETS.idleRssMb);
});

test('search, pages, categories and guide stay fast', async () => {
  const s = await searchTimings();
  report.search = s.all;
  report.searchSlowest = Object.entries(s.perQuery).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const pages = await pageTimings();
  report.pages = pages;
  expect(s.all.p95).toBeLessThan(TARGETS.searchP95Ms);
  for (const [name, t] of Object.entries(pages)) expect(t.p95, name).toBeLessThan(TARGETS.pageP95Ms);
  const r = await stack.get<SearchResults>('/api/search?q=a');
  expect(r.live.length).toBeLessThanOrEqual(50);
  expect(r.movies.length).toBeLessThanOrEqual(50);
});

test('with everything but English hidden, queries stay fast', async () => {
  const tags = await stack.get<{ languages: TagSummary[]; countries: TagSummary[] }>('/api/tags');
  const rules: HideRules = {
    languages: tags.languages.map((l) => l.language!).filter((l) => l !== 'en'),
    countries: tags.countries.filter((c) => c.language !== 'en').map((c) => c.country!),
    categoryIds: [],
  };
  await stack.get('/api/hide-rules', { method: 'PUT', body: JSON.stringify(rules) });
  const live = await stack.get<Page<LiveChannelWithNow>>('/api/live?limit=1');
  report.hiddenLiveTotal = live.total;
  const s = await searchTimings();
  report.hiddenSearch = s.all;
  const pages = await pageTimings();
  report.hiddenPages = pages;
  expect(live.total).toBeLessThan(stack.counts.live / 2);
  expect(s.all.p95).toBeLessThan(TARGETS.searchP95Ms);
  for (const [name, t] of Object.entries(pages)) expect(t.p95, name).toBeLessThan(TARGETS.pageP95Ms);
});
