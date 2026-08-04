// Stages a live firefight and captures first-person combat frames:
// viewmodel + crosshair + full HUD + a bot in the sights, with the bot's own
// AI returning fire. Usage:
//   node tools/encounter-shots.mjs --url http://localhost:4500 --out review/shots/combat

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const base = opt('url', 'http://localhost:4500');
const out = resolve(opt('out', 'review/shots/combat'));
mkdirSync(out, { recursive: true });

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const browser = await puppeteer.launch({
  executablePath: CHROME_PATHS.find((p) => existsSync(p)),
  headless: true,
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  args: ['--no-sandbox', '--use-angle=d3d11', '--enable-gpu', '--window-size=1920,1120'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('done'),
    { timeout: 240000 }
  );
  await new Promise((r) => setTimeout(r, 2500));

  // Close encounter: 14m, bot in the crosshair.
  const ok = await page.evaluate(() => window.__TEST__.encounter(14));
  if (!ok) throw new Error('no living bot found for the encounter');
  console.log('encounter staged at 14m');

  // Frame 1: the instant of contact — bot centred, HUD calm.
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: resolve(out, 'contact.png') });
  console.log('-> contact.png');

  // Frames 2-4: the bot's AI engages (muzzle flash, tracers, damage arcs).
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 1400));
    await page.screenshot({ path: resolve(out, `firefight-${i + 1}.png`) });
    console.log(`-> firefight-${i + 1}.png  hp=${await page.evaluate(() => window.__TEST__.state().playerHp.toFixed(0))}`);
  }

  // Second staging, mid-range for a landscape read.
  const ok2 = await page.evaluate(() => window.__TEST__.encounter(30, -1));
  if (ok2) {
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: resolve(out, 'midrange.png') });
    console.log('-> midrange.png');
  }
} finally {
  await browser.close();
}
