import { expect, test } from './fixtures';

test('categories: pin a group to the front, move it, hide one and show it again', async ({ profile }) => {
  const page = await profile.device();
  await page.goto('/movies');
  const chips = page.getByRole('toolbar', { name: 'Categories' });
  const first = chips.getByRole('button').nth(2);
  const firstName = (await first.textContent())!.trim();
  const all = chips.getByRole('button');
  const lastCat = all.nth((await all.count()) - 2);
  const lastName = (await lastCat.textContent())!.trim();
  expect(lastName).not.toBe(firstName);

  // names are tidy: no provider separators left
  for (const t of await chips.getByRole('button').allTextContents()) expect(t).not.toMatch(/\|/);

  await chips.getByRole('button', { name: /^(Edit|All \d+) categories…$/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Categories' });
  await sheet.getByRole('button', { name: `Pin ${lastName} to the front` }).click();
  await expect(sheet.getByRole('list', { name: 'Pinned categories' })).toContainText(lastName);
  await page.keyboard.press('Escape');
  await expect(chips.getByRole('button').nth(2)).toHaveText(lastName);

  // pin a second one and move it up, then hide the first category
  await chips.getByRole('button', { name: /^(Edit|All \d+) categories…$/ }).click();
  await sheet.getByRole('button', { name: `Pin ${firstName} to the front` }).click();
  await sheet.getByRole('button', { name: `Move ${firstName} up` }).click();
  await page.keyboard.press('Escape');
  await expect(chips.getByRole('button').nth(2)).toHaveText(firstName);
  await expect(chips.getByRole('button').nth(3)).toHaveText(lastName);

  await chips.getByRole('button', { name: /^(Edit|All \d+) categories…$/ }).click();
  await sheet.getByRole('button', { name: `Hide ${firstName}`, exact: true }).click();
  await expect(chips.getByRole('button', { name: firstName, exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: /^Hidden categories · 1/ }).click();
  await sheet.getByRole('button', { name: 'Show' }).click();
  await page.keyboard.press('Escape');
  await expect(chips.getByRole('button', { name: firstName, exact: true })).toBeVisible();

  // pins sync with the profile: another device has the same order
  const other = await profile.device();
  await other.goto('/movies');
  await expect(other.getByRole('toolbar', { name: 'Categories' }).getByRole('button').nth(2)).toHaveText(lastName);
});
