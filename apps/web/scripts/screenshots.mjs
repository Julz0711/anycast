// Demo-mode screenshots at phone / desktop / TV sizes. Needs `VITE_DEMO=1 vite` running on :5173.
// Usage: NODE_PATH=$(npm root -g) node scripts/screenshots.mjs [filter]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const filter = process.argv[2] ?? '';

const devices = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, accent: 'sky', q: '' },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, accent: 'amber', q: '' },
  tv: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, accent: 'mint', q: '?tv=1' },
};
const at = Date.now() - 24 * 60_000 - 10_000;
const shots = [
  ['live-simple', '/live', { live: { layoutPhone: 'simple', layoutLarge: 'simple', layoutTv: 'simple' } }],
  ['live-extended', '/live', { live: { layoutPhone: 'extended', layoutLarge: 'extended', layoutTv: 'extended' } }],
  ['movies', '/movies', {}],
  ['series-page', '/series/s1', {}],
  ['player-live', `/play/live/ch101?at=${at}`, {}, 2500],
  ['settings-basic', '/settings', { settingsMode: 'basic' }],
  ['settings-all', '/settings', { settingsMode: 'all' }],
  ['favorites-live', '/favorites/live', { live: { layoutPhone: 'simple' } }],
  ['favorites-movies', '/favorites/movies', {}],
  ['favorites-series-az', '/favorites/series', {}, 700, { 'anycast.favSort': 'az' }],
  // channel lists (LB-3): a list chip selected, the add-to-list sheet, the list editor, Settings
  ['lists-live', '/live', { live: { layoutPhone: 'simple', layoutLarge: 'simple', layoutTv: 'simple' } }, 700, { 'anycast.liveCat': 'list:l1' }],
  ['lists-live-extended', '/live', { live: { layoutPhone: 'extended', layoutLarge: 'extended', layoutTv: 'extended' } }, 900, { 'anycast.liveCat': 'list:l2' }],
  ['lists-add-sheet', '/live', { live: { layoutPhone: 'simple', layoutLarge: 'simple', layoutTv: 'simple' } }, 700, { 'anycast.liveCat': 'list:l1' },
    (page) => page.locator('.ch-more').nth(1).click()],
  ['lists-editor', '/live', { live: { layoutPhone: 'simple', layoutLarge: 'simple', layoutTv: 'simple' } }, 700, { 'anycast.liveCat': 'list:l1' },
    (page) => page.getByRole('button', { name: 'Edit list News' }).click()],
  ['lists-settings', '/settings', { settingsMode: 'all' }, 700, {},
    (page) => page.locator('#set-lists').evaluate((el) => el.scrollIntoView({ block: 'start' }))],
  ['lists-player', '/play/live/ch131', {}, 1500, {}, (page) => page.getByRole('button', { name: 'Add to list' }).first().click()],
];

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const problems = [];
for (const [dev, cfg] of Object.entries(devices)) {
  for (const [name, path, prefs, extraWait = 700, local = {}, action] of shots) {
    const file = /^(favorites|lists)/.test(name) ? `${name}-${dev}.png` : `${dev}-${name}.png`;
    if (filter && !file.includes(filter)) continue;
    const ctx = await browser.newContext({ viewport: cfg.viewport, deviceScaleFactor: cfg.deviceScaleFactor, isMobile: cfg.isMobile, hasTouch: cfg.hasTouch });
    const p = { ...prefs, appearance: { accent: cfg.accent } };
    await ctx.addInitScript(([p, local]) => {
      for (const [k, v] of Object.entries(local)) localStorage.setItem(k, v);
      localStorage.setItem('anycast.profile.u1', 'p1');
      sessionStorage.setItem('anycast.demo', '1');
      sessionStorage.setItem('anycast.demo.prefs.p1', JSON.stringify(p));
      localStorage.removeItem('anycast.prefs.p1');
    }, [p, local]);
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && problems.push(`${file}: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`${file}: ${e.message}`));
    const sep = cfg.q ? (path.includes('?') ? '&' + cfg.q.slice(1) : cfg.q) : '';
    await page.goto(BASE + path + sep, { waitUntil: 'networkidle' });
    await page.waitForTimeout(extraWait);
    if (action) {
      await action(page);
      await page.waitForTimeout(600);
    }
    // horizontal overflow check
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) problems.push(`${file}: horizontal overflow ${overflow}px`);
    await page.screenshot({ path: OUT + file });
    console.log('saved', file);
    await ctx.close();
  }
}
// Parental lock (the demo profile has one adult group, locked with PIN 1234): pin-<shot>-<device>.png
const pinShots = [
  ['dialog', '/live', async (page) => {
    await page.getByRole('button', { name: /Late Night, locked/ }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.keyboard.type('0000');
    await page.keyboard.press('Enter');
    await page.getByText(/Wrong PIN/).waitFor();
    await page.waitForTimeout(500);
    await page.keyboard.type('12');
  }],
  ['settings', '/settings', async (page) => {
    await page.locator('#set-parental').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  }],
  ['locked', '/live', async () => {}, { 'anycast.liveCat': 'lcx' }],
  ['unlocked', '/live', async (page) => {
    await page.getByRole('button', { name: /Late Night, locked/ }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.type('1234');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /Velvet Room/ }).first().waitFor();
  }],
];
for (const dev of ['phone', 'desktop']) {
  const cfg = devices[dev];
  for (const [name, path, act, local = {}] of pinShots) {
    const file = `pin-${name}-${dev}.png`;
    if (filter && !file.includes(filter)) continue;
    const ctx = await browser.newContext({ viewport: cfg.viewport, deviceScaleFactor: cfg.deviceScaleFactor, isMobile: cfg.isMobile, hasTouch: cfg.hasTouch });
    const p = { settingsMode: 'all', live: { layoutPhone: 'simple', layoutLarge: 'simple' }, appearance: { accent: cfg.accent } };
    await ctx.addInitScript(([p, local]) => {
      for (const [k, v] of Object.entries(local)) localStorage.setItem(k, v);
      localStorage.setItem('anycast.profile.u1', 'p1');
      sessionStorage.setItem('anycast.demo', '1');
      sessionStorage.setItem('anycast.demo.prefs.p1', JSON.stringify(p));
      localStorage.removeItem('anycast.prefs.p1');
    }, [p, local]);
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && problems.push(`${file}: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`${file}: ${e.message}`));
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await act(page);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) problems.push(`${file}: horizontal overflow ${overflow}px`);
    await page.screenshot({ path: OUT + file });
    console.log('saved', file);
    await ctx.close();
  }
}

await browser.close();
if (problems.length) console.log('PROBLEMS:\n' + problems.join('\n'));
