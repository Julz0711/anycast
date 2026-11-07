import { expect, fx, test } from './fixtures';

test('favorites: star a channel and a movie, find them under Favorites, unstar them there', async ({ profile }) => {
  const page = await profile.device();

  await page.goto(`/play/live/${fx.archiveChannel.id}`);
  const favChannel = page.getByRole('button', { name: 'Favorite', exact: true });
  await favChannel.click();
  await expect(favChannel).toHaveAttribute('aria-pressed', 'true');

  await page.goto(`/movies/${fx.movie.id}`);
  await page.getByRole('button', { name: 'Add favorite' }).click();
  await expect(page.getByRole('button', { name: 'Favorite', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // the B shortcut opens Library, on Favorites › Live the first time
  await page.keyboard.press('b');
  await expect(page).toHaveURL(/\/favorites\/live$/);
  await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Library' }).getByRole('link', { name: 'Favorites' })).toHaveAttribute('aria-current', 'page');
  const tabs = page.getByRole('radiogroup', { name: 'Favorites type' });
  await expect(tabs.getByRole('radio', { name: 'Live 1' })).toHaveAttribute('aria-checked', 'true');
  await expect(tabs.getByRole('radio', { name: 'Movies 1' })).toBeVisible();
  await expect(tabs.getByRole('radio', { name: 'Series 0' })).toBeVisible();
  const channels = page.getByRole('list', { name: 'Favorite channels' });
  const row = channels.getByRole('button', { name: new RegExp(`^\\d+ ${fx.archiveChannel.name}`) });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/play/live/${fx.archiveChannel.id}$`));
  await page.goBack();

  await tabs.getByRole('radio', { name: /^Movies/ }).click();
  await expect(page).toHaveURL(/\/favorites\/movies$/);
  const movies = page.getByRole('list', { name: 'Favorite movies' });
  await expect(movies.getByRole('link', { name: new RegExp(`^${fx.movie.name}`) })).toBeVisible();

  // the last tab is remembered on this device
  await page.goto('/favorites');
  await expect(page).toHaveURL(/\/favorites\/movies$/);

  await page.getByRole('button', { name: `Remove ${fx.movie.name} from favorites` }).click();
  await expect(page.getByRole('heading', { name: 'No favorite movies yet' })).toBeVisible();
  await expect(tabs.getByRole('radio', { name: 'Movies 0' })).toBeVisible();

  await tabs.getByRole('radio', { name: /^Live/ }).click();
  await page.getByRole('button', { name: `Remove ${fx.archiveChannel.name} from favorites` }).click();
  await expect(page.getByRole('heading', { name: 'No favorite channels yet' })).toBeVisible();

  // and it stuck on the server
  expect(await (await profile.api.get('/api/favorites')).json()).toEqual([]);
});
