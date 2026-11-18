import { expect, test } from './fixtures';

test.use({ profileOptions: { setupDone: true, prefs: { settingsMode: 'all' } } });

test('a TV signs in with a code that the phone approves; it then shows in Signed-in devices and can be signed out', async ({ browser, baseURL, profile }) => {
  // the TV: not signed in
  const tvCtx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, serviceWorkers: 'block', viewport: { width: 1280, height: 720 } });
  const tv = await tvCtx.newPage();
  await tv.goto('/');
  await tv.getByTestId('login-device').click();
  const codeEl = tv.getByTestId('device-code');
  await expect(codeEl).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const code = (await codeEl.textContent())!;
  await expect(tv.getByRole('img', { name: /QR code/ })).toBeVisible();

  // the phone: the profile page's quick link opens the code entry
  const phone = await profile.device({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto('/me');
  await phone.getByRole('button', { name: 'Sign in a TV' }).click();
  await expect(phone.getByLabel('Code shown on the TV')).toBeVisible();

  // or Settings › Security › Sign in a TV, typed in lower case without the dash
  await phone.goto('/settings#set-security');
  const section = phone.locator('#set-security');
  await expect(section.getByText(/connected from your home network/)).toBeVisible();
  await section.getByLabel('Code shown on the TV').fill(code.replace('-', '').toLowerCase());
  await section.getByRole('button', { name: 'Continue' }).click();
  const approve = phone.getByTestId('approve');
  await expect(approve.getByText(code)).toBeVisible();
  await expect(approve.getByText(/Your home network/)).toBeVisible();
  await approve.getByTestId('approve-yes').click();
  await expect(approve.getByText(/The TV signs in/)).toBeVisible();

  // the TV is in (profile picker or the app)
  await expect(tv.getByTestId('login-device-code')).toBeHidden({ timeout: 10_000 });
  expect((await tv.request.get('/api/me')).ok()).toBe(true);

  // back on the phone: the TV is listed, signed in by approval; sign it out
  await phone.goto('/settings#set-security');
  const row = phone.locator('.sec-device', { hasText: 'approved from another device' }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Sign out' }).click();
  await expect(phone.getByText(/^Signed out /)).toBeVisible();
  expect((await tv.request.get('/api/me')).status()).toBe(401);
  await tvCtx.close();
});
