import { expect, expectPlaying, fx, test, video } from './fixtures';

const vol = (page: Parameters<typeof video>[0]) => video(page).evaluate((v: HTMLVideoElement) => ({ level: v.volume, muted: v.muted }));

test('volume: slider, arrow keys and mute, remembered after a reload', async ({ profile }) => {
  const page = await profile.device();
  await page.goto(`/play/movie/${fx.movie.id}`);
  await expectPlaying(page);

  const slider = page.getByRole('slider', { name: 'Volume' });
  await slider.fill('40');
  await expect.poll(() => vol(page)).toEqual({ level: 0.4, muted: false });

  // up/down on a movie is volume
  await slider.blur();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await vol(page)).level).toBeCloseTo(0.35, 2);

  await page.getByRole('button', { name: 'Mute' }).click();
  await expect.poll(async () => (await vol(page)).muted).toBe(true);
  await expect(slider).toHaveValue('0');
  await page.screenshot({ path: process.env.VOL_SHOT ?? 'test-results/volume.png' });

  await page.reload();
  await expectPlaying(page);
  await expect.poll(() => vol(page)).toEqual({ level: 0.35, muted: true });
  await page.keyboard.press('m');
  await expect.poll(async () => (await vol(page)).muted).toBe(false);
  await expect(page.getByRole('slider', { name: 'Volume' })).toHaveValue('35');
});
