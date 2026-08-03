export const meta = {
  name: 'wow-loop',
  description: 'Generic visual wow-loop: Opus executor cycles against a 3-critic blind panel vs PUBG references',
  phases: [{ title: 'Cycle' }],
}

// args: { item, poses, refA, refB, brief, owned, forbidden, scopeNote, maxCycles }
// Harness may deliver args as a JSON string - accept both.
const A = typeof args === 'string' ? JSON.parse(args) : args
const item = A.item
const POSES = A.poses
const REF_A = A.refA
const REF_B = A.refB || A.refA
const MAX = A.maxCycles || 8

const EXEC_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    buildOk: { type: 'boolean' },
    shotsDir: { type: 'string' },
    drawCalls: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['summary', 'buildOk', 'shotsDir'],
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    wowed: { type: 'boolean' },
    blindPick: { enum: ['A', 'B'] },
    blindPubgGuess: { enum: ['A', 'B'] },
    blindReason: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { enum: ['blocker', 'major', 'minor'] },
          note: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'note', 'fix'],
      },
    },
  },
  required: ['wowed', 'blindPick', 'findings'],
}

let carried = []
let last = null

for (let cycle = 1; cycle <= MAX; cycle++) {
  log(`${item} cycle ${cycle}/${MAX} - executor building`)
  const parity = cycle % 2
  const blindDir = `review/blind/${item}-c${cycle}`
  const oursTo = parity === 0 ? 'a.png' : 'b.png'
  const refTo = parity === 0 ? 'b.png' : 'a.png'
  const refPick = cycle % 4 < 2 ? REF_A : REF_B
  const heroPose = POSES.split(',')[0]

  const findingsBlock = cycle === 1
    ? `ART DIRECTION BRIEF (cycle 1):\n${A.brief}`
    : `CRITIC FINDINGS TO FIX (from cycle ${cycle - 1} - address every blocker and major; minors if cheap):\n` +
      carried.map((f, i) => `${i + 1}. [${f.severity}] ${f.note}\n   FIX: ${f.fix}`).join('\n')

  const exec = await agent(
    `You are the ${item} visual executor for the ERANGEL-web project (read CLAUDE.md context carefully - budgets and gotchas are earned knowledge). Wow-loop cycle ${cycle} of max ${MAX} for the "${item}" item.

MISSION: make the ${item} of this fully-procedural three.js BR game read as AAA next to real PUBG. No asset downloads - everything generated in code.

${findingsBlock}

FILE OWNERSHIP - you may edit ONLY: ${A.owned}. DO NOT touch: ${A.forbidden}. Other lanes run in parallel; stay in yours.

CONSTRAINTS: draw calls <= 400 total (check the "calls:" output of capture). The bare world benches ~30fps at native 1080p on the target Intel HD 620 - every add must be cheap; prefer shader work over geometry; new meshes must be merged/instanced. GLSL reserved words (patch/sample/filter/input/output/buffer) silently kill texgen recipes - check capture output for [console.error] lines.

WORK LOOP:
1. Implement improvements (deterministic in WORLD_SEED - no Math.random in gen paths).
2. npx tsc --noEmit - must be clean.
3. npx vite build --outDir dist-${item} - must succeed (own outDir: other lanes build in parallel; NEVER build plain dist/).
4. node tools/capture.mjs --poses ${POSES} --out review/shots/${item}/cycle-${cycle} --dist dist-${item}
   Any [console.error] THREE lines = a shader broke: fix before proceeding. Read at least 2 captured PNGs yourself before returning (black/white/garbled = broken, fix first).
5. Blind pair: copy review/shots/${item}/cycle-${cycle}/${heroPose}.png to ${blindDir}/${oursTo} and ${refPick} to ${blindDir}/${refTo} (create the dir).
6. Append to the Log in management/PROGRESS.md: "- ${item} cycle ${cycle}: <one-line summary>".

Return JSON: summary, buildOk, shotsDir, drawCalls, notes.`,
    { label: `build:${item}-c${cycle} [opus-5/xhigh]`, phase: 'Cycle', model: 'opus', effort: 'xhigh', schema: EXEC_SCHEMA }
  )

  if (!exec || !exec.buildOk) {
    log(`cycle ${cycle}: executor failed - repair attempt`)
    const retry = await agent(
      `The previous ${item} executor cycle in the ERANGEL-web project (cwd) left the build broken or unfinished. Run "npx tsc --noEmit" and "npx vite build --outDir dist-${item}", fix whatever is broken (read CLAUDE.md gotchas), then run: node tools/capture.mjs --poses ${POSES} --out review/shots/${item}/cycle-${cycle} --dist dist-${item} and create the blind pair: copy review/shots/${item}/cycle-${cycle}/${heroPose}.png to ${blindDir}/${oursTo} and ${refPick} to ${blindDir}/${refTo}. Return the same JSON schema.`,
      { label: `repair:${item}-c${cycle} [opus-5/xhigh]`, phase: 'Cycle', model: 'opus', effort: 'xhigh', schema: EXEC_SCHEMA }
    )
    if (!retry || !retry.buildOk) {
      return { item, wowed: false, cycles: cycle, aborted: 'build unrecoverable', lastFindings: carried }
    }
    last = retry
  } else {
    last = exec
  }

  log(`cycle ${cycle}: 3-critic blind panel reviewing`)
  const lenses = [
    ['art-director', 'a merciless AAA art director who has shipped open-world titles. You judge composition, material response, color, atmosphere, and whether the frame would survive in a AAA marketing still lineup'],
    ['tech-artist', 'a technical artist and physically-based-rendering specialist. You judge lighting direction and softness, material believability, specular response, shadow quality, silhouette quality, texture density consistency, and artifacts (tiling, aliasing, z-fighting, popping)'],
    ['pubg-authenticity', 'a PUBG veteran with thousands of hours on Erangel. You judge whether this FEELS like PUBG: the late-afternoon glow, the rural Eastern-European identity, the muted-but-warm palette, the readability that makes fights fair'],
  ]
  const critics = await parallel(
    lenses.map(([key, persona]) => () =>
      agent(
        `You are ${persona}. Fresh eyes - you did not build this. You are reviewing the ${item.toUpperCase()} of a fully-procedural browser game that aims to stand next to PUBG: BATTLEGROUNDS.

Read these captures of the current build: Glob review/shots/${item}/cycle-${cycle}/*.png and Read every one.
Also Read the PUBG references ${REF_A} and ${REF_B} for side-by-side judgment.

BLIND TEST: Read ${blindDir}/a.png and ${blindDir}/b.png. One is a real PUBG marketing still, one is this build (filenames neutralized). blindPick = the frame you would call the better AAA game frame. blindPubgGuess = which you believe is real PUBG. blindReason: one sentence.

SCOPE: ${A.scopeNote}

VERDICT: wowed=true ONLY if, held next to the PUBG reference, this ${item} genuinely impresses you as AAA-grade work - not "good for procedural", not "good for a browser". If you hesitate, wowed=false. Findings severity-tagged; every fix CONCRETE and actionable in shader/code terms, never "make it prettier". 3-8 findings.`,
        { label: `critic:${key}-c${cycle} [opus-5/max]`, model: 'opus', effort: 'max', schema: CRITIC_SCHEMA }
      )
    )
  )

  const ok = critics.filter(Boolean)
  const wowCount = ok.filter((c) => c.wowed).length
  const oursLetter = parity === 0 ? 'A' : 'B'
  const blindWins = ok.filter((c) => c.blindPick === oursLetter).length
  carried = ok.flatMap((c) => c.findings || []).filter((f) => f.severity !== 'minor')
  log(`cycle ${cycle} verdict: ${wowCount}/${ok.length} wowed, blind wins ${blindWins}/${ok.length}, ${carried.length} major+ carried`)

  if (wowCount >= 2) {
    return { item, wowed: true, cycles: cycle, blindWins, panelSize: ok.length, finalSummary: last.summary, remainingFindings: carried }
  }
}

return { item, wowed: false, capped: true, cycles: MAX, lastFindings: carried, finalSummary: last ? last.summary : 'n/a' }
