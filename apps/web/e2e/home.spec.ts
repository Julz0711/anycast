import { expect, fx, test } from './fixtures';

test.use({ profileOptions: { setupDone: true, favorites: [{ kind: 'live', id: fx.archiveChannel.id }] } });

test('home: continue watching, jump back in, up next, favorites and watch later; customize sections; watching a channel adds it', async ({ profile }) => {
  const { api } = profile;
  // a movie half watched, the first episode of a series finished (so the second is up next), a channel watched, a movie saved for later
  expect((await api.put('/api/progress', { data: { kind: 'movie', id: fx.movie.id, position: 60, duration: 180 } })).ok()).toBe(true);
  expect((await api.put('/api/progress', { data: { kind: 'episode', id: fx.series.ep1, seriesId: fx.series.id, position: 1000, duration: 1000 } })).ok()).toBe(true);
  expect((await api.put('/api/recent-channels', { data: { channelId: fx.noGuideChannel.id } })).ok()).toBe(true);
  const lists = (await (await api.get('/api/media-lists')).json()) as { id: string; builtin: string | null }[];
  const wl = lists.find((l) => l.builtin === 'watch-later')!;
  expect((await api.put(`/api/media-lists/${wl.id}/items`, { data: { items: [{ kind: 'movie', id: fx.hlsMovie.id }] } })).ok()).toBe(true);

  const page = await profile.device();
  await page.goto('/');
  await expect(page).toHaveURL(/\/home$/);

  const section = (name: string) => page.getByRole('region', { name, exact: true });
  await expect(section('Continue watching').getByRole('link', { name: new RegExp(fx.movie.name) })).toBeVisible();
  await expect(section('Jump back in').getByRole('button', { name: new RegExp(`^${fx.noGuideChannel.name}`) })).toBeVisible();
  await expect(section('Up next').getByRole('link', { name: new RegExp(`^${fx.series.name}, Next · S\\d+ · E\\d+`) })).toBeVisible();
  // favorite channels are the "On now" timeline (Customize still lists them as Favorite channels)
  await expect(section('On now').getByRole('button', { name: new RegExp(`^\\d+ ${fx.archiveChannel.name}`) })).toBeVisible();
  await expect(section('Watch Later').getByRole('link', { name: new RegExp(`^${fx.hlsMovie.name}`) })).toBeVisible();
  // the pick up card shows the newest thing: the channel, watched after the progress was saved
  await expect(section('Pick up where you left off').getByRole('heading', { name: fx.noGuideChannel.name })).toBeVisible();

  // customize: hide Favorite channels and move Watch Later to the top; it syncs to the profile
  await page.getByRole('button', { name: 'Customize' }).click();
  await page.getByRole('switch', { name: 'Show Favorite channels' }).click();
  await expect(section('On now')).toHaveCount(0);
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Move Watch Later up' }).click();
  await expect(page.getByRole('button', { name: 'Move Watch Later up' })).toBeDisabled();
  await expect
    .poll(async () => ((await (await api.get('/api/preferences')).json()) as { home: { sections: string[]; hiddenSections: string[] } }).home)
    .toEqual(expect.objectContaining({ sections: ['watchLater', 'continue', 'recap', 'newEpisodes', 'recent', 'next', 'favorites'], hiddenSections: ['favorites'] }));
  await page.getByRole('button', { name: 'Done' }).click();
  const headings = await page.locator('.home-sec h2').allTextContents();
  expect(headings[0]).toBe('Watch Later');

  // forget the channel from Jump back in
  await section('Jump back in').getByRole('button', { name: `Remove ${fx.noGuideChannel.name} from Jump back in` }).click();
  await expect(section('Jump back in')).toHaveCount(0);

  // a channel that plays for a while lands in Jump back in
  await page.goto(`/play/live/${fx.archiveChannel.id}`);
  await expect
    .poll(async () => ((await (await api.get('/api/recent-channels')).json()) as { id: string }[]).map((r) => r.id), { timeout: 30_000 })
    .toEqual([fx.archiveChannel.id]);
});
