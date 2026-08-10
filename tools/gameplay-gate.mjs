// One command that says whether the game still works after a gameplay change.
//
//   node tools/gameplay-gate.mjs
//
// Builds, serves that build on a private port, and runs every behavioural test
// against it in sequence. Each test drives the REAL game in a real browser on
// the real GPU — none of them assert on internals alone, because the bug that
// survived six hours (nothing took damage) passed every internal assertion we
// had while being obvious in two seconds of play.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 4599;
const OUT_DIR = 'dist-gate';

const run = (label, cmd, args) => {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(cmd, args, { cwd: ROOT, shell: true, stdio: 'inherit', timeout: 900000 });
  return r.status === 0;
};

if (!run('typecheck', 'npx', ['tsc', '--noEmit'])) process.exit(1);
if (!run('build', 'npx', ['vite', 'build', '--outDir', OUT_DIR])) process.exit(1);

console.log(`\n=== serving ${OUT_DIR} on :${PORT} ===`);
const server = spawn('npx', ['vite', 'preview', '--outDir', OUT_DIR, '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((r) => setTimeout(r, 6000));

const url = `http://localhost:${PORT}`;
const suites = [
  ['BR loop', 'tools/playtest.mjs'],
  ['combat + loot + solidity', 'tools/combat-test.mjs'],
  ['bot AI', 'tools/ai-test.mjs'],
];

let failed = [];
try {
  for (const [label, script] of suites) {
    if (!existsSync(resolve(ROOT, script))) {
      console.log(`\n--- ${label}: SKIPPED (${script} not present) ---`);
      continue;
    }
    if (!run(label, 'node', [script, '--url', url])) failed.push(label);
  }
} finally {
  server.kill('SIGTERM');
}

console.log('');
if (failed.length) {
  console.log(`GAMEPLAY GATE FAIL — ${failed.join(', ')}`);
  process.exit(1);
}
console.log('GAMEPLAY GATE PASS');
