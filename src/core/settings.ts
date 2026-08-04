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
};

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
  if (q.has('texsize')) quality.textureSize = parseInt(q.get('texsize')!, 10);
  if (q.has('scale')) quality.renderScale = parseFloat(q.get('scale')!);
  return {
    mode,
    shot: q.get('shot'),
    seedOverride: q.has('seed') ? parseInt(q.get('seed')!, 10) : null,
    timeOfDay: isNaN(tod) ? 16.5 : tod,
  };
}
