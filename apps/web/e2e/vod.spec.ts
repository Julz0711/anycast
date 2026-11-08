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
    await expect(page.getByRole('region', { name: 'Episodes' }).getByRole('button', { name: /^Up next: / })).toBeVisible();

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

test.describe(() => {
  test.use({ profileOptions: { setupDone: true, prefs: { player: { autoplayNext: false, upNextSeconds: 0 } } } });

  test('credits: going on to the next episode early teaches the series where its end credits start', async ({ profile }) => {
    await profile.api.delete(`/api/series/${fx.series.id}/credits`);
    const page = await profile.device();
    await page.goto(`/play/episode/${fx.series.ep1}?series=${fx.series.id}`);
    await expectPlaying(page);
    await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.duration), { timeout: 20_000 }).toBeGreaterThan(90);
    // no card before the end yet (setting: only at the end)
    await video(page).evaluate((v: HTMLVideoElement) => {
      v.currentTime = v.duration - 25;
    });
    await expectPlaying(page);
    await expect(page.getByRole('dialog', { name: 'Next episode' })).toHaveCount(0);
    // the viewer moves on 25 s before the end: the credits of this series start about there
    await page.getByRole('region', { name: 'Episodes' }).getByRole('button', { name: /^Up next: / }).click();
    await expect(page).toHaveURL(new RegExp(`/play/episode/${fx.series.ep2}`));
    await expect
      .poll(async () => ((await (await profile.api.get(`/api/series/${fx.series.id}`)).json()) as { creditsLead: number | null }).creditsLead, { timeout: 10_000 })
      .toBeGreaterThan(15);

    // the next episode shows the card once its credits start, without waiting for the end
    await expectPlaying(page);
    await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.duration), { timeout: 20_000 }).toBeGreaterThan(90);
    await video(page).evaluate((v: HTMLVideoElement) => {
      v.currentTime = v.duration - 20;
    });
    const card = page.getByRole('dialog', { name: 'Next episode' });
    await expect(card).toBeVisible();
    await expect(card.getByText("Timed to this series' end credits.")).toBeVisible();
    await card.getByRole('button', { name: 'Watch credits' }).click();
    await expect(card).toHaveCount(0);
  });
});

test('theater mode makes the video taller and is remembered', async ({ profile }) => {
  const page = await profile.device();
  await page.goto(`/play/movie/${fx.movie.id}`);
  await expectPlaying(page);
  const stage = page.locator('.pl-stage');
  const before = (await stage.boundingBox())!.height;
  await page.getByRole('button', { name: 'Theater mode' }).click();
  await expect(page.getByRole('button', { name: 'Theater mode' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await stage.boundingBox())!.height).toBeGreaterThan(before + 100);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Theater mode' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('w');
  await expect(page.getByRole('button', { name: 'Theater mode' })).toHaveAttribute('aria-pressed', 'false');
});
