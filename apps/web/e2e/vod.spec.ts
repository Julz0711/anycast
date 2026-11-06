import { currentTime, expect, expectPlaying, fx, test, video, waitForEvents } from './fixtures';

const fmtDuration = (s: number) => {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

test('couch to bed: pause a movie, another device offers Resume at the same position within 5 s', async ({ profile }) => {
  const couch = await profile.device();
  const bed = await profile.device();

  const connected = waitForEvents(bed);
  await bed.goto(`/movies/${fx.movie.id}`);
  await expect(bed.getByRole('heading', { name: fx.movie.name })).toBeVisible();
  await expect(bed.getByRole('link', { name: 'Play', exact: true })).toBeVisible();
  await connected;

  await couch.goto(`/play/movie/${fx.movie.id}`);
  await expectPlaying(couch);
  await couch.getByRole('button', { name: 'Jump to time…' }).click();
  await couch.getByRole('textbox', { name: /Jump to a time/ }).fill('1:30');
  await couch.getByRole('button', { name: 'Go', exact: true }).click();
  await expect.poll(() => currentTime(couch)).toBeGreaterThanOrEqual(90);
  await expectPlaying(couch);
  await couch.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(couch.locator('.pl-controls').getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  const pos = await currentTime(couch);

  await expect(bed.getByRole('link', { name: `Resume from ${fmtDuration(pos)}` })).toBeVisible({ timeout: 5_000 });
});

test.describe(() => {
  test.use({ profileOptions: { setupDone: true, prefs: { player: { autoplayNext: true, autoplayCountdown: 3 } } } });

  test('binge: the end of an episode counts down to the next one, which starts', async ({ profile }) => {
    const page = await profile.device();
    // no ?series= in the link: the player learns the series from PlaybackInfo.seriesId
    await page.goto(`/play/episode/${fx.series.ep1}`);
    await expectPlaying(page);
    await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.duration), { timeout: 20_000 }).toBeGreaterThan(60);
    await expect(page.getByText('Next', { exact: true })).toBeVisible();

    await video(page).evaluate((v: HTMLVideoElement) => {
      v.currentTime = v.duration - 3;
    });
    const next = page.getByRole('dialog', { name: 'Next episode' });
    await expect(next).toBeVisible({ timeout: 30_000 });
    await expect(next.getByRole('button', { name: /^Play now · \d+$/ })).toBeVisible();

    await expect(page).toHaveURL(new RegExp(`/play/episode/${fx.series.ep2}`), { timeout: 15_000 });
    await expect(page.locator('.pl-title')).toHaveText(fx.series.ep2Title);
    await expectPlaying(page);
    expect(await currentTime(page)).toBeLessThan(30);
  });
});
