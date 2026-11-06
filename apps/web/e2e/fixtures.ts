/**
 * Test fixtures: every test gets its own profile (so favorites, preferences and filters never leak
 * between tests running in parallel) and opens "devices" (browser contexts) signed in to it.
 */
import { expect, request, test as base, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import type { Preferences } from '@anycast/shared';
import type { E2EFixtures } from './env';

export const fx: E2EFixtures = JSON.parse(process.env.E2E_FIXTURES ?? '{}') as E2EFixtures;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface ProfileOptions {
  /** false shows the first-run setup */
  setupDone: boolean;
  prefs?: DeepPartial<Preferences>;
  favorites?: { kind: 'live' | 'movie' | 'series'; id: string }[];
}

export interface TestProfile {
  id: string;
  /** API calls as this profile */
  api: APIRequestContext;
  /** A new browser context ("device") signed in and switched to this profile */
  device: () => Promise<Page>;
}

export const test = base.extend<{ profileOptions: ProfileOptions; profile: TestProfile }>({
  baseURL: async ({}, use) => use(process.env.E2E_BASE_URL),
  storageState: async ({}, use) => use(process.env.E2E_STATE),
  profileOptions: [{ setupDone: true }, { option: true }],
  profile: async ({ browser, profileOptions, baseURL, storageState }, use, info) => {
    const admin = await request.newContext({ baseURL, storageState });
    const res = await admin.post('/api/profiles', { data: { name: `e2e ${info.workerIndex}.${info.repeatEachIndex}.${info.retry} ${Math.random().toString(36).slice(2, 8)}` } });
    expect(res.ok()).toBe(true);
    const { id } = (await res.json()) as { id: string };
    const api = await request.newContext({ baseURL, storageState, extraHTTPHeaders: { 'x-anycast-profile': id } });
    if (profileOptions.setupDone || profileOptions.prefs) {
      expect((await api.put('/api/preferences', { data: { ...profileOptions.prefs, setupDone: profileOptions.setupDone } })).ok()).toBe(true);
    }
    for (const f of profileOptions.favorites ?? []) {
      expect((await api.put('/api/favorites', { data: { ...f, favorite: true } })).ok()).toBe(true);
    }

    const contexts: BrowserContext[] = [];
    const device = async () => {
      const ctx = await browser.newContext({ baseURL, storageState, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [`anycast.profile.${fx.userId}`, id] as const);
      contexts.push(ctx);
      return ctx.newPage();
    };

    await use({ id, api, device });

    for (const c of contexts) await c.close();
    await admin.delete(`/api/profiles/${id}`);
    await api.dispose();
    await admin.dispose();
  },
});

export { expect };

/* ---------------- player helpers ---------------- */

export const video = (page: Page) => page.locator('video');
export const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);

/** Waits until the video is actually advancing. */
export async function expectPlaying(page: Page, timeout = 30_000) {
  const t0 = await currentTime(page);
  await expect.poll(() => currentTime(page), { timeout, message: 'video should be playing' }).toBeGreaterThan(t0 + 0.3);
}

/** The live timeline's playhead (epoch ms), from the slider's aria-valuenow. */
export async function timelinePosition(page: Page): Promise<number> {
  return Number(await page.getByRole('slider', { name: 'Timeline' }).getAttribute('aria-valuenow'));
}

/** "21:46" for an epoch ms, in the page's time zone (how the app formats clock times). */
export function clockIn(page: Page, ms: number): Promise<string> {
  return page.evaluate((t) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, ms);
}

/** Waits until the page's realtime (SSE) connection is open, so events sent after this reach it. */
export function waitForEvents(page: Page) {
  return page.waitForResponse((r) => r.url().includes('/api/events'));
}
