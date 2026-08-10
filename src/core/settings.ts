// Central quality dials. The perf pass (Phase 4) auto-tunes these; until then the
// defaults are the "max beauty at 30fps floor" starting guess for Intel HD 620.

export interface Quality {
  renderScale: number;        // canvas pixel ratio multiplier (dynamic-res lever)
  msaa: boolean;              // hardware AA until the post pipeline's SMAA replaces it
  shadowMapSize: number;      // sun shadow map resolution (read by sky.ts)
  shadowCascades: number;     // 1 = single camera-fitted cascade (see fitSunShadow)
  shadowDistance: number;     // cap on the fitted shadow range (m), read by sky.ts
  textureSize: number;        // baked PBR texture resolution
  grassRadius: number;        // grass draw radius (m)
  grassDensity: number;       // 0..1 multiplier on instance counts
  treeDetailRadius: number;   // full-detail tree radius, billboards beyond (m)
  drawDistance: number;       // camera far plane (m)
  anisotropy: number;
  /** Single-fetch terrain splat: halves ground texture fetches (see terrain.ts). */
  terrainCheap: boolean;
  /** Scale on the real-geometry grass band radius. Cost grows with its SQUARE. */
  vegNear: number;
}

export const quality: Quality = {
  renderScale: 1.0,
  msaa: false, // SMAA in the post pipeline replaces hardware MSAA
  // One 2048 map whose ortho box is refitted to the camera frustum each frame
  // (sky.ts fitSunShadow). It carries PROPS ONLY — landform self-shadowing is
  // baked on the CPU into the terrain control map — so the range collapses from
  // 700m to 300m and the same 2048 texels buy ~0.15 m/texel contact shadows
  // instead of ~0.9. A second cascade would cost a whole extra depth pass,
  // which the 29.5fps bare-terrain baseline cannot pay for.
  shadowMapSize: 2048,
  shadowCascades: 1,
  shadowDistance: 300,
  textureSize: 1024,
  grassRadius: 55,
  grassDensity: 1.0,
  treeDetailRadius: 120,
  drawDistance: 1600,   // far enough that fog, not the far plane, ends the sea
  // 8:1 is well short of what a 74-degree fov needs on ground past ~15m; the
  // near-field detail band was being mip-blurred into mush before it reached
  // the screen.
  anisotropy: 16,
  terrainCheap: false,
  vegNear: 1.0,
};

export type QualityLevel = 'ultra' | 'high' | 'medium' | 'low';

/**
 * PRESETS. The visual streams were built against `ultra`, which is a
 * screenshot budget, not a play budget: measured on the target GPU it renders
 * the bench flythrough at 6.3 fps. These presets are the perf pass — each one
 * names what it gives up and why, and every cut is a multiplier on the two
 * things that actually cost on this hardware, PIXELS and ALPHA-TESTED BLADES.
 *
 * `ultra` is retained unchanged so review captures stay comparable with every
 * earlier cycle; nothing but the capture harness should select it.
 */
const PRESETS: Record<QualityLevel, Partial<Quality> & { post: PostLevel }> = {
  // Screenshot budget. Everything on, native resolution, no compromises.
  ultra: {
    renderScale: 1.0, shadowMapSize: 2048, shadowDistance: 300, textureSize: 1024,
    grassDensity: 1.0, treeDetailRadius: 120, anisotropy: 16, terrainCheap: false, vegNear: 1.0, post: 'full',
  },
  // A capable laptop dGPU. Full vegetation, cheaper shadows and AA.
  high: {
    renderScale: 0.9, shadowMapSize: 1536, shadowDistance: 260, textureSize: 1024,
    grassDensity: 0.72, treeDetailRadius: 105, anisotropy: 8, terrainCheap: false, vegNear: 0.72, post: 'full',
  },
  // DEFAULT. Aimed squarely at the 30 fps floor on Intel HD 620: two thirds of
  // the pixels, a third of the blades, one cheap AA pass and no bloom.
  medium: {
    renderScale: 0.72, shadowMapSize: 1024, shadowDistance: 190, textureSize: 512,
    grassDensity: 0.30, treeDetailRadius: 80, anisotropy: 4, terrainCheap: true, vegNear: 0.42, post: 'lite',
  },
  // Anything older or hotter. Grass becomes a ground texture with a few tufts,
  // shadows go, and post is a single tone-map pass.
  low: {
    renderScale: 0.58, shadowMapSize: 512, shadowDistance: 120, textureSize: 512,
    grassDensity: 0.12, treeDetailRadius: 55, anisotropy: 2, terrainCheap: true, vegNear: 0.26, post: 'min',
  },
};

/** Which effects the post stack builds. See post/pipeline.ts. */
export type PostLevel = 'full' | 'lite' | 'min';

export let postLevel: PostLevel = 'lite';
export let qualityLevel: QualityLevel = 'medium';

export function applyQualityPreset(level: QualityLevel): void {
  const p = PRESETS[level];
  Object.assign(quality, p);
  postLevel = p.post;
  qualityLevel = level;
}

export interface BootParams {
  mode: 'game' | 'shot' | 'bench';
  shot: string | null;   // pose name
  seedOverride: number | null;
  timeOfDay: number;     // 0..24, default late-afternoon PUBG glow
}

export function parseBootParams(): BootParams {
  const q = new URLSearchParams(location.search);
  const mode: BootParams['mode'] = q.has('bench') ? 'bench' : q.has('shot') ? 'shot' : 'game';
  const tod = q.has('tod') ? parseFloat(q.get('tod')!) : 16.5;
  // Review captures run at the budget the visuals were authored against; play
  // defaults to the preset that holds the frame-rate floor.
  const asked = q.get('q') as QualityLevel | null;
  applyQualityPreset(
    asked && asked in PRESETS ? asked : mode === 'shot' ? 'ultra' : 'medium'
  );
  if (q.has('texsize')) quality.textureSize = parseInt(q.get('texsize')!, 10);
  if (q.has('scale')) quality.renderScale = parseFloat(q.get('scale')!);
  return {
    mode,
    shot: q.get('shot'),
    seedOverride: q.has('seed') ? parseInt(q.get('seed')!, 10) : null,
    timeOfDay: isNaN(tod) ? 16.5 : tod,
  };
}
