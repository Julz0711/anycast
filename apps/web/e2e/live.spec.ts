import { clockIn, expect, expectPlaying, fx, test, timelinePosition } from './fixtures';

const MIN = 60_000;

/** How the app labels category chips ("DE | Sport" -> "DE · Sport"). */
const chip = (name: string) => name.replace(/\s*\|\s*/, ' · ');

test.describe('live TV', () => {
  test('missed the start: type-a-time 25 min back on an archive channel, then go live', async ({ profile }) => {
    const page = await profile.device();
    await page.goto(`/play/live/${fx.archiveChannel.id}`);
    await expectPlaying(page);
    await expect(page.locator('.pl-badge')).toHaveText('LIVE');

    await page.getByRole('button', { name: 'Jump to time…' }).click();
    await page.getByRole('textbox', { name: /Jump to a time/ }).fill('-25m');
    const asked = Date.now() - 25 * MIN;
    await page.getByRole('button', { name: 'Go', exact: true }).click();

    // the playhead lands about 25 min back (the archive starts on a whole minute) and plays on from there
    await expect.poll(async () => Math.abs((await timelinePosition(page)) - asked), { timeout: 30_000 }).toBeLessThan(90_000);
    await expectPlaying(page);
    await expect(page.locator('.pl-badge')).toHaveText(/^−(24|25|26):\d\d behind live$/);
    const pos = await timelinePosition(page);
    expect([await clockIn(page, pos), await clockIn(page, pos + MIN)]).toContain(await page.locator('.rb-cur').textContent());

    await page.getByRole('button', { name: /^Go live/ }).click();
    await expect(page.locator('.pl-badge')).toHaveText('LIVE', { timeout: 30_000 });
    await expect.poll(async () => Date.now() - (await timelinePosition(page))).toBeLessThan(30_000);
    await expectPlaying(page);
  });

  test('quick zap: arrow keys on the player change the channel', async ({ profile }) => {
    const page = await profile.device();
    const [first, second] = fx.zapChannels;
    await page.goto(`/play/live/${first}`);
    await expect(page.getByRole('slider', { name: 'Timeline' })).toBeVisible();

    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(new RegExp(`/play/live/${second}$`));
    await expect(page.locator('.pl-meta-line')).toContainText(/^2 · /);

    await page.keyboard.press('ArrowUp');
    await expect(page).toHaveURL(new RegExp(`/play/live/${first}$`));
    await expect(page.locator('.pl-meta-line')).toContainText(/^1 · /);
  });

  test.describe(() => {
    test.use({ profileOptions: { setupDone: true, favorites: [{ kind: 'live', id: fx.archiveChannel.id }], prefs: { live: { layoutLarge: 'extended' } } } });

    test("last night's show: a past programme in the extended guide plays from its start", async ({ profile }) => {
      const page = await profile.device();
      await page.goto('/live');
      await page.getByRole('toolbar', { name: 'Channel groups' }).getByRole('button', { name: 'Favorites' }).click();
      const guide = page.getByRole('grid', { name: 'TV guide' });
      await expect(guide.getByRole('button', { name: new RegExp(`${fx.archiveChannel.name}, watch live`) })).toBeVisible();

      const past = guide.getByRole('gridcell', { name: /, Play from start$/ });
      await expect(past.first()).toBeVisible();
      const show = past.last();
      await show.click();

      await expect(page).toHaveURL(new RegExp(`/play/live/${fx.archiveChannel.id}\\?at=\\d+$`));
      const at = Number(new URL(page.url()).searchParams.get('at'));
      await expectPlaying(page);
      // the playhead is at the programme's start (and moving on from it)
      await expect.poll(async () => (await timelinePosition(page)) - at, { timeout: 20_000 }).toBeGreaterThanOrEqual(-1000);
      expect((await timelinePosition(page)) - at).toBeLessThan(90_000);
      expect([await clockIn(page, at), await clockIn(page, at + MIN)]).toContain(await page.locator('.rb-cur').textContent());
      await expect(page.locator('.pl-badge')).toHaveText(/behind live$/);
    });
  });
});

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('channels without guide data', () => {
  test.use({ profileOptions: { setupDone: true, prefs: { live: { layoutLarge: 'extended' } } } });

  test('a calm row in the guide, the group name in the list, and a filter to hide them', async ({ profile }) => {
    const ch = fx.noGuideChannel;
    const page = await profile.device();
    const asked: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname === '/api/epg') asked.push(...(u.searchParams.get('channelIds') ?? '').split(','));
    });
    await page.goto('/live');
    await page.getByRole('toolbar', { name: 'Channel groups' }).getByRole('button', { name: chip(ch.category), exact: true }).click();

    // Extended: one quiet block, and its guide is never asked for
    const guide = page.getByRole('grid', { name: 'TV guide' });
    const block = guide.getByRole('gridcell', { name: `${ch.name}, no guide, watch live` });
    await expect(block).toBeVisible();
    await expect(block).toContainText('No guide · Watch live');
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked).not.toContain(ch.id);

    // Simple: the group name instead of now/next
    await page.getByRole('radiogroup', { name: 'Live TV layout' }).getByRole('radio', { name: 'Simple' }).click();
    const row = page.getByRole('list', { name: 'Channels' }).getByRole('button', { name: new RegExp(`${esc(ch.name)}, ${esc(chip(ch.category))}$`) });
    await expect(row).toBeVisible();

    // the quick filter hides channels without a guide (and is a synced preference)
    await page.getByRole('button', { name: 'With guide' }).click();
    await expect(page.getByRole('button', { name: 'With guide' })).toHaveAttribute('aria-pressed', 'true');
    await expect(row).toHaveCount(0);
    await expect.poll(async () => ((await (await profile.api.get('/api/preferences')).json()) as { live: { guideOnlyWithEpg?: boolean } }).live.guideOnlyWithEpg).toBe(true);
  });
});
