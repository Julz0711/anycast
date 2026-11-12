import { ACCENTS } from '@anycast/shared';
import { expect, fx, test, waitForEvents } from './fixtures';

test.describe('realtime sync between devices', () => {
  test('a favorite added on one device shows on the other in under 2 s', async ({ profile }) => {
    const a = await profile.device();
    const b = await profile.device();
    await a.goto(`/movies/${fx.movie.id}`);
    const connected = waitForEvents(b);
    await b.goto(`/movies/${fx.movie.id}`);
    await connected;
    const favA = a.getByRole('button', { name: 'Add favorite' });
    const favB = b.getByRole('button', { name: /^(Add favorite|Favorite)$/ });
    await expect(favB).toHaveAttribute('aria-pressed', 'false');

    await favA.click();
    await expect(favB).toHaveAttribute('aria-pressed', 'true', { timeout: 2_000 });

    await a.getByRole('button', { name: 'Favorite', exact: true }).click();
    await expect(favB).toHaveAttribute('aria-pressed', 'false', { timeout: 2_000 });
  });

  test('an accent change on one device restyles the other', async ({ profile }) => {
    const a = await profile.device();
    const b = await profile.device();
    await a.goto('/settings');
    const connected = waitForEvents(b);
    await b.goto('/live');
    await connected;
    const accent = () => b.evaluate(() => document.documentElement.style.getPropertyValue('--accent').trim().toUpperCase());
    expect(await accent()).toBe(ACCENTS.amber.hex.toUpperCase());

    await a.getByRole('radiogroup', { name: 'Accent color' }).getByRole('radio', { name: 'Rose' }).click();
    await expect.poll(accent, { timeout: 3_000 }).toBe(ACCENTS.rose.hex.toUpperCase());
  });

  test('the headline font is a choice of the profile: titles and the clock on every device', async ({ profile }) => {
    const a = await profile.device();
    const b = await profile.device();
    await a.goto('/settings');
    const connected = waitForEvents(b);
    await b.goto('/home');
    await connected;
    const display = () => b.evaluate(() => document.documentElement.style.getPropertyValue('--font-display'));
    expect(await display()).toContain('Bricolage Grotesque');
    // the clock is Home's headline, set in that font
    const clock = b.locator('.home-clock');
    await expect(clock).toHaveText(/^\d\d:\d\d$/);
    expect(await clock.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Bricolage Grotesque');

    await a.getByRole('radiogroup', { name: 'Headline font' }).getByRole('radio', { name: 'Serif' }).click();
    await expect.poll(display, { timeout: 3_000 }).toContain('Fraunces');
    expect(await clock.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Fraunces');
    await expect(b.locator('link#headline-font')).toHaveAttribute('href', /family=Fraunces/);
  });
});
