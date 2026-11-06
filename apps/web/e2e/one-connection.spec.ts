/**
 * A subscription with a single provider connection (its own mock + server, see global-setup):
 * zapping never holds two streams, and a second device can take the connection over.
 */
import { request, type Browser, type Page } from '@playwright/test';
import { expect, expectPlaying, test } from './fixtures';
import type { OneConnectionStack } from './env';

const one: OneConnectionStack = JSON.parse(process.env.E2E_ONE ?? '{}') as OneConnectionStack;

async function makeProfile(name: string) {
  const admin = await request.newContext({ baseURL: one.base, storageState: one.state });
  const res = await admin.post('/api/profiles', { data: { name } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  expect((await admin.put('/api/preferences', { data: { setupDone: true }, headers: { 'x-anycast-profile': id } })).ok()).toBe(true);
  return { id, name, dispose: async () => (await admin.delete(`/api/profiles/${id}`), await admin.dispose()) };
}

async function device(browser: Browser, profileId: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: one.base, storageState: one.state, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [`anycast.profile.${one.userId}`, profileId] as const);
  return ctx.newPage();
}

const mockState = async () => (await (await fetch(`${one.mockUrl}/__mock/state`)).json()) as { activeConnections: number; peakConnections: number };

test('one connection: zapping holds one stream at a time, and device B takes over from device A', async ({ browser }) => {
  test.setTimeout(120_000);
  const anna = await makeProfile(`Anna ${Math.random().toString(36).slice(2, 6)}`);
  const ben = await makeProfile(`Ben ${Math.random().toString(36).slice(2, 6)}`);
  try {
    // the first H.264 channels of the list (the mock puts HEVC at 4 and AC-3 at 8)
    const admin = await request.newContext({ baseURL: one.base, storageState: one.state });
    const live = ((await (await admin.get('/api/live?limit=3')).json()) as { items: { id: string; name: string }[] }).items;
    await admin.dispose();
    const [first, second, third] = live as [{ id: string; name: string }, { id: string; name: string }, { id: string; name: string }];

    // device A zaps through three channels; the provider never sees two connections
    const a = await device(browser, anna.id);
    await a.goto(`/play/live/${first.id}`);
    await expectPlaying(a);
    await a.keyboard.press('ArrowDown');
    await expect(a).toHaveURL(new RegExp(`/play/live/${second.id}$`));
    await expectPlaying(a);
    await a.keyboard.press('ArrowDown');
    await expect(a).toHaveURL(new RegExp(`/play/live/${third.id}$`));
    await expectPlaying(a);
    expect((await mockState()).peakConnections).toBe(1);
    // admins see why channels can't be pinned instead of a toggle that cannot work
    await expect(a.getByTestId('pin-unavailable')).toContainText('one stream at a time');
    await expect(a.getByRole('button', { name: 'Keep a rewind buffer for this channel' })).toHaveCount(0);

    // device B, another profile, wants another channel: it is told who is watching
    // (A's realtime connection has been open since its first page load)
    const b = await device(browser, ben.id);
    await b.goto(`/play/live/${first.id}`);
    const alert = b.getByRole('alert');
    await expect(alert.getByRole('heading')).toHaveText(`${anna.name} is watching ${third.name}`);
    await expect(alert).toContainText('Watch here instead?');
    await alert.getByRole('button', { name: 'Take over' }).click();
    await expectPlaying(b);

    // device A stops and says why, with a way back
    const moved = a.getByTestId('playback-moved');
    await expect(moved.getByRole('heading')).toHaveText('Playback moved to another device');
    await expect(moved).toContainText(`${ben.name} started watching on Chrome on`);
    await expect(moved.getByRole('button', { name: 'Resume' })).toBeVisible();
    expect((await mockState()).peakConnections).toBe(1);
    // B keeps playing: A's old player does not take the connection back
    await expectPlaying(b);
  } finally {
    await anna.dispose();
    await ben.dispose();
  }
});

