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

- GLSL ES reserved words WILL silently break texgen recipes: never name variables `patch`, `sample`, `filter`, `input`, `output`, `buffer`, `flat`. Recipe shader errors surface as `[console.error]` lines in capture output — always check them.
- The texgen GLSL noise lattice takes ONE scalar period. Non-uniform scales must keep axes in an integer ratio with the SMALLER scale passed as the period, or the texture never tiles (rule documented atop src/materials/library.ts).
- Nothing driving ALBEDO may run below ~16 lattice cells per tile — low-frequency blobs baked into a texture tile in lockstep and no stochastic sampling hides them. Macro variation belongs in the surface shader at world scale.
- three applies fog AFTER tone mapping: fog color is a display-space value. Anything blending toward the haze must do it post-colorspace to match.
- Sky/water animate on a FRAME COUNTER, not wall clock, so captures are byte-reproducible. Keep it that way for anything animated that appears in review shots.
- Boot costs ~2min/pose in capture (splat/field map bake is 1M height queries). Batch all poses into ONE capture call per cycle; SPLAT_SIZE 1024→768 in terrain.ts is the approved lever if it gets worse.
- Headless capture MUST use ANGLE D3D11 (`--use-angle=d3d11` already set in capture.mjs). `--use-angle=gl` crashes this Intel driver's GPU process.
- Textures bake into render targets: albedo is an sRGB RT with HEIGHT in alpha (alpha stays linear). Author albedo in sRGB inside recipes; `srgb2lin` is applied by the wrapper.
- Terrain material is a patched MeshStandardMaterial; if you change its onBeforeCompile string, bump `customProgramCacheKey`.
- The 16-texture-unit limit is real on this GPU: terrain already uses ~11 units incl. env+shadow. Don't add per-category ORM sampling to terrain without dropping something.
- All world-gen must stay deterministic in WORLD_SEED (no Math.random in gen paths; use mulberry32/hash2).
- Keep new meshes within draw-call budget: merge static geometry per material, InstancedMesh for repeats. Check `calls:` printed by capture.

## Parallel lanes (IMPORTANT)

Multiple visual streams edit disjoint files in ONE shared working tree at the
same time. Consequences for every executor:
- If `tsc` reports errors ONLY in files outside your ownership list, another
  lane is mid-cycle: ignore those errors and proceed. Your gate is: your OWN
  files typecheck-clean and `npx vite build --outDir dist-<your-item>` succeeds.
- If `vite build` fails on another lane's file, wait ~2 minutes and retry once
  or twice — their executor is mid-edit and coherent states return quickly.
- NEVER "fix" a file you do not own, even to unblock a build.
- Do not run plain `vite build` (it clobbers other lanes' preview); always use
  your own --outDir.

## Gotchas earned in the finish pass (2026-08-04)

- **Anything that must lie ON the ground uses `terrainSurfaceY()` (gen/terraingen.ts), never `hf.height()`.** The mesh draws flat triangles on a 2.34m lattice; across a hollow that triangle sits centimetres ABOVE the analytic curve, so a decal planted on `hf.height` is buried and only fragments surface — hard-edged dark shards.
- **A flat, up-facing card is intrinsically ~3x darker than the blades beside it** at this sun elevation, before any albedo choice. If it is also denied transmission and sheen and given the sward-interior ambient case, it renders as charcoal no matter how pale you make the colour. Light ground-lying geometry AS GROUND.
- **Module-level `const X = base * quality.dial` silently captures the default** — consts initialise before `parseBootParams()` applies the preset. Read quality dials inside a function or a constructor, never at module scope.
- **Never assign `ballistics.onTargetHit` after `new Match(...)`.** Match WRAPS the existing handler to install the damage router; a second bare assignment throws the router away and nothing in the game takes damage. Wrap, don't assign.
- **A gameplay test that asserts on side effects proves nothing about the mechanic.** The original playtest checked that firing consumed ammo and that a scripted `damageBot()` killed — both passed for six hours while no bullet ever damaged anyone. `tools/combat-test.mjs` fires real rounds and asserts health actually moves.
- **Fire SHORT BURSTS when testing hits.** A continuous 2.5s burst walks the muzzle several degrees up the recoil pattern and every later round misses high — correct weapon behaviour, useless as a hit test.
- **Late-session benchmarks on this laptop are not comparable.** The same build measured 13.3 and 6.6 fps ninety minutes apart under sustained load. Kill stray `vite preview`/Chrome processes and let it settle before trusting a number.
- Profile, don't guess: `node tools/profile.mjs` ablates each system and prints ms/frame.

## Review loop (visual items)

Executor builds → `vite build` → capture poses → 3-critic panel reads PNGs vs
`review/reference/` (blind A/B) → verdict files in `review/verdicts/` → fix →
repeat until panel majority WOWED or 8 cycles (then mark CAPPED in PROGRESS.md).
Critics are fresh-context and harsh; findings must be concrete and actionable.
