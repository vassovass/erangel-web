// Does shooting actually hurt anyone? The 00:58 playtest asserted that firing
// CONSUMES AMMO and that a scripted damageBot() call kills — it never asserted
// that a real bullet, fired from the real weapon down the real crosshair, ever
// reaches a bot. This does, plus the reciprocal (a bot shooting the player) and
// loot pickup, which is the other thing reported broken.
//
//   node tools/combat-test.mjs --url http://localhost:4530

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const base = opt('url', 'http://localhost:4530');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1280, height: 720 },
  args: ['--no-sandbox', '--use-angle=d3d11', '--enable-gpu'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.error('[pageerror]', e.message); fails++; });
  await page.goto(`${base}/?q=low`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('done'),
    { timeout: 300000 }
  );
  await new Promise((r) => setTimeout(r, 1500));

  // --- 1. player shoots a bot ------------------------------------------------
  const staged = await page.evaluate(() => window.__TEST__.encounter(18));
  check('encounter staged', staged === true);

  const before = await page.evaluate(() => window.__TEST__.combat());
  await page.click('canvas');                       // pointer lock -> weapon live
  await new Promise((r) => setTimeout(r, 300));
  // SHORT BURSTS, re-aiming between them. A single 2.5 s burst walks the muzzle
  // several degrees up the AKM recoil pattern and every later round sails over
  // the target — correct weapon behaviour, and a bad way to ask "can bullets
  // hit a bot at all".
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.__TEST__.encounter(18));
    await new Promise((r) => setTimeout(r, 260));
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, 320));   // ~3 rounds
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 420));
  }
  const after = await page.evaluate(() => window.__TEST__.combat());

  check('rounds left the muzzle', after.fired > before.fired,
        `fired ${before.fired} -> ${after.fired}`);
  check('bullets resolved against the world', after.impacts + after.targetHits > 0,
        `impacts ${after.impacts}, target hits ${after.targetHits}`);
  check('BULLETS HIT THE BOT', after.targetHits > 0, `target hits ${after.targetHits}`);
  // Whole-field: which bot the aim ray happens to resolve to varies, so assert
  // that SOMEONE out there lost health rather than trusting a single lookup.
  check('A BOT LOST HEALTH', after.minBotHp < 100,
        `lowest bot hp ${after.minBotHp}, alive ${after.botsAlive}/15`);

  // --- 2. bots shoot the player ---------------------------------------------
  await page.evaluate(() => window.__TEST__.encounter(14));
  const p0 = await page.evaluate(() => window.__TEST__.state().playerHp);
  await new Promise((r) => setTimeout(r, 9000));    // let their AI engage
  const p1 = await page.evaluate(() => window.__TEST__.combat());
  check('PLAYER TAKES RETURN FIRE', p1.damageTaken > 0,
        `cumulative damage taken ${p1.damageTaken.toFixed(1)}`);

  // --- 3. loot ---------------------------------------------------------------
  const loot = await page.evaluate(() => window.__TEST__.lootProbe());
  check('loot is reachable and pickable', loot.picked === true,
        `nearest ${loot.type ?? 'none'} at ${loot.dist?.toFixed?.(2) ?? '?'}m, reserve ${loot.before} -> ${loot.after}`);

  // --- 4. solidity -----------------------------------------------------------
  const solid = await page.evaluate(() => window.__TEST__.solidProbe());
  check('buildings block movement', solid.blocked === true,
        `walked ${solid.penetration.toFixed(2)}m into a wall`);
} finally {
  await browser.close();
}

console.log(fails === 0 ? '\nCOMBAT TEST PASS' : `\nCOMBAT TEST FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
