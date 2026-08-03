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
| 0 | Foundation (engine, texgen, terrain, sky, harness) | build | in progress | - | - |
| 1 | Terrain + sky + lighting | wow-loop | pending | 0/8 | - |
| 2 | Vegetation (grass, trees) | wow-loop | pending | 0/8 | - |
| 3 | Buildings + props | wow-loop | pending | 0/8 | - |
| 4 | Post-processing + grading | wow-loop | pending | 0/8 | - |
| 5 | Movement + physics (Rapier) | gate-loop | pending | - | - |
| 6 | Gunplay + ballistics + FX | gate-loop | pending | - | - |
| 7 | Bot AI | gate-loop | pending | - | - |
| 8 | BR loop (zone, loot, win) | gate-loop | pending | - | - |
| 9 | Weapon viewmodel + firing FX visual | wow-loop | pending | 0/8 | - |
| 10 | Characters/bots visual | wow-loop | pending | 0/8 | - |
| 11 | HUD | wow-loop | pending | 0/8 | - |
| 12 | Audio (WebAudio synth) | review-loop | pending | - | - |
| 13 | Performance pass | gate-loop | pending | - | - |
| 14 | Final gauntlet (blind A/B vs PUBG refs) | panel | pending | - | - |

## Log

- 00:09 git init; npm deps installed (three 0.185.1, postprocessing 6.39.4, rapier 0.19.3, puppeteer-core, vite 8.2, TS).
- 00:12 Research sweep landed (r185 facts, HD620 budgets, capture flags). Reference stills landed: 12 PUBG 1080p frames in review/reference/ + manifest (no zone-wall official still exists).
- 00:35 Foundation written: engine/renderer/input/settings, noise, TextureFactory (4-pass ORM bake, periodic GLSL noise), heightfield+roads+splat, terrain splat material, Sky+PMREM env, water, flycam, shots/bench modes, capture.mjs + gate.mjs.
- 00:4x Harness proven: typecheck+build clean; headless GPU = real HD620 via ANGLE D3D11 (--use-angle=gl crashes driver — fixed); GLSL reserved word `patch` broke grass recipe — fixed. First full-scene captures: 16 calls / 459K tris.
