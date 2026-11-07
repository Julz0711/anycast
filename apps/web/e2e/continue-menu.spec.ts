import { expect, fx, test } from './fixtures';

test('home: the hero is not repeated below; Continue watching cards can be marked as watched or removed', async ({ profile }) => {
  // two movies started: the newer one is the hero, the older one the first card of the row
  for (const [m, at] of [[fx.movie, 60], [fx.hlsMovie, 90]] as const) {
    expect((await profile.api.put('/api/progress', { data: { kind: 'movie', id: m.id, position: at, duration: 600 } })).ok()).toBe(true);
  }
  const page = await profile.device();
  await page.goto('/home');
  const hero = page.getByRole('region', { name: 'Pick up where you left off' });
  await expect(hero).toContainText(fx.hlsMovie.name);
  await expect(hero).toContainText('9 min left');
  const row = page.locator('.home-sec').filter({ has: page.getByRole('heading', { name: 'Continue watching' }) });
  await expect(row.getByRole('link', { name: new RegExp(fx.hlsMovie.name) })).toHaveCount(0);
  await expect(row.getByRole('link').first()).toContainText(fx.movie.name);
  await expect(row.getByRole('link').first()).toContainText('9 min left');

  await row.getByRole('button', { name: `More for ${fx.movie.name}` }).click();
  await page.getByRole('menuitem', { name: 'Mark as watched' }).click();
  await expect(row).toHaveCount(0);
  await expect
    .poll(async () => ((await (await profile.api.get('/api/progress')).json()) as { id: string; finished: boolean }[]).find((p) => p.id === fx.movie.id)?.finished)
    .toBe(true);
});
