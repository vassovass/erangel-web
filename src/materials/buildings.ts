import type { MaterialRecipe } from '../gen/texgen';

// Building surface recipes — owned by the buildings stream (3), separate from
// the terrain stream's library.ts. Erangel rural kit: weathered plaster,
// rusted sheet-metal roofs, sun-bleached plank wood, fired brick, straw.
//
// Scale discipline: these textures are read at 1-4 m. Anything with a feature
// larger than ~1 m belongs in per-building vertex colour (world/buildings.ts
// tints each building and darkens the band under the eaves), NOT in the tile —
// macro-scale noise inside a 2.6 m tile is what made the walls read blotchy.

export const plasterRecipe: MaterialRecipe = {
  name: 'plaster',
  period: 6,
  normalStrength: 0.55,
  aoStrength: 0.85,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;

  // Stucco tooth: two high-frequency layers at low amplitude. This is the only
  // grain that should survive at wall scale.
  float grain = fbm(p * 17.0, uPeriod * 17.0, 3, 0.5);
  float micro = fbm(p * 41.0, uPeriod * 41.0, 2, 0.5);
  // Faint trowel mottling — kept low-contrast on purpose.
  float mottle = wfbm(p * 3.4, uPeriod * 3.4, 0.7, 3);

  // Rain streaking: high frequency across the wall, very low frequency down it,
  // which reads as long vertical smears. Two scales so the streaks vary in width.
  float streakA = fbm(vec2(p.x * 21.0, p.y * 0.40), uPeriod * 21.0, 3, 0.6);
  float streakB = fbm(vec2(p.x * 53.0, p.y * 0.85), uPeriod * 53.0, 2, 0.5);
  float streak = smoothstep(0.55, 0.82, streakA) + smoothstep(0.66, 0.90, streakB) * 0.6;

  // Render fallen away in patches, exposing the brick-toned scratch coat.
  float dmgN = wfbm(p * 3.8 + 7.7, uPeriod * 3.8, 1.1, 4);
  float dmg = smoothstep(0.805, 0.895, dmgN);
  float dmgLip = smoothstep(0.775, 0.815, dmgN) * (1.0 - dmg);
  float crack = smoothstep(0.945, 1.0, ridged(p * 3.6, uPeriod * 3.6, 4));

  vec3 clean = vec3(0.83, 0.81, 0.75);
  vec3 soiled = vec3(0.67, 0.64, 0.56);
  vec3 scratch = vec3(0.48, 0.36, 0.28);

  albedo = mix(clean, soiled, smoothstep(0.28, 0.72, mottle) * 0.5);
  albedo *= 0.94 + grain * 0.10 + micro * 0.045;
  albedo *= 1.0 - clamp(streak, 0.0, 1.0) * 0.13;
  albedo = mix(albedo, scratch, dmg);
  albedo *= 1.0 - dmgLip * 0.16;
  albedo *= 1.0 - crack * 0.42;

  height = 0.64 + grain * 0.07 + micro * 0.025 - dmg * 0.36 - crack * 0.30;
  rough = 0.88 - dmg * 0.05 + clamp(streak, 0.0, 1.0) * 0.03;
  metal = 0.0;
}
`,
};

export const roofMetalRecipe: MaterialRecipe = {
  name: 'roofMetal',
  period: 8,
  normalStrength: 1.2,
  aoStrength: 0.8,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Corrugation ridges along one axis.
  float corr = sin(uv.x * uPeriod * 6.2831 * 6.0) * 0.5 + 0.5;
  // Panel seams every ~1 period.
  float seam = smoothstep(0.04, 0.0, abs(fract(uv.y * uPeriod) - 0.5) - 0.46);
  float rustMask = wfbm(p * 1.1, uPeriod * 1.1, 2.0, 4);
  float rust = smoothstep(0.45, 0.75, rustMask);
  float deepRust = smoothstep(0.65, 0.88, rustMask);
  float speck = fbm(p * 20.0, uPeriod * 20.0, 3, 0.5);
  // Streaks of rust bleeding down the corrugations.
  float bleed = smoothstep(0.58, 0.86, fbm(vec2(p.x * 24.0, p.y * 0.5), uPeriod * 24.0, 2, 0.55));

  vec3 paint = vec3(0.42, 0.24, 0.18);      // faded oxide-red paint
  vec3 rustCol = vec3(0.44, 0.26, 0.12);
  vec3 deepRustCol = vec3(0.28, 0.15, 0.08);
  albedo = mix(paint, rustCol, rust);
  albedo = mix(albedo, deepRustCol, deepRust * (0.5 + speck * 0.5));
  albedo = mix(albedo, rustCol * 0.8, bleed * 0.35);
  albedo *= 0.85 + corr * 0.2 + speck * 0.1;
  albedo *= 1.0 - seam * 0.35;

  height = 0.5 + corr * 0.22 - seam * 0.25 - deepRust * 0.1;
  rough = 0.55 + rust * 0.35 + speck * 0.05 + bleed * 0.05;
  metal = 0.75 - rust * 0.55;
}
`,
};

