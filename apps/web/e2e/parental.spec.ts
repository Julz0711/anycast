import { expect, test } from './fixtures';
import { ADMIN } from './env';

const PIN = '4826';

test.use({ profileOptions: { setupDone: true, prefs: { settingsMode: 'all', live: { layoutLarge: 'simple' } } } });

test('parental lock: set a PIN, the adult group is locked, the PIN opens it, lock again', async ({ profile }) => {
  const page = await profile.device();
  const pad = page.getByRole('dialog');
  const enterPin = async (pin: string) => {
    await expect(pad).toBeVisible();
    for (const d of pin) await pad.getByRole('button', { name: d, exact: true }).click();
    await page.keyboard.press('Enter');
  };

  // new profiles hide adult content: no adult group at all
  await page.goto('/live');
  const groups = page.getByRole('toolbar', { name: 'Channel groups' });
  await expect(groups.getByRole('button', { name: 'All', exact: true })).toBeVisible();
  await expect(groups.getByRole('button', { name: /^XXX/ })).toHaveCount(0);

  // Settings › Parental lock: the first PIN needs the account password, then the PIN twice
  await page.goto('/settings');
  const section = page.locator('#set-parental');
  await section.getByRole('button', { name: 'Set PIN', exact: true }).click();
  await section.getByLabel(/account password/).fill(ADMIN.password);
  await section.getByRole('button', { name: 'Continue' }).click();
  await expect(pad.getByRole('heading', { name: 'New PIN' })).toBeVisible();
  await enterPin(PIN);
  await expect(pad.getByRole('heading', { name: 'Repeat the new PIN' })).toBeVisible();
  await enterPin(PIN);
  await expect(pad).toBeHidden();
  await expect(section.getByRole('button', { name: 'Change PIN' })).toBeVisible();

  // loosening the lock asks for the PIN; a wrong one shakes and counts down
  await section.getByRole('radio', { name: 'Locked with PIN' }).click();
  await page.keyboard.type('0000');
  await page.keyboard.press('Enter');
  await expect(pad.getByText('Wrong PIN. 4 attempts left.')).toBeVisible();
  await expect(pad.getByTestId('pin-dots')).toHaveClass(/shake/);
  await enterPin(PIN);
  await expect(pad).toBeHidden();
  await expect(section.getByRole('radio', { name: 'Locked with PIN' })).toHaveAttribute('aria-checked', 'true');

  // Live TV: the adult group is listed with a lock; opening it asks for the PIN, then opens it
  await page.goto('/live');
  const adult = groups.getByRole('button', { name: /^XXX.*, locked$/ });
  await expect(adult).toBeVisible();
  await adult.click();
  await expect(pad.getByRole('heading', { name: 'Enter PIN' })).toBeVisible();
  await page.keyboard.type(PIN);
  await page.keyboard.press('Enter');
  await expect(pad).toBeHidden();
  const opened = groups.getByRole('button', { name: /^XXX/ });
  await expect(opened).toHaveAttribute('aria-pressed', 'true');
  await expect(opened).not.toHaveAccessibleName(/locked/);
  const rows = page.getByRole('list', { name: 'Channels' }).getByRole('button');
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasText: /^Locked/ })).toHaveCount(0);
  await expect(rows.first()).not.toHaveAccessibleName(/Locked/);

  // lock again from the rail: placeholders and the lock come back
  await page.getByRole('button', { name: 'Lock adult content now' }).click();
  await expect(groups.getByRole('button', { name: /^XXX.*, locked$/ })).toBeVisible();
  await expect(rows.first()).toHaveAccessibleName(/^\d+ Locked/);
  expect((await (await profile.api.get('/api/adult')).json()).mode).toBe('locked');
});
