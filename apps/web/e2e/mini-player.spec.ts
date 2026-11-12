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

test('phone: the mini player is a now bar on the tab bar; it zaps, and a tap or a swipe up opens the player', async ({ profile }) => {
  const page = await profile.device();
  await page.setViewportSize({ width: 390, height: 844 });
  const plays = countPlayRequests(page);
  const [first, second] = fx.zapChannels;
  await page.goto(`/play/live/${first}`);
  await expectPlaying(page);
  await tagVideo(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/live$/);
  const bar = page.getByRole('region', { name: 'Now playing' });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('data-dock', 'bar');
  await expect(bar).toContainText('LIVE');
  // no picture in a corner: a strip across the screen, sitting on the tab bar
  await expect(page.getByRole('region', { name: 'Mini player' })).toHaveCount(0);
  const tabs = (await page.getByRole('navigation', { name: 'Main' }).boundingBox())!;
  await expect.poll(async () => Math.abs((await bar.boundingBox())!.y + (await bar.boundingBox())!.height - tabs.y)).toBeLessThanOrEqual(1);
  const box = (await bar.boundingBox())!;
  expect(box.width).toBeGreaterThan(350);
  expect(box.height).toBeLessThanOrEqual(60);
  // the page ends above the bar, not under it
  expect(await page.locator('#main').evaluate((m) => m.getBoundingClientRect().bottom)).toBeLessThanOrEqual(box.y + 1);
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: 'screenshots/mini-phone.png' });
  await expectPlaying(page);
  expect(await sameVideo(page)).toBe(true);
  expect(plays).toHaveLength(1);

  // channel down: the next channel plays in the bar, the page stays
  await bar.getByRole('button', { name: 'Next channel' }).click();
  await expect.poll(() => plays.length).toBe(2);
  expect(plays[1]).toContain(`/api/play/live/${second}`);
  await expect(page).toHaveURL(/\/live$/);
  await expectPlaying(page);

  // a swipe up from the title opens the player, once (Back returns to the list)
  const title = (await bar.getByRole('button', { name: /^Now playing: / }).boundingBox())!;
  const x = title.x + title.width / 2;
  const y = title.y + title.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 30, { steps: 3 });
  await page.mouse.move(x, y - 70, { steps: 3 });
  await page.mouse.up();
  await expect(page).toHaveURL(new RegExp(`/play/live/${second}$`));
  await expect(bar).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/live$/);
  await expect(bar).toBeVisible();

  // a tap on the picture opens it too, and so does the title; no new stream either way
  const b2 = (await bar.boundingBox())!;
  await page.mouse.click(b2.x + 36, b2.y + b2.height / 2);
  await expect(page).toHaveURL(new RegExp(`/play/live/${second}$`));
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await bar.getByRole('button', { name: /^Now playing: / }).click();
  await expect(page).toHaveURL(new RegExp(`/play/live/${second}$`));
  expect(plays).toHaveLength(2);

  // closing it gives the room back to the page
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await bar.getByRole('button', { name: 'Close player' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  await expect.poll(() => page.locator('#main').evaluate((m) => Math.round(m.getBoundingClientRect().bottom))).toBe(Math.round(tabs.y));
});

test('phone: Movies and Series share the Watch tab, which reopens the one used last', async ({ profile }) => {
  const page = await profile.device();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  const tabs = page.getByRole('navigation', { name: 'Main' });
  await expect(tabs.getByRole('link')).toHaveText(['Home', 'Live', 'Watch', 'Library']);
  await tabs.getByRole('link', { name: 'Watch' }).click();
  await expect(page).toHaveURL(/\/movies$/);
  await expect(tabs.getByRole('link', { name: 'Watch' })).toHaveAttribute('aria-current', 'page');
  // the title is the switch
  const sw = page.getByRole('navigation', { name: 'Watch' });
  await expect(sw.getByRole('link', { name: 'Movies' })).toHaveAttribute('aria-current', 'page');
  await sw.getByRole('link', { name: 'Series' }).click();
  await expect(page).toHaveURL(/\/series$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Series' })).toBeAttached();
  await tabs.getByRole('link', { name: 'Home' }).click();
  await tabs.getByRole('link', { name: 'Watch' }).click();
  await expect(page).toHaveURL(/\/series$/);
});

test('desktop: the mini player resizes by dragging its grip, remembered on the device', async ({ profile }) => {
  const page = await profile.device();
  await page.goto(`/play/live/${fx.archiveChannel.id}`);
  await expectPlaying(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const mini = page.getByRole('region', { name: 'Mini player' });
  await expect(mini).toHaveAttribute('data-corner', 'br');
  // the layout width: the frame scales in for a moment when it appears
  const width = () => mini.evaluate((el) => (el as HTMLElement).offsetWidth);
  const before = await width();
  const grip = mini.getByRole('button', { name: 'Resize the mini player' });
  // docked bottom right, the grip is its top left corner: pulling it up and left grows the player
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x - 60, g.y - 30, { steps: 4 });
  await page.mouse.move(g.x + g.width / 2 - 150, g.y + g.height / 2 - 80, { steps: 4 });
  await page.mouse.up();
  await expect.poll(width).toBe(before + 150);
  expect(await mini.evaluate((el) => Math.abs((el as HTMLElement).offsetWidth / (el as HTMLElement).offsetHeight - 16 / 9))).toBeLessThan(0.02);
  expect(await page.evaluate(() => localStorage.getItem('anycast.miniWidth'))).toBe(String(before + 150));
  // the drag was not a tap: still the mini player, still playing
  await expect(page).toHaveURL(/\/live$/);
  await expectPlaying(page);
  // the keyboard resizes it as well
  await grip.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(width).toBe(before + 118);
  // it comes back at that width
  await page.goto(`/play/live/${fx.archiveChannel.id}`);
  await expectPlaying(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect.poll(width).toBe(before + 118);
  // a preset size replaces the dragged width
  await mini.getByRole('button', { name: /^Mini player size: / }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('anycast.miniWidth'))).toBeNull();
  await expect.poll(width).not.toBe(before + 118);
});

test('the mini player has three sizes, remembered on the device', async ({ profile }) => {
  const page = await profile.device();
  await page.goto(`/play/live/${fx.archiveChannel.id}`);
  await expectPlaying(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const mini = page.getByRole('region', { name: 'Mini player' });
  await expect(mini).toHaveAttribute('data-size', 'm');
  const width = async () => (await mini.boundingBox())!.width;
  const medium = await width();
  await mini.getByRole('button', { name: /^Mini player size: Medium/ }).click();
  await expect(mini).toHaveAttribute('data-size', 'l');
  await expect.poll(width).toBeGreaterThan(medium + 50);
  await mini.getByRole('button', { name: /^Mini player size: Large/ }).click();
  await expect(mini).toHaveAttribute('data-size', 's');
  await expect.poll(width).toBeLessThan(medium - 30);
  // still small after a reload (the session is gone, so open it again)
  await page.goto(`/play/live/${fx.archiveChannel.id}`);
  await expectPlaying(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(mini).toHaveAttribute('data-size', 's');
});
