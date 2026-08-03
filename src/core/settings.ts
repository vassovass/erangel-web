// Central quality dials. The perf pass (Phase 4) auto-tunes these; until then the
// defaults are the "max beauty at 30fps floor" starting guess for Intel HD 620.

export interface Quality {
  renderScale: number;        // canvas pixel ratio multiplier (dynamic-res lever)
  msaa: boolean;              // hardware AA until the post pipeline's SMAA replaces it
  shadowMapSize: number;      // per-cascade shadow map resolution
  shadowCascades: number;     // CSM cascade count (2 on integrated)
  shadowDistance: number;     // how far shadows reach (m)
  textureSize: number;        // baked PBR texture resolution
  grassRadius: number;        // grass draw radius (m)
  grassDensity: number;       // 0..1 multiplier on instance counts
  treeDetailRadius: number;   // full-detail tree radius, billboards beyond (m)
  drawDistance: number;       // camera far plane (m)
  anisotropy: number;
}

export const quality: Quality = {
  renderScale: 1.0,
  msaa: true,
  shadowMapSize: 1024,
  shadowCascades: 2,
  shadowDistance: 140,
  textureSize: 1024,
  grassRadius: 55,
  grassDensity: 1.0,
  treeDetailRadius: 120,
  drawDistance: 1400,
  anisotropy: 8,
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
