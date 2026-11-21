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
  await menu.getByRole('button', { name: 'Show subtitles half a second later' }).click();
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
  expect((await off).request().postDataJSON()).toEqual({ fileId: null, offsetMs: 0, rate: null });
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
    route.fulfill({ json: { online: true, files: downloaded ? [file] : [], choice: downloaded ? { fileId: file.id, offsetMs: 0 } : null, savedOff: false, seriesLanguage: null } }),
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

test('a series remembers the language: the next episode gets subtitles on its own', async ({ profile }) => {
  test.setTimeout(90_000);
  const page = await profile.device();
  const ep = fx.series.ep2;
  const file = { id: 'os-77', source: 'opensubtitles', language: 'de', label: 'Show.S01E02.German', cues: 1, addedAt: Date.now() };
  const auto: string[] = [];
  await page.route(`**/api/subtitles/episode/${ep}`, (route) => route.fulfill({ json: { online: true, files: [], choice: null, savedOff: false, seriesLanguage: 'de' } }));
  await page.route(`**/api/subtitles/episode/${ep}/auto`, (route) => {
    auto.push(route.request().postDataJSON().language);
    return route.fulfill({ json: { file } });
  });
  await page.route('**/api/subtitles/file/os-77', (route) => route.fulfill({ contentType: 'text/vtt', body: 'WEBVTT\n\n00:00:00.000 --> 01:00:00.000\nNächste Folge\n' }));
  // the profile's Subtitles preference is off: the series' language still wins
  await page.goto(`/play/episode/${ep}?series=${fx.series.id}`);
  await expectPlaying(page);
  await expect(page.getByTestId('external-subtitles')).toHaveText('Nächste Folge');
  expect(auto).toEqual(['de']);
});

test('on a TV: the remote reaches the close button, Back closes the menu, and drift can be fixed', async ({ profile }) => {
  test.setTimeout(90_000);
  const page = await profile.device();
  await page.addInitScript(() => localStorage.setItem('anycast.device', 'tv'));
  const id = fx.movie.id;
  const file = { id: 'os-50', source: 'opensubtitles', language: 'de', label: 'Movie.2019.German.BluRay', cues: 1, fps: null, addedAt: Date.now() };
  const saved: { fileId: string | null; offsetMs: number; rate: number | null }[] = [];
  await page.route(`**/api/subtitles/movie/${id}`, (route) =>
    route.fulfill({ json: { online: true, files: [file], choice: { fileId: file.id, offsetMs: 0, rate: null }, savedOff: false, seriesLanguage: null } }),
  );
  await page.route(`**/api/subtitles/movie/${id}/choice`, (route) => {
    saved.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/subtitles/file/os-50', (route) => route.fulfill({ contentType: 'text/vtt', body: 'WEBVTT\n\n00:00:00.000 --> 01:00:00.000\nVom Fernseher\n' }));

  await page.goto(`/play/movie/${id}`);
  await expectPlaying(page);
  await expect(page.getByTestId('external-subtitles')).toHaveText('Vom Fernseher');
  const menu = page.getByRole('dialog', { name: 'Audio and subtitles' });
  const open = async () => {
    await page.getByRole('button', { name: 'Audio & subtitles' }).focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
  };

  // Back on the remote (Vega's WebView may name it anything but Escape) closes it, and the player stays
  await open();
  const key = (init: { key: string; keyCode?: number }) =>
    page.evaluate(({ key, keyCode }) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true })), init);
  await key({ key: 'GoBack' });
  await expect(menu).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/play/movie/${id}`));
  await open();
  await key({ key: 'Unidentified', keyCode: 27 });
  await expect(menu).toBeHidden();

  // up from the top of a column reaches the close button; OK on it closes
  await open();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();

  // timing in steps of 5 s, and the drift fix for a subtitle made for another frame rate
  await open();
  const timing = menu.getByRole('group', { name: 'Subtitle timing' });
  await timing.getByRole('button', { name: 'Show subtitles 5 seconds later' }).click();
  await expect(timing).toContainText('+5 s');
  const drift = menu.getByRole('radiogroup', { name: 'Subtitle drift' });
  await expect(drift.getByRole('radio', { name: 'None' })).toHaveAttribute('aria-checked', 'true');
  await drift.getByRole('radio', { name: 'Later and later' }).click();
  await expect(drift.getByRole('radio', { name: 'Later and later' })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => saved.at(-1)).toMatchObject({ fileId: 'os-50', offsetMs: 5000 });
  expect(saved.at(-1)!.rate).toBeCloseTo(0.959, 3);
});
