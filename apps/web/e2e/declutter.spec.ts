import type { Page } from '@playwright/test';
import { expect, fx, test } from './fixtures';

/** How the app labels category chips ("DE | Sport" -> "DE · Sport"). */
const chip = (name: string) => name.replace(/\s*\|\s*/, ' · ');

async function search(page: Page, q: string) {
  const done = page.waitForResponse((r) => {
    const u = new URL(r.url());
    return u.pathname === '/api/search' && u.searchParams.get('q') === q.trim();
  });
  await page.getByRole('searchbox', { name: 'Search channels, movies and series' }).fill(q);
  await done;
  await expect(page.locator('[aria-live="polite"][aria-busy]')).toHaveAttribute('aria-busy', 'false');
}

test.use({ profileOptions: { setupDone: false } });

test('declutter: keep only English in setup; other languages vanish from Live, Movies and Search', async ({ profile }) => {
  const d = fx.declutter;
  const page = await profile.device();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Which languages do you watch?' })).toBeVisible();
  const langs = page.getByRole('group', { name: 'Languages to keep' });
  await expect(langs.getByRole('button', { name: /^English/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(langs.getByRole('button', { name: /^German/ })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Keep 1 language' }).click();

  // Live TV
  await expect(page).toHaveURL(/\/live$/);
  const groups = page.getByRole('toolbar', { name: 'Channel groups' });
  await expect(groups.getByRole('button', { name: chip(d.liveCat.en), exact: true })).toBeVisible();
  await expect(groups.getByRole('button', { name: chip(d.liveCat.de), exact: true })).toHaveCount(0);

  // Movies
  await page.getByRole('link', { name: 'Movies' }).first().click();
  const cats = page.getByRole('toolbar', { name: 'Categories' });
  await expect(cats.getByRole('button', { name: chip(d.movieCat.en), exact: true })).toBeVisible();
  await expect(cats.getByRole('button', { name: chip(d.movieCat.de), exact: true })).toHaveCount(0);

  // Search
  await page.goto('/search');
  const live = page.getByRole('region', { name: 'Live channels' });
  const movies = page.getByRole('region', { name: 'Movies' });
  await search(page, d.channel.en);
  await expect(live.getByText(d.channel.en, { exact: true })).toBeVisible();
  await search(page, d.channel.de);
  await expect(live.getByText(d.channel.de, { exact: true })).toHaveCount(0);
  await search(page, d.movie.en);
  await expect(movies.getByText(d.movie.en, { exact: true }).first()).toBeVisible();
  await search(page, d.movie.de);
  await expect(movies.getByText(d.movie.de, { exact: true })).toHaveCount(0);

  // the setup is stored on the server for this profile: another device goes straight to the app
  const other = await profile.device();
  await other.goto('/');
  await expect(other).toHaveURL(/\/live$/);
  await expect(other.getByRole('heading', { name: 'Live TV' })).toBeVisible();
});
