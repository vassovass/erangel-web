// Real draw-call / triangle count for a built shot pose.
//
//   npx vite preview --outDir dist-characters --port 4388 &
//   node src/gen/char-calls.mjs --url http://localhost:4388 --pose bots-mid
//
// tools/capture.mjs prints `calls: 1, tris: 1` for every pose because
// renderer.info reflects the LAST render call, and with the post pipeline on
// that is the final full-screen composite — not the frame. Booting the same
// pose with ?nopost=1 makes renderer.info describe the scene render itself,
// which is the number the <=400 budget is actually about.

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const BASE = opt('url');
const POSES = (opt('pose') || 'bots-mid').split(',');
if (!BASE) throw new Error('--url is required');

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const browserPath = CHROME_PATHS.find((p) => existsSync(p));
if (!browserPath) throw new Error('No Chrome/Edge found');

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  args: ['--no-sandbox', '--use-angle=d3d11', '--enable-gpu', '--force-color-profile=srgb'],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300));
  });
  let booted = false;
  for (const pose of POSES) {
    if (!booted) {
      await page.goto(`${BASE}/?shot=${pose}&nopost=1`, { waitUntil: 'load', timeout: 90000 });
      await page.waitForFunction(() => window.__SHOT_READY__ !== undefined, { timeout: 300000 });
      booted = true;
    } else {
      await page.evaluate((p) => window.__APPLY_POSE__(p), pose);
      await page.waitForFunction(() => window.__SHOT_READY__ !== undefined, { timeout: 60000 });
    }
    const info = await page.evaluate(() => window.__INFO__());
    console.log(`${pose}: calls=${info.calls} tris=${info.triangles}`);
  }
} finally {
  await browser.close();
}