export const woodPlankRecipe: MaterialRecipe = {
  name: 'woodPlank',
  period: 6,
  normalStrength: 0.9,
  aoStrength: 0.9,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Vertical planks: 4 per period.
  vec4 plank = brickGrid(uv.yx, vec2(uPeriod * 0.5, uPeriod * 4.0), 1.0, 0.05);
  float grain = fbm(vec2(p.x * 2.0 + plank.y * 13.0, p.y * 22.0), uPeriod * 22.0, 4, 0.55);
  float knot = smoothstep(0.12, 0.02, voronoi(p * vec2(2.0, 4.0) + plank.y * 9.0, uPeriod * 4.0).x);
  float weather = wfbm(p * 1.2, uPeriod * 1.2, 1.6, 3);

  vec3 fresh = vec3(0.48, 0.36, 0.24);
  vec3 grey = vec3(0.42, 0.40, 0.36);     // sun-bleached
  vec3 dark = vec3(0.26, 0.20, 0.14);
  albedo = mix(fresh, grey, smoothstep(0.3, 0.75, weather));
  albedo = mix(albedo, dark, (1.0 - plank.x) * 0.5 + knot * 0.5);
  albedo *= 0.85 + grain * 0.25 + plank.y * 0.1;

  height = plank.x * 0.5 + grain * 0.12 - knot * 0.2;
  rough = 0.82 + weather * 0.1 - grain * 0.06;
  metal = 0.0;
}
`,
};

/** Fired brick — chimneys, yard walls, the village well. */
export const brickRecipe: MaterialRecipe = {
  name: 'brick',
  period: 4,
  normalStrength: 1.15,
  aoStrength: 1.0,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // ~0.45 m x 0.22 m courses with a half-brick stagger.
  vec4 course = brickGrid(uv, vec2(uPeriod * 2.2, uPeriod * 4.6), 2.0, 0.055);
  float body = course.x;          // 1 inside a brick, 0 in the mortar joint
  float id = course.y;            // per-brick random

  float grit = fbm(p * 27.0, uPeriod * 27.0, 3, 0.5);
  float soot = wfbm(p * 1.9, uPeriod * 1.9, 1.3, 3);
  float chip = smoothstep(0.74, 0.90, fbm(p * 9.5 + id * 21.0, uPeriod * 9.5, 3, 0.5));

  vec3 red = vec3(0.47, 0.25, 0.18);
  vec3 pale = vec3(0.57, 0.38, 0.28);
  vec3 burnt = vec3(0.29, 0.16, 0.13);
  vec3 face = mix(red, pale, id);
  face = mix(face, burnt, step(0.87, id));
  face *= 0.86 + grit * 0.24;
  face *= 1.0 - chip * 0.20;

  vec3 mortar = vec3(0.63, 0.61, 0.56) * (0.80 + grit * 0.32);
  albedo = mix(mortar, face, body);
  albedo = mix(albedo, albedo * 0.62, smoothstep(0.56, 0.88, soot));

  height = body * 0.55 + grit * 0.07 - chip * 0.14;
  rough = 0.90 - body * 0.06;
  metal = 0.0;
}
`,
};

/** Baled/piled straw — haystacks and barn bales. */
export const strawRecipe: MaterialRecipe = {
  name: 'straw',
  period: 4,
  normalStrength: 1.0,
  aoStrength: 1.0,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Strands run around the stack, so the noise is heavily anisotropic.
  float strand = fbm(vec2(p.x * 2.2, p.y * 44.0), uPeriod * 44.0, 3, 0.55);
  float fine = fbm(vec2(p.x * 3.4 + 11.0, p.y * 88.0), uPeriod * 88.0, 2, 0.5);
  float clump = wfbm(p * 4.2, uPeriod * 4.2, 1.1, 3);
  float wet = smoothstep(0.56, 0.86, wfbm(p * 1.7 + 3.3, uPeriod * 1.7, 1.0, 3));

  vec3 gold = vec3(0.72, 0.58, 0.27);
  vec3 bleach = vec3(0.84, 0.74, 0.45);
  vec3 dun = vec3(0.42, 0.34, 0.18);
  albedo = mix(gold, bleach, strand);
  albedo = mix(albedo, dun, wet * 0.65 + (1.0 - clump) * 0.22);
  albedo *= 0.84 + fine * 0.30;

  height = strand * 0.55 + fine * 0.25 + clump * 0.16;
  rough = 0.95 - strand * 0.05;
  metal = 0.0;
}
`,
};
