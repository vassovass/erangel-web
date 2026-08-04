// Characters-lane review capture, with gates the main harness cannot provide.
//
//   node src/gen/char-shots.mjs --out review/shots/characters/cycle-2
//
// tools/capture.mjs shoots the GAME frame; this shoots src/gen/char-preview.html
// (dev server, because it imports .ts directly) at the seven views that answer
// "how do these read", including 8 / 20 / 40m at gameplay FOV.
//
// It FAILS THE RUN (non-zero exit) when a frame does not actually contain
// characters, when soles are off the deck, or when a corpse rests on a single
// point. Last cycle a character capture with zero characters in it shipped
// silently into the blind panel; a gate, not a reviewer, is what stops that.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const OUT = opt('out');
if (!OUT) throw new Error('--out is required');
const VIEWS = (opt('views') || 'lineup,closeup,back,dead,m8,m20,m40,wall,treeline').split(',');

// Minimum on-plate figure height, in 1080p pixels, per view. A distance plate
// whose figures are too small to read is not evidence about how they read.
const MIN_H = { m8: 90, m20: 36, m40: 18, wall: 60, treeline: 30, lineup: 120 };

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
function findBrowser() {
  for (const p of CHROME_PATHS) if (existsSync(p)) return p;
  throw new Error('No Chrome/Edge found in standard locations');
}

async function startDev() {
  // Escape hatch for a loaded box: several lanes run in parallel here and
  // `npx vite` has been seen to sit on an npm lock for many minutes. Pass
  // --url http://localhost:PORT against a dev server you started yourself.
  const given = opt('url');
  if (given) return { url: given.replace(/\/$/, ''), kill: () => {} };
  const port = 5400 + Math.floor(Math.random() * 400);
  // char-preview.vite.config.mjs turns HMR and the file watcher OFF. Other
  // lanes save files in this tree every few seconds, and each save pushes a
  // full-reload that destroys the page's execution context mid-capture.
  const child = spawn('npx', [
    'vite', '--config', 'src/gen/char-preview.vite.config.mjs',
    '--port', String(port), '--strictPort',
  ], {
    cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  // vite colours its banner even when piped, and the ANSI runs land INSIDE the
  // URL ("localhost:<esc>5411"), so strip before matching.
  const clean = (s) => String(s).replace(/\[[0-9;]*m/g, '');
  const url = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('vite dev did not start in 40s')), 40000);
    child.stdout.on('data', (d) => {
      const m = clean(d).match(/Local:\s+(http:\/\/[^\s]+)/);
      if (m) { clearTimeout(t); res(m[1].replace(/\/$/, '')); }
    });
    child.on('exit', (c) => rej(new Error(`vite dev exited ${c}`)));
  });
  return { url, kill: () => child.kill('SIGTERM') };
}

const FAILURES = [];
const fail = (msg) => { FAILURES.push(msg); console.error(`  !! GATE: ${msg}`); };

