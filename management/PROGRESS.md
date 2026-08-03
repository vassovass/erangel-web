# PROGRESS — ERANGEL-web build run (2026-08-04, overnight autonomous)

Deadline: 06:00 usage reset. Wind-down 05:15 (stop new cycles, final gauntlet,
report). Plan: `C:\Users\vasso\.claude\plans\i-want-you-to-zippy-torvalds.md`.

## World snapshot (update at every phase boundary; resume MUST verify)

- Repo: git on master, commits at milestones.
- Gate: `node tools/gate.mjs` is the truth. Last known: not yet run end-to-end.
- Capture harness: WORKING (headless ANGLE D3D11, real HD 620 verified in output).
- Bench: not yet run.

## Streams

| # | Stream | Type | Status | Cycles | Verdict |
|---|--------|------|--------|--------|---------|
| 0 | Foundation (engine, texgen, terrain, sky, harness) | build | DONE 00:45 | - | harness proven on real GPU |
| 1 | Terrain + sky + lighting | wow-loop | RUNNING (wf_1d08f99d-d36) | 1/8 | - |
| 2 | Vegetation (grass, trees) | wow-loop | base built (main loop), polish pending | 0/8 | - |
| 3 | Buildings + props | wow-loop | base built (main loop), polish pending | 0/8 | - |
| 4 | Post-processing + grading | wow-loop | pending | 0/8 | - |
| 5 | Movement + physics | gate-loop | DONE (playtest green) | - | custom physics, Rapier dropped (ruling: kinematic FPS needs exactness+low CPU, not rigid bodies) |
| 6 | Gunplay + ballistics + FX | gate-loop | DONE (playtest green) | - | - |
| 7 | Bot AI | gate-loop | DONE (playtest green; bots target player only — scope cut logged) | - | - |
| 8 | BR loop (zone, loot, win) | gate-loop | DONE (playtest green) | - | - |
| 9 | Weapon viewmodel + firing FX visual | wow-loop | base built | 0/8 | - |
| 10 | Characters/bots visual | wow-loop | base built (skinned procedural rigs) | 0/8 | - |
| 11 | HUD | wow-loop | base built (full DOM HUD) | 0/8 | - |
| 12 | Audio (WebAudio synth) | review-loop | base built (shot/steps/reload/hits/wind) | - | - |
| 13 | Performance pass | gate-loop | pending (bare-terrain bench was 29.5avg @1080p — tight) | - | - |
| 14 | Final gauntlet (blind A/B vs PUBG refs) | panel | pending | - | - |

## Log

- 00:09 git init; npm deps installed (three 0.185.1, postprocessing 6.39.4, rapier 0.19.3, puppeteer-core, vite 8.2, TS).
- 00:12 Research sweep landed (r185 facts, HD620 budgets, capture flags). Reference stills landed: 12 PUBG 1080p frames in review/reference/ + manifest (no zone-wall official still exists).
- 00:35 Foundation written: engine/renderer/input/settings, noise, TextureFactory (4-pass ORM bake, periodic GLSL noise), heightfield+roads+splat, terrain splat material, Sky+PMREM env, water, flycam, shots/bench modes, capture.mjs + gate.mjs.
- 00:4x Harness proven: typecheck+build clean; headless GPU = real HD620 via ANGLE D3D11 (--use-angle=gl crashes driver — fixed); GLSL reserved word `patch` broke grass recipe — fixed. First full-scene captures: 16 calls / 459K tris.
- 00:31 Headful bench (bare terrain, native 1080p): 29.5 avg fps, 16 calls, 459K tris. Fill-rate is the wall; renderScale is the reserve lever.
- 00:35 Terrain wow-loop workflow launched (executor + 3-critic blind panel/cycle).
- 00:51 Gameplay layer done in main loop (parallel lane): physics/controller/weapon/ballistics/FX/viewmodel/bots/zone/loot/match/HUD/audio.
- 00:58 Playtest gate written + green (11 assertions, movement/fire/reload/kill/zone/win). Fixed kill-path-independent win detection.
- 01:04 Buildings structural base (village + farms, 3 draw calls, AABB colliders, interior loot spots). Roof rotation + merge (indexed/non-indexed) bugs fixed.
- 01:15 Vegetation base: instanced billboard grass w/ wind + splat density (camera-local ring, 1 draw call), 2-species instanced trees + colliders. Grass palette greened to Erangel meadow.
- NOTE for later streams: zone-wall reference still does not exist in review/reference (no official shot); critics judge the wall on internal AAA standards.
