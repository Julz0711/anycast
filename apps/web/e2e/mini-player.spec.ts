/**
 * Mini player: leaving the player keeps the same stream going in a corner while browsing.
 * The provider may allow one connection, so shrinking and expanding must never ask for a new stream.
 */
import type { Page } from '@playwright/test';
import { expect, expectPlaying, fx, test } from './fixtures';

/** Counts the stream requests the page makes (one per load of a channel or movie). */
function countPlayRequests(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/play\/(live|movie|episode)\//.test(new URL(r.url()).pathname)) seen.push(r.url());
  });
  return seen;
}

/** Tags the <video> element, so a check later can tell whether it is still the same one. */
const tagVideo = (page: Page) => page.locator('video').evaluate((v) => ((v as HTMLVideoElement & { __tag?: number }).__tag = 42));
const sameVideo = (page: Page) => page.locator('video').evaluate((v) => (v as HTMLVideoElement & { __tag?: number }).__tag === 42);

test('leaving the player keeps the channel playing in a mini player; expand and close', async ({ profile }) => {
  const page = await profile.device();
  const plays = countPlayRequests(page);
  await page.goto(`/play/live/${fx.archiveChannel.id}`);
  await expectPlaying(page);
  await tagVideo(page);
  expect(plays).toHaveLength(1);

  // Back: the app is usable and the stream carries on in the corner
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/live$/);
  const mini = page.getByRole('region', { name: 'Mini player' });
  await expect(mini).toBeVisible();
  await expect(mini).toContainText(fx.archiveChannel.name);
  await expect(mini).toContainText('LIVE');
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: 'screenshots/mini-desktop.png' });
  await expectPlaying(page);
  expect(await sameVideo(page)).toBe(true);
  expect(plays).toHaveLength(1);

  // browsing works under it, and the player's keys stay off (arrows don't zap)
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('m');
  await expect(page).toHaveURL(/\/movies$/);
  await expect(mini).toContainText(fx.archiveChannel.name);

  // pause and play from the mini player
  await mini.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await mini.getByRole('button', { name: 'Play', exact: true }).click();
  await expectPlaying(page);

  // expand: the full player again, same element, no new stream
  await mini.getByRole('button', { name: 'Expand player' }).click();
  await expect(page).toHaveURL(new RegExp(`/play/live/${fx.archiveChannel.id}$`));
  await expect(mini).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Timeline' })).toBeVisible();
  expect(await sameVideo(page)).toBe(true);
  await expectPlaying(page);
  expect(plays).toHaveLength(1);

  // back to the movies screen it came from, then close: playback stops and the connection is let go
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/movies$/);
  const stop = page.waitForRequest((r) => r.url().endsWith('/api/play/stop'));
  await mini.getByRole('button', { name: 'Close player' }).click();
  await stop;
  await expect(page.locator('video')).toHaveCount(0);
});

test('picking another channel from the mini player opens it full size', async ({ profile }) => {
  const page = await profile.device();
  const [first, second] = fx.zapChannels;
  await page.goto(`/play/live/${first}`);
  await expectPlaying(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Mini player' })).toBeVisible();
  // the address of another channel (a channel row navigates there the same way)
  await page.evaluate((id) => {
    history.pushState({ idx: 1 }, '', `/play/live/${id}`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, second);
  await expect(page.locator('.pl-meta-line')).toContainText(/^2 · /);
  await expect(page.getByRole('region', { name: 'Mini player' })).toHaveCount(0);
  await expectPlaying(page);
  await expect(page.locator('video')).toHaveCount(1);
});

test.describe(() => {
  test.use({ profileOptions: { setupDone: true, prefs: { player: { miniPlayer: false } } } });

  test('with the mini player off, leaving the player stops it', async ({ profile }) => {
    const page = await profile.device();
    await page.goto(`/play/movie/${fx.movie.id}`);
    await expectPlaying(page);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Mini player' })).toHaveCount(0);
    await expect(page.locator('video')).toHaveCount(0);
  });
});

test('phone: the mini player sits above the tab bar, drags to another corner and taps to expand', async ({ profile }) => {
  const page = await profile.device();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/play/movie/${fx.movie.id}`);
  await expectPlaying(page);
  await tagVideo(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const mini = page.getByRole('region', { name: 'Mini player' });
  await expect(mini).toBeVisible();
  await expect(mini).toHaveAttribute('data-corner', 'br');

  const box = (await mini.boundingBox())!;
  const bar = (await page.getByRole('navigation', { name: 'Main' }).boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: 'screenshots/mini-phone.png' });

  // drag it up to the top left; it docks there and stays there
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 60, y - 200, { steps: 4 });
  await page.mouse.move(80, 120, { steps: 6 });
  await page.mouse.up();
  await expect(mini).toHaveAttribute('data-corner', 'tl');
  expect(await page.evaluate(() => localStorage.getItem('anycast.miniCorner'))).toBe('tl');
  await expectPlaying(page);

  // a tap (no drag) expands it
  const b2 = (await mini.boundingBox())!;
  await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 3);
  await expect(page).toHaveURL(new RegExp(`/play/movie/${fx.movie.id}`));
  expect(await sameVideo(page)).toBe(true);
});
