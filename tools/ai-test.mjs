// Does the AI actually play?
//
// combat-test.mjs proves bullets move health. This proves the things that make
// a match worth being in: bots fight EACH OTHER, skill tiers are real, a bot
// runs a magazine dry and reloads it, and a bot that gets shot at gets out of
// the line.
//
// Every assertion drives the real game in a real browser through the real
// director and the real ballistics — the drills step the same fixedUpdate the
// game loop steps, they just step it thousands of times in one call so a
// 90-second firefight resolves in a second of wall clock.
//
//   npx vite build --outDir dist-ai
//   npx vite preview --outDir dist-ai --port 4545 --strictPort
//   node tools/ai-test.mjs --url http://localhost:4545

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const base = opt('url', 'http://localhost:4540');
const quick = args.includes('--quick');

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
const info = (line) => console.log(`      ${line}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1280, height: 720 },
  args: ['--no-sandbox', '--use-angle=d3d11', '--enable-gpu'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    console.error('[pageerror]', e.message);
    fails++;
  });
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[console.error]', m.text());
  });
  await page.goto(`${base}/?q=low`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), {
    timeout: 300000,
  });
  await new Promise((r) => setTimeout(r, 1200));

  const has = await page.evaluate(() => typeof window.__AI_TEST__ === 'object');
  check('AI test hooks present', has === true);
  if (!has) throw new Error('__AI_TEST__ missing — is this a game-mode build?');

  // Own the simulation: the live loop stops, the player leaves the world, so
  // anything that happens from here is bots doing it to each other.
  await page.evaluate(() => {
    window.__AI_TEST__.pause(true);
    window.__AI_TEST__.setPlayerActive(false);
  });

  // --- 1. skill tiers exist and are distributed ------------------------------
  const tiers = await page.evaluate(() => window.__AI_TEST__.tiers());
  const tierCount = Object.values(tiers).filter((n) => n > 0).length;
  info(`tier histogram: ${JSON.stringify(tiers)}`);
  check('at least three tiers present in a 15-bot lobby', tierCount >= 3, JSON.stringify(tiers));
  check(
    'elites are rare, ordinary bots are the norm',
    tiers.elite <= 3 && tiers.recruit + tiers.regular >= 7,
    `elite ${tiers.elite}, recruit+regular ${tiers.recruit + tiers.regular}`
  );

  // --- 2. BOTS FIGHT EACH OTHER ---------------------------------------------
  // Ten bots, one clearing, no player anywhere in the world.
  const clustered = await page.evaluate(() => window.__AI_TEST__.cluster(10, 42));
  check('brawl staged', clustered.ok === true, `${clustered.placed} bots placed`);

  const brawlSeconds = quick ? 45 : 90;
  for (let s = 0; s < brawlSeconds; s += 5) {
    await page.evaluate((n) => window.__AI_TEST__.step(n), 5 * 60);
  }
  const brawl = await page.evaluate(() => window.__AI_TEST__.info());
  const st = brawl.stats;
  info(
    `after ${brawlSeconds}s: ${st.botShots} bot rounds fired, ${st.botHitsOnBots} hits on other bots, ` +
      `${st.botDamageToBots.toFixed(0)} damage dealt bot-to-bot, ${st.botKillsOfBots} bot-on-bot kills`
  );
  info(
    `states: ${JSON.stringify(
      brawl.bots
        .filter((b) => b.enabled)
        .reduce((a, b) => ((a[b.state] = (a[b.state] ?? 0) + 1), a), {})
    )}`
  );
  info(`LOS rays: ${brawl.rays.spent} spent, ${brawl.rays.denied} denied by budget`);
  check('BOTS DAMAGE EACH OTHER WITH NO PLAYER INVOLVED', st.botDamageToBots > 0,
        `${st.botDamageToBots.toFixed(0)} hp of bot-on-bot damage from ${st.botHitsOnBots} hits`);
  check('BOTS KILL EACH OTHER', st.botKillsOfBots > 0, `${st.botKillsOfBots} bot-on-bot kills`);
  check('the player took no part', st.playerKills === 0 && st.botKillsOfPlayer === 0);
  const brawlReloads = brawl.bots.filter((b) => b.enabled).reduce((a, b) => a + b.reloads, 0);
  info(`magazines changed during the brawl: ${brawlReloads}`);
  check('bots reload mid-match, not just in the drill', brawlReloads > 0, `${brawlReloads} reloads`);

  // --- 3. tier duels ---------------------------------------------------------
  const trials = quick ? 6 : 12;
  const elite = await page.evaluate(
    (n) => window.__AI_TEST__.duel('elite', 'recruit', 34, n, 40),
    trials
  );
  info(
    `elite vs recruit @34m: elite ${elite.winsA}, recruit ${elite.winsB}, draws ${elite.draws} ` +
      `(durations ${elite.seconds.join('/')}s)`
  );
  const decisive = elite.winsA + elite.winsB;
  check(
    'ELITE BEATS RECRUIT over repeated duels',
    elite.winsA > elite.winsB && decisive > 0 && elite.winsA / Math.max(1, decisive) >= 0.65,
    `${elite.winsA}/${decisive} decisive duels won by the elite`
  );

  const vet = await page.evaluate(
    (n) => window.__AI_TEST__.duel('veteran', 'regular', 34, n, 40),
    trials
  );
  info(`veteran vs regular @34m: veteran ${vet.winsA}, regular ${vet.winsB}, draws ${vet.draws}`);
  check(
    'veteran edges regular (adjacent tiers still ordered)',
    vet.winsA >= vet.winsB,
    `${vet.winsA} vs ${vet.winsB}`
  );

  // --- 4. ammo and reloading -------------------------------------------------
  for (const tier of ['recruit', 'veteran']) {
    const rl = await page.evaluate((t) => window.__AI_TEST__.reloadDrill(t, 42, 30), tier);
    info(
      `${tier} magazine trace (every 0.5s): ${rl.trace.join(',')} | reserve left ${rl.reserve}`
    );
    check(
      `${tier} BOT RELOADS (ammo falls then rises)`,
      rl.ok && rl.reloads > 0 && rl.minAmmo < 30 && rl.sawReloadingFlag,
      `low water mark ${rl.minAmmo}, ${rl.reloads} reload completions, ended on ${rl.endAmmo}`
    );
  }

  // --- 5. cover --------------------------------------------------------------
  const coverTrials = quick ? 12 : 30;
  const cov = await page.evaluate(
    (n) => window.__AI_TEST__.coverDrill('veteran', n, 42, 9),
    coverTrials
  );
  info(
    `veteran cover drill over ${cov.trials} paired trials (same ground, same start):\n` +
      `      under fire, line of sight to the shooter broken in ${cov.underFireBroken}/${cov.trials} ` +
      `(${(cov.underFireRate * 100).toFixed(0)}%)\n` +
      `      undisturbed control run broke it in ${cov.controlBroken}/${cov.trials} ` +
      `(${(cov.controlRate * 100).toFixed(0)}%)`
  );
  check(
    'BOTS TAKE COVER: being shot at breaks LOS more often than chance',
    cov.ok && cov.underFireRate >= cov.controlRate + 0.1 && cov.underFireRate >= 0.4,
    `${(cov.underFireRate * 100).toFixed(0)}% under fire vs ${(cov.controlRate * 100).toFixed(0)}% control ` +
      `(time in cover state ${JSON.stringify(cov.stateHist)})`
  );

  const covRec = await page.evaluate(
    (n) => window.__AI_TEST__.coverDrill('recruit', n, 42, 9),
    coverTrials
  );
  info(
    `recruit under identical fire broke LOS in ${covRec.underFireBroken}/${covRec.trials} ` +
      `(${(covRec.underFireRate * 100).toFixed(0)}%) — recruits do not use cover, so this should be low`
  );
  // The cleanest A/B in the suite: identical stimulus, identical ground, the
  // only difference is that a veteran has cover behaviour and a recruit does not.
  check(
    'cover use is a SKILL: veterans hide, recruits stand there',
    cov.underFireRate >= covRec.underFireRate * 2,
    `veteran ${(cov.underFireRate * 100).toFixed(0)}% vs recruit ${(covRec.underFireRate * 100).toFixed(0)}%`
  );

  // --- 6. cost -------------------------------------------------------------
  const perf = await page.evaluate(() => window.__AI_TEST__.perf(900));
  const cost = await page.evaluate(() => window.__AI_TEST__.costProbe(300));
  info(
    `AI + ballistics: ${perf.msPerTick.toFixed(2)} ms per 60 Hz tick with ${perf.aliveBots} bots ` +
      `scattered (LOD from the camera), ${perf.msPerTickAllNear.toFixed(2)} ms with every one of ` +
      `them inside the near band at once`
  );
  info(
    `primitive costs on this machine: heightfield sample ${cost.heightUs} us, ` +
      `60 m raycast ${cost.ray60Us} us, moveCapsule ${cost.moveCapsuleUs} us — ` +
      `the AI's cost IS the physics collider walk, so the levers are tick rate and ray count`
  );
  check(
    'AI tick cost stays inside the frame',
    perf.msPerTick < 5,
    `${perf.msPerTick.toFixed(2)} ms/tick for ${perf.aliveBots} bots (frame budget 16.7 ms)`
  );

  // --- 7. hand the match back and confirm it still runs ----------------------
  await page.evaluate(() => window.__AI_TEST__.finish());
  await new Promise((r) => setTimeout(r, 2500));
  const live = await page.evaluate(() => ({
    ai: window.__AI_TEST__.info(),
    game: window.__TEST__.state(),
  }));
  info(
    `live match: ${live.game.alive} alive, ${live.ai.bots.filter((b) => b.state !== 'dead').length} bots standing`
  );
  check('match keeps running after the drills', live.game.matchState === 'playing');
  check('aliveCount is honest', live.game.alive === live.ai.bots.filter((b) => b.state !== 'dead').length + 1,
        `hud says ${live.game.alive}, bots standing ${live.ai.bots.filter((b) => b.state !== 'dead').length} + player`);
} finally {
  await browser.close();
}

console.log(fails === 0 ? '\nAI TEST PASS' : `\nAI TEST FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
