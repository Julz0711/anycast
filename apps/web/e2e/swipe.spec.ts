/**
 * Swipe: drag a card right to keep it for later, left (or ←) to pass, Z to undo; the deck comes
 * back as it was after opening a title. E2E_SCREENSHOTS=1 also writes screenshots/swipe-*.png.
 */
import type { MediaList } from '@anycast/shared';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const shots = !!process.env.E2E_SCREENSHOTS;
const topCard = (page: Page) => page.locator('[aria-roledescription="card"]');
const topName = async (page: Page) => (await topCard(page).getAttribute('aria-label'))!.split(', ')[0]!;

test('swipe right saves to Watch Later, left passes, Z undoes, details and back keep the deck', async ({ profile }) => {
  const page = await profile.device();
  await page.goto('/movies');
  await page.getByRole('link', { name: 'Swipe' }).click();
  await expect(page).toHaveURL(/\/swipe\?kind=movie/);
  await expect(page.getByRole('radio', { name: 'Movies' })).toHaveAttribute('aria-checked', 'true');
  await expect(topCard(page)).toBeVisible();
  // posters in view
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.swipe-card img')].every((i) => i.complete));

  // drag the top card to the right
  const first = await topName(page);
  const box = (await topCard(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 5, { steps: 4 });
  await page.mouse.move(x + box.width * 0.4, y + 10, { steps: 6 });
  if (shots) await page.screenshot({ path: 'screenshots/swipe-drag-desktop.png' });
  await page.mouse.up();
  await expect.poll(async () => {
    const lists = (await (await profile.api.get('/api/media-lists')).json()) as MediaList[];
    return lists[0]!.items.map((i) => i.kind);
  }).toEqual(['movie']);
  await expect(topCard(page)).not.toHaveAttribute('aria-label', new RegExp(`^${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`));
  await expect(page.getByText('1 saved · 0 passed')).toBeVisible();

  // ← passes on the next one, Z brings it back
  const second = await topName(page);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => ((await (await profile.api.get('/api/swipe/passed')).json()) as { passed: number }).passed).toBe(1);
  await expect(page.getByText('1 saved · 1 passed')).toBeVisible();
  await page.keyboard.press('z');
  await expect.poll(async () => ((await (await profile.api.get('/api/swipe/passed')).json()) as { passed: number }).passed).toBe(0);
  expect(await topName(page)).toBe(second);

  // details, then back: the same card is still on top
  await page.getByRole('button', { name: `Details of ${second}` }).click();
  await expect(page).toHaveURL(/\/movies\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1, name: second })).toBeVisible();
  await page.goBack();
  await expect(topCard(page)).toBeVisible();
  expect(await topName(page)).toBe(second);
  if (shots) await page.screenshot({ path: 'screenshots/swipe-desktop.png' });

  // Watch Later points to Swipe
  await page.goto('/lists');
  await expect(page.getByRole('link', { name: 'Swipe for more' })).toBeVisible();
});

test('phone: buttons swipe, both kinds mixed', async ({ profile }) => {
  const page = await profile.device();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/swipe');
  await expect(page.getByRole('radio', { name: 'Both' })).toHaveAttribute('aria-checked', 'true');
  await expect(topCard(page)).toBeVisible();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.swipe-card img')].every((i) => i.complete));
  const card = (await topCard(page).boundingBox())!;
  const bar = (await page.getByRole('navigation', { name: 'Main' }).boundingBox())!;
  const save = (await page.getByRole('button', { name: /^Watch .* later$/ }).boundingBox())!;
  expect(card.x).toBeGreaterThanOrEqual(0);
  expect(card.x + card.width).toBeLessThanOrEqual(390);
  expect(save.y + save.height).toBeLessThanOrEqual(bar.y);
  if (shots) await page.screenshot({ path: 'screenshots/swipe-phone.png' });

  const name = await topName(page);
  await page.getByRole('button', { name: `Pass on ${name}` }).click();
  await expect(page.getByText('0 saved · 1 passed')).toBeVisible();
  await page.getByRole('button', { name: /^Watch .* later$/ }).click();
  await expect(page.getByText('1 saved · 1 passed')).toBeVisible();
});
