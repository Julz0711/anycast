import { request, type Browser, type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ADMIN } from './env';

const PIN = '2468';
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A new device with its own sign-in (so entering a locked profile here does not open it elsewhere). */
async function freshDevice(browser: Browser, baseURL: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  expect((await ctx.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  return ctx.newPage();
}

async function enterPin(page: Page, pin: string) {
  const pad = page.getByRole('dialog');
  await expect(pad).toBeVisible();
  for (const d of pin) await pad.getByRole('button', { name: d, exact: true }).click();
  await page.keyboard.press('Enter');
}

test("profiles: Who's watching, a new picture and photo, a profile PIN another device must enter", async ({ browser, baseURL, profile }) => {
  const name = ((await (await profile.api.get('/api/profiles')).json()) as { id: string; name: string }[]).find((p) => p.id === profile.id)!.name;
  const a = await freshDevice(browser, baseURL!);
  try {
    // opening AnyCast asks who's watching
    await a.goto('/');
    await expect(a.getByRole('heading', { name: "Who's watching?" })).toBeVisible();

    // Manage profiles › the test profile: pick a built-in picture, then upload a photo
    await a.getByRole('button', { name: 'Manage profiles' }).click();
    await a.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
    await expect(a.getByRole('heading', { name: 'Edit profile' })).toBeVisible();
    await a.getByRole('button', { name: 'Change picture' }).click();
    await a.getByRole('radio', { name: 'Dino picture' }).click();
    await a.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(a.getByText('Profile saved.')).toBeVisible();
    await expect.poll(async () => ((await (await profile.api.get('/api/profiles')).json()) as { id: string; avatar: string }[]).find((p) => p.id === profile.id)!.avatar).toMatch(/^dino\./);

    await a.getByRole('button', { name: 'Change picture' }).click();
    await a.getByRole('radio', { name: 'Your photo' }).click();
    await a.locator('input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await a.getByRole('button', { name: 'Use this photo' }).click();
    await a.getByRole('button', { name: 'Save', exact: true }).click();
    // the toast of the first save can still be up (4 s): look at the newest one
    await expect(a.getByText('Profile saved.').last()).toBeVisible();
    await expect.poll(async () => ((await (await profile.api.get('/api/profiles')).json()) as { id: string; image: string | null }[]).find((p) => p.id === profile.id)!.image).toMatch(/\/image\?v=/);

    // lock it with a PIN
    await a.getByRole('button', { name: 'Set a PIN' }).click();
    await enterPin(a, PIN);
    await enterPin(a, PIN);
    await expect(a.getByText('Locked with a PIN')).toBeVisible();

    // another device: the tile shows the lock; a wrong PIN counts down, the right one opens it
    const b = await freshDevice(browser, baseURL!);
    await b.goto('/');
    const tile = b.getByRole('button', { name: `${name}, locked with a PIN`, exact: true });
    await expect(tile).toBeVisible();
    await expect(tile.locator('img')).toBeVisible();
    await tile.click();
    await enterPin(b, '1111');
    await expect(b.getByRole('dialog').getByText('Wrong PIN. 4 attempts left.')).toBeVisible();
    await enterPin(b, PIN);
    const button = b.getByRole('button', { name: `Profile: ${name}. Switch or edit profiles` });
    await expect(button).toBeVisible();

    // the profile menu goes back to Who's watching; the locked profile asks again
    await button.click();
    await b.getByRole('menuitem', { name: "Who's watching?" }).click();
    await expect(b.getByRole('heading', { name: "Who's watching?" })).toBeVisible();
    await tile.click();
    await expect(b.getByRole('dialog')).toBeVisible();
    await b.context().close();
  } finally {
    // unlock, so the fixture can delete the profile
    const api = await request.newContext({ baseURL });
    await api.post('/api/auth/login', { data: ADMIN });
    await api.put(`/api/profiles/${profile.id}/lock`, { data: { pin: null, password: ADMIN.password } });
    await api.dispose();
    await a.context().close();
  }
});
