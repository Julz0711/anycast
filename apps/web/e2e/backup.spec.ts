import { readFileSync } from 'node:fs';
import type { BackupFile } from '@anycast/shared';
import { ADMIN } from './env';
import { expect, fx, test } from './fixtures';

test.use({ profileOptions: { setupDone: true, prefs: { settingsMode: 'all' } } });

// Other specs run on the same server at the same time, so this restores with "Merge", which only
// adds what is missing and leaves everyone else's data alone.
test('backup: favorite a movie, download a backup, remove the favorite, restore, the favorite is back', async ({ profile }) => {
  const page = await profile.device();
  const favorite = page.getByRole('button', { name: 'Favorite', exact: true });

  await page.goto(`/movies/${fx.movie.id}`);
  await page.getByRole('button', { name: 'Add favorite' }).click();
  await expect(favorite).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'Backup & restore' });
  await expect(section).toBeVisible();
  await expect(section.getByRole('list', { name: 'Automatic backups' }).or(section.getByText(/None yet|None\./))).toBeVisible();
  const downloading = page.waitForEvent('download');
  await section.getByRole('button', { name: 'Download backup', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^anycast-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const file = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const backup = JSON.parse(readFileSync(file, 'utf8')) as BackupFile;
  const mine = backup.users.flatMap((u) => u.profiles).find((p) => p.id === profile.id);
  expect(mine?.favorites.map((f) => f.id)).toEqual([fx.movie.id]);
  expect(JSON.stringify(backup)).not.toContain('e2e-pass');

  await page.goto(`/movies/${fx.movie.id}`);
  await favorite.click();
  await expect(page.getByRole('button', { name: 'Add favorite' })).toBeVisible();
  await expect.poll(async () => (await profile.api.get('/api/favorites')).json()).toEqual([]);

  await page.goto('/settings');
  const choosing = page.waitForEvent('filechooser');
  await section.getByRole('button', { name: 'Restore from file…' }).click();
  await (await choosing).setFiles(file);

  const dialog = page.getByRole('dialog', { name: 'Restore backup' });
  await expect(dialog).toBeVisible();
  const summary = dialog.getByRole('definition');
  await expect(dialog.getByText(download.suggestedFilename())).toBeVisible();
  await expect(summary.first()).toBeVisible();
  await expect(dialog.getByText(/Made .* · AnyCast /)).toBeVisible();
  await expect(dialog.getByText('Favorites', { exact: true })).toBeVisible();
  // the signed-in admin is in the backup: no warning
  await expect(dialog.getByTestId('restore-account-warning')).toHaveCount(0);

  await dialog.getByRole('radio', { name: 'Merge' }).click();
  await dialog.getByLabel('Your password').fill('wrong-password');
  await dialog.getByRole('button', { name: 'Merge' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Wrong password');

  await dialog.getByLabel('Your password').fill(ADMIN.password);
  await dialog.getByRole('button', { name: 'Merge' }).press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Backup restored.')).toBeVisible();

  expect(((await (await profile.api.get('/api/favorites')).json()) as { id: string }[]).map((f) => f.id)).toEqual([fx.movie.id]);
  await page.goto(`/movies/${fx.movie.id}`);
  await expect(favorite).toHaveAttribute('aria-pressed', 'true');
});
