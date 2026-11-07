import { expect, test } from './fixtures';

test('movies: browse all movies top rated from 2020 on, then open the details', async ({ profile }) => {
  const page = await profile.device();
  await page.goto('/movies');
  await expect(page.getByRole('region', { name: 'Recently added' })).toBeVisible();
  await page.getByRole('toolbar', { name: 'Categories' }).getByRole('button', { name: 'All movies' }).click();
  await page.getByLabel('Sort by').selectOption('rating');
  await page.getByLabel('Year').selectOption('2020');
  await page.getByLabel('Rating').selectOption('7');

  const grid = page.getByRole('list', { name: /\d+ movies/ });
  await expect(grid).toBeVisible();
  const metas = grid.locator('.poster-meta');
  await expect(metas.first()).toBeVisible();
  const texts = await metas.allTextContents();
  const ratings = texts.map((t) => Number(/(\d+\.\d)/.exec(t)?.[1]));
  const years = texts.map((t) => Number(/(\d{4})/.exec(t)?.[1]));
  expect(ratings.every((r) => r >= 7)).toBe(true);
  expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
  expect(years.every((y) => y >= 2020)).toBe(true);

  // the choice is remembered on this device
  await page.reload();
  await expect(page.getByLabel('Sort by')).toHaveValue('rating');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByLabel('Rating')).toHaveValue('0');

  await grid.getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('.detail-facts')).toContainText('Director');
  await expect(page.getByLabel(/Rated \d+\.\d out of 10/)).toBeVisible();
});
