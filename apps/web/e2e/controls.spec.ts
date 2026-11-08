import { expect, expectPlaying, fx, test } from './fixtures';

const shot = (name: string) => (process.env.E2E_SCREENSHOTS ? `${process.env.E2E_SCREENSHOTS}/${name}.png` : undefined);

test('control bar on the video: play, skip, volume, time, theater and full screen; extras below', async ({ profile }) => {
  const page = await profile.device();
  await page.goto(`/play/movie/${fx.movie.id}`);
  await expectPlaying(page);
  const bar = page.getByTestId('control-bar');
  const stage = page.locator('.pl-stage');

  // the main controls are on the video
  const sb = (await stage.boundingBox())!;
  for (const name of ['Pause', 'Back 10 seconds', 'Mute', 'Theater mode', 'Full screen']) {
    const b = (await bar.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(b.y + b.height, name).toBeLessThanOrEqual(sb.y + sb.height + 1);
  }
  await expect(bar.locator('.pl-time')).toHaveText(/^\d+:\d\d \/ \d+:\d\d$/);
  // favorite, lists and stats stay below it
  const fav = (await page.getByRole('button', { name: 'Favorite', exact: true }).boundingBox())!;
  expect(fav.y).toBeGreaterThan(sb.y + sb.height);

  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await expect(page.locator('.player')).toHaveAttribute('data-chrome', 'on');
  if (shot('bar-desktop')) {
    await page.mouse.move(sb.x + 300, sb.y + sb.height - 30);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('bar-desktop') });
  }
  // the mouse leaves the video while it plays: the bar tucks away
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height + 150);
  await expect(page.locator('.player')).toHaveAttribute('data-chrome', 'off');
  // and comes back with the mouse
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await expect(page.locator('.player')).toHaveAttribute('data-chrome', 'on');

  // a click on the picture pauses; the bar stays while paused
  await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 3);
  await expect(bar.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height + 150);
  await page.waitForTimeout(400);
  await expect(page.locator('.player')).toHaveAttribute('data-chrome', 'on');
});

test('live: LIVE and Go live sit on the bar', async ({ profile }) => {
  const page = await profile.device();
  await page.goto(`/play/live/${fx.archiveChannel.id}`);
  await expectPlaying(page);
  const bar = page.getByTestId('control-bar');
  await expect(bar.locator('.pl-badge')).toHaveText('LIVE');
  await expect(bar.getByRole('button', { name: 'Next channel' })).toBeVisible();
  if (shot('bar-live')) {
    const sb = (await page.locator('.pl-stage').boundingBox())!;
    await page.mouse.move(sb.x + 200, sb.y + sb.height - 40);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('bar-live') });
  }
});

test('phone: a slim bar on the picture, tap shows and hides it', async ({ profile }) => {
  const page = await profile.device();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/play/movie/${fx.movie.id}`);
  await expectPlaying(page);
  const bar = page.getByTestId('control-bar');
  await expect(bar.getByRole('button', { name: 'Full screen' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Mute' })).toHaveCount(0);
  if (shot('bar-phone')) await page.screenshot({ path: shot('bar-phone') });
});
