/**
 * Scrub thumbnails (PB-1): the server cuts them from what it streams for playback, so after a
 * movie played for a bit, hovering the scrubber over that part shows its picture; over a part
 * nobody played the card shows only the time.
 * E2E_SCREENSHOTS=1 also writes screenshots/thumbs-{desktop,phone}.png.
 */
import type { Page } from '@playwright/test';
import { currentTime, expect, expectPlaying, fx, test, video } from './fixtures';

const shots = !!process.env.E2E_SCREENSHOTS;

/** Moves the pointer over the seek bar at `t` seconds (mouse hover; touch drags use the same card). */
async function hoverAt(page: Page, t: number) {
  const bar = page.getByRole('slider', { name: 'Seek' });
  const box = (await bar.boundingBox())!;
  const duration = Number(await bar.getAttribute('aria-valuemax'));
  // aim at the middle of that second, so pixel rounding cannot land on the one before
  await page.mouse.move(box.x + (box.width * (t + 0.5)) / duration, box.y + box.height / 2);
}

async function showControls(page: Page) {
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 320);
}

test('hovering the scrubber over a played part shows its thumbnail; an unplayed part shows only the time', async ({ profile }) => {
  test.setTimeout(90_000);
  const page = await profile.device();
  // The remuxer may run ahead of playback, so which parts already have frames depends on timing.
  // Keep the index to the first two minutes so 2:40 is reliably uncovered; the server tests check
  // which parts get frames.
  await page.route(/\/api\/thumbs\/movie\/\d+$/, async (route) => {
    const res = await route.fetch();
    const index = (await res.json()) as { tiles: { start: number }[] };
    await route.fulfill({ response: res, json: { ...index, tiles: index.tiles.filter((t) => t.start < 120) } });
  });
  await page.goto(`/play/movie/${fx.hlsMovie.id}`);
  await expectPlaying(page);
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.duration), { timeout: 20_000 }).toBeGreaterThan(170);
  // jump to 1:00 and let it play on a little: the server now has frames of 0:00.. and 1:00..
  await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = 60));
  await expect.poll(() => currentTime(page)).toBeGreaterThan(62);

  const preview = page.getByTestId('scrub-preview');
  const thumb = page.getByTestId('scrub-thumb');
  await expect(async () => {
    await showControls(page);
    await hoverAt(page, 5);
    await expect(preview).toBeVisible({ timeout: 1000 });
    await expect(thumb).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 40_000 });
  await expect(preview).toContainText('0:0');
  const style = await thumb.getAttribute('style');
  expect(style).toMatch(/\/api\/thumbs\/movie\/\d+\/sheet\/0\.jpg\?v=\d+/);
  // the sprite actually loads
  const sheet = await page.request.get(/url\("([^"]+)"\)/.exec(style!)![1]!);
  expect(sheet.status()).toBe(200);
  expect(sheet.headers()['content-type']).toBe('image/jpeg');

  // 1:00 played as well (its frame can take a moment on a slow machine)
  await expect(async () => {
    await showControls(page);
    await hoverAt(page, 61);
    await expect(thumb).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 40_000 });
  await expect(preview).toContainText('1:01');
  if (shots) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'screenshots/thumbs-desktop.png' });
  }

  // no frame for 2:40: the same card, time only
  await hoverAt(page, 160);
  await expect(preview).toContainText('2:40');
  await expect(thumb).toHaveCount(0);

  // the card follows the pointer and leaves with it
  await page.mouse.move(10, 10);
  await expect(preview).toHaveCount(0);

  if (shots) {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(async () => {
      await page.mouse.move(195, 300);
      await hoverAt(page, 62);
      await expect(thumb).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'screenshots/thumbs-phone.png' });
  }
});

test('keyboard skips show the preview where they land', async ({ profile }) => {
  const page = await profile.device();
  // The remuxer may run ahead of playback, so which parts already have frames depends on timing.
  // Keep the index to the first two minutes so 2:40 is reliably uncovered; the server tests check
  // which parts get frames.
  await page.route(/\/api\/thumbs\/movie\/\d+$/, async (route) => {
    const res = await route.fetch();
    const index = (await res.json()) as { tiles: { start: number }[] };
    await route.fulfill({ response: res, json: { ...index, tiles: index.tiles.filter((t) => t.start < 120) } });
  });
  await page.goto(`/play/movie/${fx.hlsMovie.id}`);
  await expectPlaying(page);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('scrub-preview')).toBeVisible();
  await expect(page.getByTestId('scrub-preview')).toHaveCount(0, { timeout: 5000 });
});
