// Scripted functional playtest — the Phase 2 gate. Boots the real game in
// headless Chrome (real GPU), drives it with actual input events plus the
// __TEST__ hooks, and asserts the BR loop end to end. Exit 0 = all pass.
//
//   node tools/playtest.mjs [--url http://localhost:4399]

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

async function startPreview() {
  const port = 4300 + Math.floor(Math.random() * 400);
  const child = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: resolve(import.meta.dirname, '..'),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('preview timeout')), 30000);
    child.stdout.on('data', (d) => {
      const m = String(d).match(/Local:\s+(http:\/\/[^\s]+)/);
      if (m) { clearTimeout(timer); res(m[1].replace(/\/$/, '')); }
    });
    child.on('exit', () => rej(new Error('preview died')));
  });
  return { url, kill: () => child.kill('SIGTERM') };
}

async function main() {
  let base = opt('url');
  let server = null;
  if (!base) {
    server = await startPreview();
    base = server.url;
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATHS.find((p) => existsSync(p)),
    headless: true,
    defaultViewport: { width: 1600, height: 900 },
    args: ['--no-sandbox', '--use-angle=d3d11', '--enable-gpu', '--window-size=1600,960'],
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => {
      console.error('[pageerror]', e.message);
      failures++;
    });
    await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 120000 });
    await new Promise((r) => setTimeout(r, 1500));

    const T = (expr) => page.evaluate(`window.__TEST__.${expr}`);
    const s0 = await T('state()');
    check('boot: 16 alive', s0.alive === 16, `alive=${s0.alive}`);
    check('boot: player at full hp', s0.playerHp === 100);
    check('boot: 30 rounds loaded', s0.ammo === 30);

    // Movement: hold W for 1.5s, position must change by > 3m.
    await page.click('canvas');
    await new Promise((r) => setTimeout(r, 300));
    await page.keyboard.down('KeyW');
    await new Promise((r) => setTimeout(r, 1500));
    await page.keyboard.up('KeyW');
    const s1 = await T('state()');
    const moved = Math.hypot(s1.playerPos[0] - s0.playerPos[0], s1.playerPos[2] - s0.playerPos[2]);
    check('movement: W moves player', moved > 3, `moved ${moved.toFixed(1)}m`);

    // Firing: pointer lock is active after click; hold LMB ~0.4s = ~4 rounds.
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, 400));
    await page.mouse.up();
    const s2 = await T('state()');
    check('firing: ammo consumed', s2.ammo < s1.ammo, `${s1.ammo} -> ${s2.ammo}`);

    // Reload.
    await page.keyboard.press('KeyR');
    await new Promise((r) => setTimeout(r, 3400));
    const s3 = await T('state()');
    check('reload: mag refilled', s3.ammo === 30, `ammo=${s3.ammo}`);
    check('reload: reserve spent', s3.reserve < s2.reserve || s2.ammo === 30, `reserve=${s3.reserve}`);

    // Kill via hook: alive count drops, kill registers.
    await T('damageBot(0, 250)');
    await new Promise((r) => setTimeout(r, 400));
    const s4 = await T('state()');
    check('bot death: alive drops to 15', s4.alive === 15, `alive=${s4.alive}`);

    // Zone: fast-forward 90s, radius must shrink from initial.
    const r0 = s4.zoneRadius;
    await T('ffwdZone(120)');
    const s5 = await T('state()');
    check('zone: radius shrinks', s5.zoneRadius < r0, `${r0.toFixed(0)} -> ${s5.zoneRadius.toFixed(0)}`);

    // Zone damage: teleport far outside, wait 3s of sim, hp must drop.
    await T('teleport(560, 560)');
    await new Promise((r) => setTimeout(r, 3200));
    const s6 = await T('state()');
    check('zone: damages player outside', s6.playerHp < 100, `hp=${s6.playerHp.toFixed(1)}`);

    // Kill the rest: match must end in a win while player alive, or dead state.
    for (let i = 1; i < 15; i++) await T(`damageBot(${i}, 500)`);
    await new Promise((r) => setTimeout(r, 600));
    const s7 = await T('state()');
    check('win: match resolves', s7.matchState === 'won' || s7.playerDead, `state=${s7.matchState}`);
  } finally {
    await browser.close();
    server?.kill();
  }

  console.log(failures === 0 ? '\nPLAYTEST PASS' : `\nPLAYTEST FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('PLAYTEST ERROR:', e.message);
  process.exit(1);
});
