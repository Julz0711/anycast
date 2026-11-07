import type { ChannelList, ItemsById, MediaList } from '@anycast/shared';
import { expect, fx, test, waitForEvents } from './fixtures';

test.use({ profileOptions: { setupDone: true, prefs: { live: { layoutLarge: 'simple' } } } });

test('channel lists: create a list, add two channels, reorder, see the order on Live TV and on another device', async ({ profile }) => {
  const [firstId, secondId] = fx.zapChannels;
  const items = (await (await profile.api.get(`/api/items?live=${firstId},${secondId}`)).json()) as ItemsById;
  const [first, second] = items.live.map((c) => c.name) as [string, string];

  const a = await profile.device();
  const b = await profile.device();
  await a.goto('/live');
  const connected = waitForEvents(b);
  await b.goto('/live');
  await connected;

  // ⋯ on a channel row -> Add to list -> New list…
  await a.getByRole('button', { name: `More for ${first}` }).click();
  const sheet = a.getByRole('dialog', { name: `Add ${first} to a list` });
  await sheet.getByRole('button', { name: /New list/ }).click();
  await sheet.getByRole('textbox', { name: 'New list name' }).fill('News');
  await sheet.getByRole('button', { name: 'Create' }).click();
  await expect(sheet.getByRole('checkbox', { name: /^News/ })).toHaveAttribute('aria-checked', 'true');
  await a.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // the second channel, ticked in the same sheet
  await a.getByRole('button', { name: `More for ${second}` }).click();
  const sheet2 = a.getByRole('dialog', { name: `Add ${second} to a list` });
  await sheet2.getByRole('checkbox', { name: /^News/ }).click();
  await expect(sheet2.getByRole('checkbox', { name: /^News/ })).toHaveAttribute('aria-checked', 'true');
  await sheet2.getByRole('button', { name: 'Close' }).click();

  // the list is a chip right after the fixed ones, in the order the channels were added
  const groups = a.getByRole('toolbar', { name: 'Channel groups' });
  await expect(groups.getByRole('button').nth(1)).toHaveText('News');
  await groups.getByRole('button', { name: 'News', exact: true }).click();
  const rows = (page: typeof a) => page.locator('.live-list .ch-row .name').allInnerTexts().then((t) => t.map((x) => x.trim()));
  await expect.poll(() => rows(a)).toEqual([first, second]);

  // reorder in the editor
  await a.getByRole('button', { name: 'Edit list News' }).click();
  const editor = a.getByRole('dialog', { name: 'Edit News' });
  await editor.getByRole('button', { name: `Move ${second} up` }).click();
  await expect(editor.getByRole('list', { name: 'Channels in News' }).getByRole('listitem').first()).toContainText(second);
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => rows(a)).toEqual([second, first]);

  // zapping from the list follows the list's order
  await a.locator('.live-list .ch-row').first().click();
  await expect(a).toHaveURL(new RegExp(`/play/live/${secondId}$`));
  // the player's key handler mounts with the player; under load a press can land before it,
  // so press again only while the URL still shows the first channel (never overshoots)
  await expect(async () => {
    if (new RegExp(`/play/live/${secondId}$`).test(a.url())) await a.keyboard.press('ArrowDown');
    await expect(a).toHaveURL(new RegExp(`/play/live/${firstId}$`), { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });

  // the other device got the list over SSE, in the new order
  await b.getByRole('toolbar', { name: 'Channel groups' }).getByRole('button', { name: 'News', exact: true }).click();
  await expect.poll(() => rows(b)).toEqual([second, first]);

  expect(((await (await profile.api.get('/api/lists')).json()) as ChannelList[]).map((l) => [l.name, l.channelIds])).toEqual([['News', [secondId, firstId]]]);
});

test('Lists tab: Watch Later and a movie list from the movie page, a tab per list, synced to another device', async ({ profile }) => {
  const a = await profile.device();
  const b = await profile.device();

  // the main navigation order
  await a.goto('/live');
  const nav = a.getByRole('navigation', { name: 'Main' }).getByRole('link');
  await expect(nav).toHaveText([/Search/, /Favorites/, /Lists/, /Live TV/, /Movies/, /Series/, /Settings/]);

  await a.goto(`/movies/${fx.movie.id}`);
  await a.getByRole('button', { name: 'Watch later' }).click();
  await expect(a.getByRole('button', { name: 'In Watch Later' })).toHaveAttribute('aria-pressed', 'true');

  await a.getByRole('button', { name: 'Add to list' }).click();
  const sheet = a.getByRole('dialog', { name: `Add ${fx.movie.name} to a list` });
  await expect(sheet.getByRole('checkbox', { name: /^Watch Later/ })).toHaveAttribute('aria-checked', 'true');
  await sheet.getByRole('button', { name: /New list/ }).click();
  await sheet.getByRole('textbox', { name: 'New list name' }).fill('Date night');
  await sheet.getByRole('button', { name: 'Create' }).click();
  await expect(sheet.getByRole('checkbox', { name: /^Date night/ })).toHaveAttribute('aria-checked', 'true');
  await a.keyboard.press('Escape');

  // T opens Lists; Watch Later is the first tab and has the movie
  await a.keyboard.press('t');
  await expect(a).toHaveURL(/\/lists\/.+/);
  const tabs = a.getByRole('tablist', { name: 'Your lists' }).getByRole('tab');
  await expect(tabs.first()).toHaveText(/Watch Later\s*1/);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(a.getByRole('list', { name: 'Titles in Watch Later' }).getByRole('link', { name: new RegExp(`^${fx.movie.name}`) })).toBeVisible();

  // the other device sees the new list as a tab, and the removal from Watch Later
  await b.goto('/lists');
  await b.getByRole('tab', { name: /Date night/ }).click();
  await expect(b.getByRole('list', { name: 'Titles in Date night' }).getByRole('link', { name: new RegExp(`^${fx.movie.name}`) })).toBeVisible();
  await b.getByRole('tab', { name: /Watch Later/ }).click();
  await a.getByRole('button', { name: `Remove ${fx.movie.name} from Watch Later` }).click();
  await expect(b.getByRole('heading', { name: 'Nothing to watch later yet' })).toBeVisible();

  const lists = (await (await profile.api.get('/api/media-lists')).json()) as MediaList[];
  expect(lists.map((l) => [l.name, l.items.map((i) => i.id)])).toEqual([['Watch Later', []], ['Date night', [fx.movie.id]]]);
});
