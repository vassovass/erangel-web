# ERANGEL-web — PUBG-class FPS in Three.js (fully procedural)

BR-lite FPS: procedural Erangel-style 1200m island, bots, shrinking zone, loot.
**Hard rules: zero asset downloads (all textures/models/audio generated in code);
npm code deps allowed. Target: Intel HD 620 — avg >=30fps, 1% low >=24, <=400
draw calls at 1080p. three r185 / WebGL2 / TypeScript / Vite.**

## Commands

- `npx tsc --noEmit` — typecheck
- `npx vite build` — build (needed before capture; capture serves dist/)
- `node tools/capture.mjs --poses <a,b,c> --out review/shots/<item>/cycle-<n>` — screenshots on the real GPU (headless, ANGLE D3D11)
- `node tools/capture.mjs --bench --out review/bench/latest.json` — 30s benchmark (always headful; headless fps lies)
- `node tools/gate.mjs` — full mechanical gate (typecheck + build + bench + budgets). `--skip-bench` for quick iteration.

## Architecture map

- `src/gen/` — all procedural generation: `noise.ts` (CPU, seeded from WORLD_SEED), `texgen.ts` (GPU TextureFactory: recipes bake albedo+height/normal/ORM sets; PERIODIC noise GLSL lib so textures tile), `terraingen.ts` (Heightfield: height/splat/roads/walkable)
- `src/materials/library.ts` — material recipes (one per surface category). ORM packing: r=AO, g=rough, b=metal; one texture assigned as aoMap+roughnessMap+metalnessMap.
- `src/world/` — terrain (splat via onBeforeCompile), sky (Sky addon + PMREM env bake), water
- `src/core/` — engine (fixed 60Hz step), renderer (ACES, PCFShadowMap — PCFSoft is deprecated in r183+), settings (quality dials — respect them), input
- `src/debug/shots.ts` — named camera POSES (add poses for new content there), `bench.ts` — scripted benchmark
- `review/reference/` — official PUBG stills for blind A/B comparison (see MANIFEST.md)
- `management/PROGRESS.md` — stream/cycle/verdict state. Update it when you finish a cycle.

## Gotchas (earned knowledge — do not rediscover)

- GLSL ES reserved words WILL silently break texgen recipes: never name variables `patch`, `sample`, `filter`, `input`, `output`, `buffer`. Recipe shader errors surface as `[console.error]` lines in capture output — always check them.
- Headless capture MUST use ANGLE D3D11 (`--use-angle=d3d11` already set in capture.mjs). `--use-angle=gl` crashes this Intel driver's GPU process.
- Textures bake into render targets: albedo is an sRGB RT with HEIGHT in alpha (alpha stays linear). Author albedo in sRGB inside recipes; `srgb2lin` is applied by the wrapper.
- Terrain material is a patched MeshStandardMaterial; if you change its onBeforeCompile string, bump `customProgramCacheKey`.
- The 16-texture-unit limit is real on this GPU: terrain already uses ~11 units incl. env+shadow. Don't add per-category ORM sampling to terrain without dropping something.
- All world-gen must stay deterministic in WORLD_SEED (no Math.random in gen paths; use mulberry32/hash2).
- Keep new meshes within draw-call budget: merge static geometry per material, InstancedMesh for repeats. Check `calls:` printed by capture.

## Review loop (visual items)

Executor builds → `vite build` → capture poses → 3-critic panel reads PNGs vs
`review/reference/` (blind A/B) → verdict files in `review/verdicts/` → fix →
repeat until panel majority WOWED or 8 cycles (then mark CAPPED in PROGRESS.md).
Critics are fresh-context and harsh; findings must be concrete and actionable.
