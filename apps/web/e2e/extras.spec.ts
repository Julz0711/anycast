import { expect, expectPlaying, fx, test } from './fixtures';

test('stats panel: I toggles it, it names the pipeline and codecs; Media Session has the title', async ({ profile }) => {
  const page = await profile.device();
  await page.goto(`/play/movie/${fx.hlsMovie.id}`);
  await expectPlaying(page);

  const panel = page.getByTestId('stats-panel');
  await expect(panel).toHaveCount(0);
  await page.keyboard.press('i');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-stat="source"]')).toHaveText('Movie');
  // MKV H.264 with E-AC-3 audio in Chromium: video copied, audio converted, HLS through hls.js
  await expect(panel.locator('[data-stat="pipeline"]')).toHaveText('Audio transcode (to AAC)');
  await expect(panel.locator('[data-stat="reason"]')).toContainText("E-AC-3 audio doesn't");
  await expect(panel.locator('[data-stat="container"]')).toHaveText('MKV');
  await expect(panel.locator('[data-stat="video"]')).toContainText(/^H\.264 · \d+×\d+/);
  await expect(panel.locator('[data-stat="audio"]')).toContainText(/^E-AC-3/);
  await expect(panel.locator('[data-stat="engine"]')).toHaveText('hls.js (MSE)');
  await expect(panel.locator('[data-stat="buffer"]')).toHaveText(/^\d+\.\d s$/);
  await expect(panel.locator('[data-stat="frames"]')).toContainText(/^\d[\d,]* \/ \d/);
  await expect(panel.locator('[data-stat="bitrate"]')).toContainText(/bit\/s/, { timeout: 20_000 });
  await expect(panel).not.toContainText('http');

  // the button shows the state, and I closes it again
  await expect(page.getByRole('button', { name: 'Stats', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('i');
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Stats', exact: true }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Close stats' }).click();
  await expect(panel).toHaveCount(0);

  // Media Session: lock screen / media keys know what is playing
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(fx.hlsMovie.name);
  expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe('playing');
  const art = await page.evaluate(() => navigator.mediaSession.metadata?.artwork.map((a) => a.src) ?? []);
  for (const src of art) expect(src).toMatch(/\/api\/art\//);

  // hiding the tab does not pause playback (background audio)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expectPlaying(page);

  // leaving the player clears the session
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata)).toBeNull();
});

test('picture in picture button follows browser support; P toggles it, not while typing', async ({ profile }) => {
  const page = await profile.device();
  await page.goto(`/play/movie/${fx.movie.id}`);
  await expectPlaying(page);
  const supported = await page.evaluate(() => document.pictureInPictureEnabled);
  const button = page.getByRole('button', { name: 'Picture in picture' });
  await expect(button).toHaveCount(supported ? 1 : 0);
  const inPip = () => page.evaluate(() => document.pictureInPictureElement?.tagName ?? null);

  // typing a P in the jump box is just a letter
  await page.getByRole('button', { name: 'Jump to time…' }).click();
  const box = page.getByRole('textbox', { name: /Jump to a time/ });
  await box.press('p');
  await expect(box).toHaveValue('p');
  expect(await inPip()).toBeNull();
  await page.getByRole('button', { name: 'Cancel' }).click();
  if (!supported) return;

  await expect(button).toHaveAttribute('aria-keyshortcuts', 'P');
  await page.keyboard.press('p');
  await expect.poll(inPip).toBe('VIDEO');
  await expect(page.getByRole('button', { name: 'Exit picture in picture' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('P');
  await expect.poll(inPip).toBeNull();
});

test.describe(() => {
  test.use({ profileOptions: { setupDone: true, prefs: { settingsMode: 'all' } } });

  test('Settings › Diagnostics shows the server, FFmpeg and connections', async ({ profile }) => {
    const page = await profile.device();
    await page.goto('/settings');
    const section = page.getByRole('region', { name: 'Diagnostics' });
    await expect(section).toBeVisible();
    const diag = section.getByTestId('diagnostics');
    await expect(diag).toContainText(/up \d/);
    await expect(diag.locator('.set-row', { hasText: 'FFmpeg' }).first()).toContainText(/\d+\.\d/);
    await expect(diag).toContainText(/\d+ of (\d+|unlimited) in use/);
    await expect(diag).not.toContainText('http');
    await expect(diag.getByTestId('video-encoder')).toHaveText(/\((libx264|h264_(vaapi|qsv|nvenc))\)$/);
  });

  test('Settings › Player: an admin can override hardware encoding, and the server checks again', async ({ profile }) => {
    const page = await profile.device();
    await page.goto('/settings');
    const hw = page.getByRole('region', { name: 'Player' }).getByTestId('hw-encoding');
    const select = hw.getByLabel('Hardware encoding');
    await expect(select).toHaveValue('');
    await expect(select.locator('option').first()).toHaveText('Server default (Automatic)');
    await select.selectOption('off');
    await expect(hw.getByTestId('hw-encoder-active')).toHaveText('Software (libx264)');
    await expect(hw).toContainText('Hardware encoding is turned off.');
    // the server keeps it
    await page.reload();
    await expect(page.getByRole('region', { name: 'Player' }).getByLabel('Hardware encoding')).toHaveValue('off');
    // back to the environment's setting (the server is shared by every spec)
    await page.getByRole('region', { name: 'Player' }).getByLabel('Hardware encoding').selectOption('');
    await expect(page.getByRole('region', { name: 'Player' }).getByLabel('Hardware encoding')).toHaveValue('');
    await expect(page.getByRole('region', { name: 'Player' }).getByTestId('hw-encoding')).toContainText(/Tested: NVENC/);
  });
});
