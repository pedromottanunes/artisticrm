import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// Render the existing clinic logo on its brand background; no new logo artwork.
const logo = (await readFile(new URL('../public/artisti-logo.webp', import.meta.url))).toString(
  'base64',
);
const folder = new URL('../public/icons/', import.meta.url);
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, size] of [
    ['icon-192', 192],
    ['icon-512', 512],
    ['apple-touch-icon', 180],
  ]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<body style="margin:0;width:100vw;height:100vh;background:#07192d;display:grid;place-items:center"><img style="width:76%;height:auto" src="data:image/webp;base64,${logo}"></body>`,
    );
    await page.locator('img').evaluate((img) => img.decode());
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, folder)) });
    await page.close();
  }
} finally {
  await browser.close();
}
