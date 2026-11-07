import { expect, fx, test } from './fixtures';

test.use({ profileOptions: { setupDone: true, prefs: { appearance: { animations: 'off' }, settingsMode: 'all' } } });

test('recap: the player records watch time; the story cards show it; history can be turned off and cleared', async ({ profile }) => {
  const { api } = profile;
  const page = await profile.device();

  // a few seconds of a channel, then leaving the page: the watch time is sent on the way out
  await page.goto(`/play/live/${fx.noGuideChannel.id}`);
  await expect(page.locator('video')).toHaveJSProperty('paused', false, { timeout: 20_000 });
  await page.waitForTimeout(6_000);
  await page.goto('/home');
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  const recap = async () => (await (await api.get(`/api/recap?from=${from}&to=${to}`)).json()) as { totalSeconds: number; topChannels: { id: string }[] };
  await expect.poll(async () => (await recap()).totalSeconds, { timeout: 15_000 }).toBeGreaterThan(2);

  // enough for a recap
  for (let i = 0; i < 3; i++) expect((await api.post('/api/watch-time', { data: { kind: 'live', id: fx.noGuideChannel.id, seconds: 600 } })).ok()).toBe(true);
  expect((await api.post('/api/watch-time', { data: { kind: 'movie', id: fx.movie.id, seconds: 600 } })).ok()).toBe(true);
  expect((await recap()).topChannels[0]!.id).toBe(fx.noGuideChannel.id);

  await page.goto('/recap?p=month');
  const card = page.locator('.rc-card');
  await expect(card).toContainText('Your');
  await page.keyboard.press('ArrowRight');
  await expect(card).toContainText('You watched');
  await page.keyboard.press('ArrowRight');
  await expect(card).toContainText('Mostly');
  await page.keyboard.press('ArrowRight');
  await expect(card).toContainText('Your #1 channel');
  await expect(card).toContainText(fx.noGuideChannel.name);
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  await expect(card).toContainText('viewer type', { ignoreCase: true });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page).not.toHaveURL(/\/recap/);

  // turned off: nothing new is recorded
  expect((await api.put('/api/preferences', { data: { history: { record: false } } })).ok()).toBe(true);
  const before = (await recap()).totalSeconds;
  expect(((await (await api.post('/api/watch-time', { data: { kind: 'live', id: fx.noGuideChannel.id, seconds: 60 } })).json()) as { ok: boolean }).ok).toBe(false);
  expect((await recap()).totalSeconds).toBe(before);

  // cleared from Settings › Watch history
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Clear…' }).click();
  await page.getByRole('button', { name: 'Clear it' }).click();
  await expect.poll(async () => (await recap()).totalSeconds).toBe(0);
  await page.goto('/recap?p=month');
  await expect(page.getByText('Your recap is still warming up')).toBeVisible();
});
