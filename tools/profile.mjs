// Ablation profiler. Runs the bench flythrough repeatedly, removing one major
// consumer at a time, so the frame budget is MEASURED instead of guessed at.
//
//   node tools/profile.mjs --url http://localhost:4530
//
// Each row is the same scripted camera path; the delta against the baseline is
// what that system costs on this GPU at this preset.

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const base = opt('url', 'http://localhost:4530');
const q = opt('q', 'medium');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const RUNS = [
  ['baseline', ''],
  ['no woody (trees+bush)', 'woody'],
  ['no near blades', 'near'],
  ['no cover cards', 'cards'],
  ['no carpet', 'carpet'],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  args: ['--no-sandbox', '--use-angle=d3d11', '--enable-gpu', '--window-size=1920,1120'],
});

const rows = [];
try {
  for (const [label, off] of RUNS) {
    const page = await browser.newPage();
    const url = `${base}/?bench=1&q=${q}${off ? `&off=${off}` : ''}`;
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__BENCH_RESULT__ !== undefined, { timeout: 300000 });
    const r = JSON.parse(await page.evaluate(() => window.__BENCH_RESULT__));
    rows.push({ label, off, avgFps: r.avgFps, p1Low: r.p1Low });
    console.log(`${label.padEnd(18)} avg ${String(r.avgFps).padStart(5)}   1% low ${r.p1Low}`);
    await page.close();
  }
} finally {
  await browser.close();
}

const baseline = rows[0].avgFps;
console.log('\ncost of each system (ms/frame at the baseline):');
for (const r of rows.slice(1)) {
  const ms = (1000 / baseline) - (1000 / r.avgFps);
  console.log(`  ${r.label.padEnd(18)} ${ms.toFixed(1)} ms`);
}
mkdirSync(resolve('review/bench'), { recursive: true });
writeFileSync(resolve('review/bench/profile.json'), JSON.stringify(rows, null, 2));
