/**
 * Remote control: a phone steers AnyCast playing on a computer (or a TV's browser) of the same
 * account. The computer announces itself; the phone's /remote lists it and sends commands that
 * arrive over the computer's realtime stream.
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { expect, expectPlaying, fx, test } from './fixtures';

const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const video = (page: Page) => page.locator('video');

test.use({ profileOptions: { setupDone: true, favorites: [{ kind: 'live', id: fx.archiveChannel?.id ?? '' }] } });

test('a phone pauses, seeks, turns down and changes what the computer plays', async ({ profile }) => {
  // every e2e test signs in to the same account: give this "TV" a name of its own
  const name = `E2E TV ${Math.random().toString(36).slice(2, 7)}`;
  const tv = await profile.device();
  await tv.addInitScript((n) => localStorage.setItem('anycast.remote.name', n), name);
  await tv.goto(`/play/movie/${fx.movie.id}`);
  await expectPlaying(tv);

  const phone = await profile.device(PHONE);
  await phone.goto('/remote');
  const target = phone.getByRole('radio', { name: new RegExp(name) });
  await expect(target).toBeVisible();
  await target.click();
  await expect(target).toHaveAttribute('aria-checked', 'true');
  const now = phone.getByRole('region', { name: `On ${name}`, exact: true });
  await expect(now).toContainText(fx.movie.name);
  if (process.env.E2E_SCREENSHOTS) await phone.screenshot({ path: 'screenshots/remote-phone.png' });

  // pause and play
  await now.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => video(tv).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect(now.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await now.getByRole('button', { name: 'Play', exact: true }).click();
  await expectPlaying(tv);

  // forward 10 s
  const t0 = await video(tv).evaluate((v: HTMLVideoElement) => v.currentTime);
  await now.getByRole('button', { name: 'Forward 10 seconds' }).click();
  await expect.poll(() => video(tv).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(t0 + 8);

  // volume down a step, then mute
  const v0 = await video(tv).evaluate((v: HTMLVideoElement) => v.volume);
  await now.getByRole('button', { name: 'Volume down' }).click();
  await expect.poll(() => video(tv).evaluate((v: HTMLVideoElement) => Math.round(v.volume * 100))).toBe(Math.round(Math.max(0, v0 - 0.1) * 100));
  await now.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect.poll(() => video(tv).evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await now.getByRole('button', { name: 'Muted', exact: true }).click();
  await expect.poll(() => video(tv).evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);

  // start a favorite channel on it, then zap
  await phone.getByRole('tab', { name: 'Channels' }).click();
  await phone.getByRole('button', { name: new RegExp(fx.archiveChannel.name) }).first().click();
  await expect(tv).toHaveURL(new RegExp(`/play/live/${fx.archiveChannel.id}$`));
  await expectPlaying(tv);
  await expect(now).toContainText(fx.archiveChannel.name);
  await now.getByRole('button', { name: 'Next channel' }).click();
  await expect(tv).not.toHaveURL(new RegExp(`/play/live/${fx.archiveChannel.id}$`));
  await expect(tv).toHaveURL(/\/play\/live\//);

  // stop: the computer leaves the player
  await now.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(tv).not.toHaveURL(/\/play\//);
  await expect(now).toContainText('Nothing playing');
});

test('the remote is one tap from Home and leaves out devices that turned it off', async ({ profile }) => {
  const name = `E2E hidden ${Math.random().toString(36).slice(2, 7)}`;
  const pc = await profile.device();
  await pc.addInitScript((n) => {
    localStorage.setItem('anycast.remote.name', n);
    localStorage.setItem('anycast.remote.allow', '0');
  }, name);
  await pc.goto('/home');
  const shown = `E2E shown ${Math.random().toString(36).slice(2, 7)}`;
  const other = await profile.device();
  await other.addInitScript((n) => localStorage.setItem('anycast.remote.name', n), shown);
  await other.goto('/home');

  const phone = await profile.device(PHONE);
  await phone.goto('/home');
  // the phone's Home has the way in
  await phone.getByRole('link', { name: 'Remote' }).click();
  await expect(phone).toHaveURL(/\/remote$/);
  await expect(phone.getByRole('radio', { name: new RegExp(shown) })).toBeVisible();
  await expect(phone.getByRole('radio', { name: new RegExp(name) })).toHaveCount(0);
  // the remote page offers its own manifest, so it installs as its own icon
  await expect(phone.locator('link[rel="manifest"]')).toHaveAttribute('href', '/remote.webmanifest');
});
