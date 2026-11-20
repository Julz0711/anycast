import { expect, test } from './fixtures';

test.use({ profileOptions: { setupDone: true, prefs: { settingsMode: 'basic' } } });

test('settings search finds options from All settings too, in German as well, and clearing it shows the option in its place', async ({ profile }) => {
  const page = await profile.device();
  await page.goto('/settings');
  // grouped sections with their own headings
  await expect(page.getByRole('heading', { name: 'Watching', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Player', level: 3 })).toBeVisible();
  // Skip back is only in All settings
  await expect(page.getByText('Skip back', { exact: true })).toHaveCount(0);

  const box = page.getByRole('searchbox', { name: 'Search settings' });
  await box.fill('skip back');
  await expect(page.getByText('Skip back', { exact: true })).toBeVisible();
  await expect(page.getByText('Accent color', { exact: true })).toBeHidden();
  await expect(page.locator('#set-appearance')).toBeHidden();

  await box.fill('untertitel');
  await expect(page.getByText('Subtitles', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Live buffer', { exact: true })).toBeHidden();

  await box.fill('xyzzy');
  await expect(page.getByText(/Nothing matches/)).toBeVisible();

  // pick a result, clear: the option stays on screen, now among its neighbours
  await box.fill('live buffer');
  await page.getByRole('radio', { name: '8 s' }).click();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(box).toHaveValue('');
  await expect(page.getByText('Live buffer', { exact: true })).toBeInViewport();
  await expect(page.getByText('Accent color', { exact: true })).toBeAttached();
});
