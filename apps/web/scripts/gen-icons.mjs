// Renders the AnyCast mark to PNG icons with Playwright (dev-time only; outputs are committed in public/).
// Usage: node scripts/gen-icons.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // preinstalled globally; run with NODE_PATH=$(npm root -g)

const mark = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0E0F11"/>
  <g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 512})">
    <rect x="72" y="104" width="368" height="240" rx="64" fill="none" stroke="#ECEDEE" stroke-width="36"/>
    <rect x="72" y="388" width="368" height="28" rx="14" fill="#4A4E56"/>
    <rect x="72" y="388" width="236" height="28" rx="14" fill="#F5A524"/>
  </g>
</svg>`;

writeFileSync('public/favicon.svg', mark(0).replace('<rect width="512" height="512" fill="#0E0F11"/>', '<rect width="512" height="512" rx="112" fill="#0E0F11"/>'));
writeFileSync('public/icon.svg', mark(0));

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['icon-maskable-512.png', 512, 72], ['apple-touch-icon.png', 180, 24]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${mark(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `public/${name}`, omitBackground: false });
}
await browser.close();
console.log('icons written');
