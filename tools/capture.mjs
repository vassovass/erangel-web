// Screenshot + benchmark harness on the REAL GPU.
//
//   node tools/capture.mjs --poses terrain-vista,fields-low --out review/shots/terrain/cycle-1
//   node tools/capture.mjs --bench --out review/bench/latest.json
//
// Options: --url <base>  use a running server (dev or preview); otherwise this
//          script spawns `npx vite preview` over dist/ (run a build first).
//          --tod <h>     time-of-day override appended to the app URL.
//          --headful     force a visible window (benches always run headful:
//                        headless FPS numbers are not trustworthy).
//
// GPU: launched with --use-angle=gl (verified path for hardware WebGL in
// headless Chrome on Intel Gen9.5). Any run that lands on SwiftShader FAILS.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}
const flag = (name) => args.includes(`--${name}`);

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

async function startPreview(attempt = 0) {
  if (attempt >= 3) throw new Error('vite preview failed 3 times');
  try {
    return await startPreviewOnce();
  } catch {
    return startPreview(attempt + 1);
  }
}

async function startPreviewOnce() {
  const port = 4300 + Math.floor(Math.random() * 400);
  const dist = opt('dist');
  const previewArgs = ['vite', 'preview', '--port', String(port), '--strictPort'];
  if (dist) previewArgs.push('--outDir', dist);
  const child = spawn('npx', previewArgs, {
    cwd: resolve(import.meta.dirname, '..'),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error('vite preview did not start in 30s')), 30000);
    child.stdout.on('data', (d) => {
      const m = String(d).match(/Local:\s+(http:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[1].replace(/\/$/, ''));
      }
    });
    child.stderr.on('data', (d) => {
      if (String(d).includes('EADDRINUSE')) {
        clearTimeout(timer);
        reject(new Error('preview port in use'));
      }
    });
    child.on('exit', (code) => reject(new Error(`vite preview exited ${code}`)));
  });
  return { url, kill: () => child.kill('SIGTERM') };
}

async function launch(headful) {
  return puppeteer.launch({
    executablePath: findBrowser(),
    headless: !headful,
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    args: [
      '--no-sandbox',
      '--use-angle=d3d11',
      '--enable-gpu',
      '--window-size=1920,1120',
      '--force-color-profile=srgb',
      '--disable-infobars',
      '--hide-crash-restore-bubble',
    ],
  });
}

async function verifyGpu(page) {
  const rendererStr = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'NO-WEBGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  if (/swiftshader|software/i.test(rendererStr) || rendererStr === 'NO-WEBGL') {
    throw new Error(`Software rendering detected: ${rendererStr}`);
  }
  return rendererStr;
}

async function waitForGlobal(page, name, timeoutMs) {
  await page.waitForFunction((n) => window[n] !== undefined, { timeout: timeoutMs }, name);
}

async function main() {
  const out = opt('out');
  if (!out) throw new Error('--out is required');
  const bench = flag('bench');
  const headful = bench || flag('headful');
  const tod = opt('tod');

  let server = null;
  let base = opt('url');
  if (!base) {
    server = await startPreview();
    base = server.url;
  }

  const browser = await launch(headful);
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[page]', e.message));
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'warning') console.log(`[console.${t}]`, m.text().slice(0, 500));
    });
    const gpu = await verifyGpu(page);
    console.log(`GPU: ${gpu}`);

    if (flag('game')) {
      // Smoke test: boot the full game mode, wait for the loader to finish,
      // let the match run a few seconds, screenshot.
      await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(
        () => document.getElementById('loading')?.classList.contains('done'),
        { timeout: 120000 }
      );
      await new Promise((r) => setTimeout(r, 4000));
      const state = await page.evaluate(() => ({
        alive: document.getElementById('alive')?.textContent,
        zone: document.getElementById('zonetimer')?.textContent,
        ammo: document.getElementById('mag')?.textContent,
      }));
      console.log('game state:', JSON.stringify(state));
      mkdirSync(dirname(resolve(out)), { recursive: true });
      await page.screenshot({ path: resolve(out) });
      console.log(`  -> ${resolve(out)}`);
    } else if (bench) {
      const url = `${base}/?bench=1${tod ? `&tod=${tod}` : ''}`;
      console.log(`bench: ${url}`);
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await waitForGlobal(page, '__BENCH_RESULT__', 120000);
      const result = JSON.parse(await page.evaluate(() => window.__BENCH_RESULT__));
      result.gpu = gpu;
      result.headful = headful;
      result.timestamp = new Date().toISOString();
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
    } else {
      const poses = (opt('poses') || '').split(',').filter(Boolean);
      if (poses.length === 0) throw new Error('--poses is required for shot capture');
      mkdirSync(resolve(out), { recursive: true });
      // World-gen is expensive: boot ONCE on the first pose, then re-pose in-page.
      let booted = false;
      for (const pose of poses) {
        if (!booted) {
          const url = `${base}/?shot=${pose}${tod ? `&tod=${tod}` : ''}`;
          console.log(`shot: ${url}`);
          await page.goto(url, { waitUntil: 'load', timeout: 60000 });
          await waitForGlobal(page, '__SHOT_READY__', 240000);
          booted = true;
        } else {
          console.log(`shot (re-pose): ${pose}`);
          const ok = await page.evaluate((p) => window.__APPLY_POSE__ && window.__APPLY_POSE__(p), pose);
          if (!ok) {
            console.error(`  !! unknown pose ${pose}, skipped`);
            continue;
          }
          await waitForGlobal(page, '__SHOT_READY__', 60000);
        }
        const file = resolve(out, `${pose}.png`);
        await page.screenshot({ path: file });
        const info = await page.evaluate(() => (window.__INFO__ ? window.__INFO__() : null));
        console.log(`  -> ${file}${info ? ` (calls: ${info.calls}, tris: ${info.triangles})` : ''}`);
      }
    }
  } finally {
    await browser.close();
    server?.kill();
  }
}

main().catch((err) => {
  console.error(`CAPTURE FAILED: ${err.message}`);
  process.exit(1);
});
