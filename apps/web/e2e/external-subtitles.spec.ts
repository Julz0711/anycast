/**
 * External subtitles for a title without its own (the MP4 movie has none): loaded from a file on
 * this device, shown over the video, shifted with the timing control, remembered for the movie
 * (with the shift), and turned off. The online search with OpenSubtitles answered in the browser
 * (the server can't reach it in tests): results, download, shown.
 */
import { expect, expectPlaying, fx, test } from './fixtures';

const SRT = '1\n00:00:00,000 --> 01:00:00,000\nHello from a <i>file</i>\n';

test('a subtitle file from the device: shown, shifted, remembered, turned off', async ({ profile }) => {
  test.setTimeout(90_000);
  const page = await profile.device();
  const id = fx.movie.id;
  await page.goto(`/play/movie/${id}`);
  await expectPlaying(page);

  // no subtitles of its own, but the menu is there for external ones
  await page.getByRole('button', { name: 'Audio & subtitles' }).click();
  const menu = page.getByRole('dialog', { name: 'Audio and subtitles' });
  const subs = menu.getByRole('radiogroup', { name: 'Subtitles' });
  await expect(subs.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');

  // online search isn't set up on this server: it says how
  await subs.getByRole('button', { name: /Find subtitles online/ }).click();
  await expect(page.getByText(/Add a free OpenSubtitles API key/)).toBeVisible();
  await page.getByRole('button', { name: 'Back to audio and subtitles' }).click();

  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/subtitles/movie/${id}/choice`) && r.request().method() === 'PUT');
  await page.locator('.pl-menu input[type="file"]').setInputFiles({ name: 'movie.en.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(SRT) });
  const overlay = page.getByTestId('external-subtitles');
  await expect(overlay).toHaveText('Hello from a file');
  await expect(overlay.locator('span[style*="italic"]')).toHaveText('file');
  expect((await saved).status()).toBe(200);
  const file = subs.getByRole('radio', { name: /English.*From a file · movie\.en\.srt/ });
  await expect(file).toHaveAttribute('aria-checked', 'true');
  await expect(subs.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'false');

  // shift it half a second later; the shift is saved a moment after
  const shifted = page.waitForResponse((r) => r.url().endsWith(`/api/subtitles/movie/${id}/choice`) && r.request().method() === 'PUT' && r.request().postDataJSON().offsetMs === 500);
  await menu.getByRole('button', { name: 'Show subtitles later' }).click();
  await expect(menu.getByRole('group', { name: 'Subtitle timing' })).toContainText('+0.5 s');
  await shifted;

  // played again: the same file, with the shift
  await page.reload();
  await expectPlaying(page);
  await expect(overlay).toHaveText('Hello from a file');
  await page.getByRole('button', { name: 'Audio & subtitles' }).click();
  await expect(menu.getByRole('group', { name: 'Subtitle timing' })).toContainText('+0.5 s');

  // off, and it stays off
  const off = page.waitForResponse((r) => r.url().endsWith(`/api/subtitles/movie/${id}/choice`) && r.request().method() === 'PUT');
  await subs.getByRole('radio', { name: 'Off' }).click();
  await expect(overlay).toBeHidden();
  expect((await off).request().postDataJSON()).toEqual({ fileId: null, offsetMs: 0 });
  await page.reload();
  await expectPlaying(page);
  await page.waitForTimeout(1000);
  await expect(overlay).toBeHidden();
});

test('online search: results in the subtitle language, the one picked is downloaded and shown', async ({ profile }) => {
  test.setTimeout(90_000);
  const page = await profile.device();
  const id = fx.movie.id;
  const file = { id: 'os-42', source: 'opensubtitles', language: 'de', label: 'Movie.2019.German.720p', cues: 1, addedAt: Date.now() };
  let downloaded = false;
  await page.route(`**/api/subtitles/movie/${id}`, (route) =>
    route.fulfill({ json: { online: true, files: downloaded ? [file] : [], choice: downloaded ? { fileId: file.id, offsetMs: 0 } : null, savedOff: false } }),
  );
  await page.route(`**/api/subtitles/movie/${id}/search?**`, (route) =>
    route.fulfill({
      json: {
        query: 'Movie (2019)',
        results: [
          { fileId: '42', language: 'de', release: 'Movie.2019.German.720p', downloads: 1520, hearingImpaired: false, machineTranslated: false, trusted: true, kept: false },
          { fileId: '43', language: 'de', release: 'Movie.2019.German.HI', downloads: 80, hearingImpaired: true, machineTranslated: false, trusted: false, kept: false },
        ],
      },
    }),
  );
  await page.route(`**/api/subtitles/movie/${id}/download`, (route) => {
    downloaded = true;
    return route.fulfill({ json: { file, remaining: 17 } });
  });
  await page.route(`**/api/subtitles/movie/${id}/choice`, (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/subtitles/file/os-42', (route) => route.fulfill({ contentType: 'text/vtt', body: 'WEBVTT\n\n00:00:00.000 --> 01:00:00.000\nHallo aus dem Netz\n' }));
  await profile.api.put('/api/preferences', { data: { player: { preferredSubtitleLanguage: 'de' } } });

  await page.goto(`/play/movie/${id}`);
  await expectPlaying(page);
  await page.getByRole('button', { name: 'Audio & subtitles' }).click();
  await page.getByRole('button', { name: /Find subtitles online/ }).click();
  const search = page.getByRole('dialog', { name: 'Find subtitles' });
  await expect(search.getByRole('combobox', { name: 'Language' })).toHaveValue('de');
  await expect(search.getByText('Movie (2019)')).toBeVisible();
  await expect(search.getByRole('button', { name: /Movie\.2019\.German\.720p.*1,520 downloads · trusted/ })).toBeVisible();
  await search.getByRole('button', { name: /Movie\.2019\.German\.720p/ }).click();
  await expect(page.getByTestId('external-subtitles')).toHaveText('Hallo aus dem Netz');
  await expect(page.getByRole('radiogroup', { name: 'Subtitles' }).getByRole('radio', { name: /German.*OpenSubtitles/ })).toHaveAttribute('aria-checked', 'true');
});