async function main() {
  const server = await startDev();
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    args: [
      '--no-sandbox', '--use-angle=d3d11', '--enable-gpu',
      '--window-size=1920,1120', '--force-color-profile=srgb',
      '--disable-infobars', '--hide-crash-restore-bubble',
    ],
  });
  try {
    const page = await browser.newPage();
    let shaderErrors = 0;
    page.on('pageerror', (e) => { shaderErrors++; console.error('[page]', e.message); });
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'warning') {
        const txt = m.text().slice(0, 400);
        // vite serves no favicon for this dev-only page; that 404 is not a bug.
        if (t === 'error' && !/favicon|404 \(Not Found\)/.test(txt)) shaderErrors++;
        console.log(`[console.${t}]`, txt);
      }
    });

    mkdirSync(resolve(ROOT, OUT), { recursive: true });
    let booted = false;
    for (const view of VIEWS) {
      if (!booted) {
        const url = `${server.url}/src/gen/char-preview.html?view=${view}`;
        console.log(`view: ${url}`);
        // First hit makes vite pre-bundle three/postprocessing, and vite then
        // force-reloads the page mid-boot ("new dependencies optimized"), which
        // destroys the execution context under waitForFunction. Warm it, then
        // reload deliberately and only start waiting on the second load.
        await page.goto(url, { waitUntil: 'load', timeout: 90000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 4000));
        await page.reload({ waitUntil: 'load', timeout: 90000 });
        await page.waitForFunction(() => window.__SHOT_READY__ !== undefined, { timeout: 120000 });
        booted = true;
      } else {
        const ok = await page.evaluate((v) => window.__APPLY_POSE__(v), view);
        if (!ok) { fail(`unknown view ${view}`); continue; }
        await page.waitForFunction(() => window.__SHOT_READY__ !== undefined, { timeout: 40000 });
      }
      const file = resolve(ROOT, OUT, `sheet-${view}.png`);
      await page.screenshot({ path: file });
      // __INFO__ first: the metrics pass renders to its own targets and would
      // otherwise leave renderer.info reporting that instead of the frame.
      const info = await page.evaluate(() => (window.__INFO__ ? window.__INFO__() : null));
      const met = await page.evaluate(() => window.__METRICS__());
      const bf = await page.evaluate(() => window.__BACKFACE__());
      console.log(
        `  -> sheet-${view}.png  visible=${met.visible}/8 coverage=${met.coverage}% ` +
        `rough=${met.rough} minH=${met.minHeightPx}px char/ring luma=${met.charLuma}/${met.ringLuma} ` +
        `sep=${met.separation} detail=${met.detail} backface=${bf.back}px (${bf.bfRatio}%)` +
        (info ? ` (calls: ${info.calls}, tris: ${info.triangles})` : '')
      );

      // --- presence gate: an empty character capture must fail the run -------
      if (['lineup', 'm8', 'm20', 'm40', 'wall', 'treeline'].includes(view)) {
        if (met.visible < 5) fail(`${view}: only ${met.visible} of 5 standing figures visible`);
        if (met.coverage < 0.02) fail(`${view}: character coverage ${met.coverage}% — frame is empty`);
      }
      // --- on-plate SIZE gate -------------------------------------------------
      // Last cycle's mid-distance shot was 60% barn wall with one ~30px bot in
      // it, and every claim about the 8-40m read was signed off against that.
      // A capture that cannot show the thing it is evidence for now fails.
      if (MIN_H[view] !== undefined && met.minHeightPx < MIN_H[view]) {
        fail(`${view}: smallest standing figure is ${met.minHeightPx}px tall, needs >= ${MIN_H[view]}px`);
      }
      if (view === 'dead' && met.visible < 3) fail(`dead: only ${met.visible} corpses visible`);
      // --- silhouette break-up ------------------------------------------------
      if (view === 'm20' && met.rough < 40) {
        fail(`m20: silhouette roughness ${met.rough} — outline is an unbroken humanoid`);
      }
      // --- value separation from the ground -----------------------------------
      // 0.025 is BELOW the perceptual floor: it certified figures that visibly
      // dissolved into the terrain at 20-40m. A body has to hold a real value
      // step against the ground it stands on or it is not readable in a fight.
      if ((view === 'm20' || view === 'm40') && met.separation < 0.10) {
        fail(`${view}: character/ground luma separation ${met.separation} — figures dissolve`);
      }
      // Against a LIGHT wall and a DARK treeline the same figure has to hold a
      // step in BOTH directions. A ladder that only clears one background is a
      // coincidence of the plate, not a property of the character.
      if ((view === 'wall' || view === 'treeline') && met.separation < 0.055) {
        fail(`${view}: separation ${met.separation} against a ${view} background`);
      }
      // --- visible backfaces: an open limb bore ------------------------------
      // Collars, cuffs, hems and the boot collar are open shells by design and
      // contribute a legitimate sliver. A visible BORE is an order of magnitude
      // larger, so the gate sits above the shells and well under a hole.
      if (bf.bfRatio > 0.9) {
        fail(`${view}: ${bf.bfRatio}% of the figure is a visible BACKFACE — a limb tube is open`);
      }
    }

    // --- contact gate ---------------------------------------------------------
    const diag = await page.evaluate(() => window.__DIAG__());
    console.log('contact report:');
    for (const d of diag) {
      console.log(
        `  ${d.tag.padEnd(16)} minY=${d.minY} sole=${d.worst} ` +
        `restingChainMax=${d.downMax} contacts=${d.contacts}`
      );
      if (d.tag.startsWith('alive')) {
        if (Math.abs(d.worst) > 0.045) fail(`${d.tag}: sole ${d.worst}m off the deck`);
      } else {
        // Resting chain = shoulder -> hip -> knee -> boot on the down side. A
        // rigid body 57cm across the shoulders and 15cm across the boots cannot
        // touch at all four stations, so ~7cm of residual is the real taper;
        // anything past 8.5cm means the corpse is balanced on a corner.
        if (d.downMax > 0.085) fail(`${d.tag}: resting chain peaks ${d.downMax}m up — body is on a corner`);
        if (d.worst > 0.06) fail(`${d.tag}: boots ${d.worst}m clear of the ground`);
        if (d.minY < -0.07) fail(`${d.tag}: body sunk ${d.minY}m through the ground`);
      }
    }

    // --- value-ladder audit --------------------------------------------------
    // Chunked: building 64 rigs in one evaluate() call holds the page's main
    // thread long enough that a loaded box looks like a hang, and there is no
    // progress to read. Eight batches of eight give the same coverage and a
    // heartbeat.
    const audit = { seeds: 0, count: 0, violations: [] };
    for (let batch = 0; batch < 8; batch++) {
      const r = await page.evaluate((b) => window.__AUDIT__(8, b * 8), batch);
      audit.seeds += r.seeds;
      audit.count += r.count;
      for (const v of r.violations) if (audit.violations.length < 12) audit.violations.push(v);
    }
    console.log(`value ladder: ${audit.count} violations over ${audit.seeds} seeds`);
    for (const v of audit.violations) {
      console.log(`  seed ${v.seed} ${v.slot}: got ${v.got} want ${v.want} (${v.why})`);
    }
    if (audit.count > 0) {
      fail(`value ladder: ${audit.count} slot violations over ${audit.seeds} seeds`);
    }

    // --- albedo variance: is there any pattern on the cloth at all? ----------
    const cloth = await page.evaluate(() => window.__CLOTH__());
    console.log(`cloth luma sigma: min=${cloth.min.toFixed(4)}`);
    if (cloth.min < 0.040) {
      fail(`cloth luma sigma ${cloth.min.toFixed(4)} — a figure's garments carry no pattern`);
    }

    if (shaderErrors > 0) fail(`${shaderErrors} console/page errors — a shader or module broke`);
  } finally {
    await browser.close();
    server.kill();
  }

  if (FAILURES.length) {
    console.error(`\nCHAR-SHOTS FAILED (${FAILURES.length} gate failures)`);
    process.exit(1);
  }
  console.log('\nchar-shots: all gates passed');
}

main().catch((e) => {
  console.error(`CHAR-SHOTS FAILED: ${e.message}`);
  process.exit(1);
});
