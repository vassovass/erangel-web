// The mechanical gate. Exit 0 only if ALL of:
//   1. tsc --noEmit clean
//   2. vite build succeeds
//   3. headful bench on the real GPU: avg >= 30fps, 1% low >= 24, calls <= 400
// Usage: node tools/gate.mjs [--skip-bench]

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const skipBench = process.argv.includes('--skip-bench');

const BUDGET = { avgFps: 30, p1Low: 24, drawCalls: 400 };

function run(label, cmd, cmdArgs) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, shell: true, stdio: 'inherit', timeout: 300000 });
  if (r.status !== 0) {
    console.error(`GATE FAIL: ${label} (exit ${r.status})`);
    process.exit(1);
  }
}

run('typecheck', 'npx', ['tsc', '--noEmit']);
run('build', 'npx', ['vite', 'build']);

if (!skipBench) {
  run('bench', 'node', ['tools/capture.mjs', '--bench', '--out', 'review/bench/latest.json']);
  const bench = JSON.parse(readFileSync(resolve(ROOT, 'review/bench/latest.json'), 'utf8'));
  console.log('\n=== budget check ===');
  const checks = [
    ['avgFps', bench.avgFps, '>=', BUDGET.avgFps],
    ['p1Low', bench.p1Low, '>=', BUDGET.p1Low],
    ['drawCalls', bench.drawCalls, '<=', BUDGET.drawCalls],
  ];
  let ok = true;
  for (const [name, actual, op, limit] of checks) {
    const pass = op === '>=' ? actual >= limit : actual <= limit;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${actual} (${op} ${limit})`);
    if (!pass) ok = false;
  }
  if (/swiftshader|software/i.test(bench.gpu || '')) {
    console.log(`FAIL  gpu: ${bench.gpu}`);
    ok = false;
  }
  if (!ok) {
    console.error('\nGATE FAIL: performance budget');
    process.exit(1);
  }
}

console.log('\nGATE PASS');
