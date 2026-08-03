import type { MaterialRecipe } from '../gen/texgen';

// Terrain surface category recipes. Albedo is authored in sRGB; the factory
// linearizes. Height drives both the normal map and cavity AO, so give it
// real structure. PUBG Erangel palette: dry yellow-green fields, warm dirt,
// grey-brown rock, faded asphalt.
//
// TILING RULE (earned the hard way): the GLSL noise lattice takes ONE scalar
// period, so any non-uniform scale on p must have its axes in an integer ratio
// and must pass the SMALLER scale as the period. `fbm(p * vec2(9.0, 27.0),
// uPeriod * 9.0, ...)` tiles once in x and three times in y — correct.
// `fbm(p * vec2(0.8, 3.4), uPeriod * 3.4, ...)` does not tile at all and puts a
// visible seam in every repeat.

export const grassFieldRecipe: MaterialRecipe = {
  name: 'grassField',
  period: 8,
  normalStrength: 0.65,
  aoStrength: 0.8,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Macro patchiness: dry vs lush patches, domain warped so it reads organic.
  float fieldPatch = wfbm(p * 0.5, uPeriod * 0.5, 2.2, 4);
  // Blade clumping: one stretched direction (grass lies over), plus isotropic
  // fine detail. Two crossed stretched noises used to read as woven plaid.
  float clump = fbm(p * vec2(9.0, 27.0), uPeriod * 9.0, 4, 0.55);
  float weave = fbm(p * 24.0 + 7.3, uPeriod * 24.0, 3, 0.5);
  float blades = clump * 0.72 + weave * 0.28;
  // Sparse soil shows through where blades thin out.
  float soil = smoothstep(0.34, 0.20, blades);

  vec3 lush = vec3(0.220, 0.278, 0.133);
  vec3 dry = vec3(0.380, 0.372, 0.192);
  vec3 straw = vec3(0.486, 0.443, 0.243);
  vec3 grassCol = mix(lush, dry, smoothstep(0.28, 0.76, fieldPatch));
  grassCol = mix(grassCol, straw, smoothstep(0.52, 0.92, blades) * 0.5);
  vec3 soilCol = vec3(0.243, 0.192, 0.137);
  albedo = mix(grassCol, soilCol, soil * 0.85);
  // Subtle per-blade brightness variation sells density.
  albedo *= 0.86 + 0.28 * blades;

  height = blades * 0.72 + fieldPatch * 0.28;
  rough = 0.88 + 0.1 * (1.0 - blades);
  metal = 0.0;
}
`,
};

export const dirtRecipe: MaterialRecipe = {
  name: 'dirt',
  period: 8,
  normalStrength: 1.1,
  aoStrength: 1.0,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  float base = wfbm(p, uPeriod, 1.6, 5);
  // Embedded pebbles via voronoi F2-F1 ridges.
  vec3 vor = voronoi(p * 9.0, uPeriod * 9.0);
  float pebble = smoothstep(0.12, 0.3, vor.y - vor.x);
  float fine = fbm(p * 22.0, uPeriod * 22.0, 3, 0.5);
  // Dried crack lines.
  float crack = smoothstep(0.06, 0.0, abs(vnoise(p * 5.0, uPeriod * 5.0) - 0.5) - 0.02);

  vec3 dark = vec3(0.235, 0.180, 0.126);
  vec3 mid = vec3(0.376, 0.302, 0.208);
  vec3 light = vec3(0.494, 0.416, 0.302);
  albedo = mix(dark, mid, base);
  albedo = mix(albedo, light, pebble * vor.z * 0.8);
  albedo *= 1.0 - crack * 0.35;
  albedo *= 0.9 + fine * 0.2;

  height = base * 0.5 + pebble * 0.35 + fine * 0.15 - crack * 0.25;
  rough = 0.93 - pebble * 0.15;
  metal = 0.0;
}
`,
};

export const rockRecipe: MaterialRecipe = {
  name: 'rock',
  period: 6,
  normalStrength: 1.6,
  aoStrength: 1.0,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Horizontal strata + ridged fracture detail. Axes kept in a 1:4 ratio so the
  // strata still tile (see TILING RULE above).
  float strata = fbm(p * vec2(1.0, 4.0), uPeriod, 4, 0.5);
  float fracture = ridged(p * 2.4, uPeriod * 2.4, 5);
  vec3 vor = voronoi(p * 4.0, uPeriod * 4.0);
  float chip = smoothstep(0.05, 0.24, vor.x);
  float fine = fbm(p * 18.0, uPeriod * 18.0, 3, 0.5);

  // Erangel rock is a dark grey-brown schist; the old value read as snow once
  // the sun hit it.
  vec3 dark = vec3(0.216, 0.204, 0.188);
  vec3 mid = vec3(0.353, 0.333, 0.302);
  vec3 warm = vec3(0.427, 0.376, 0.298);
  albedo = mix(dark, mid, strata);
  albedo = mix(albedo, warm, smoothstep(0.5, 0.9, fracture) * 0.45);
  albedo *= 0.78 + chip * 0.26 + fine * 0.12;
  // Mossy tint in cavities.
  float moss = smoothstep(0.35, 0.1, fracture) * vnoise(p * 3.0, uPeriod * 3.0);
  albedo = mix(albedo, vec3(0.278, 0.302, 0.169), moss * 0.42);

  height = fracture * 0.55 + strata * 0.25 + chip * 0.2;
  rough = 0.82 - smoothstep(0.6, 1.0, fracture) * 0.12 + fine * 0.08;
  metal = 0.0;
}
`,
};

export const asphaltRecipe: MaterialRecipe = {
  name: 'asphalt',
  period: 8,
  normalStrength: 0.7,
  aoStrength: 0.9,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Fine aggregate speckle.
  vec3 vor = voronoi(p * 34.0, uPeriod * 34.0);
  float aggregate = smoothstep(0.02, 0.16, vor.x);
  float wear = wfbm(p * 0.8, uPeriod * 0.8, 1.8, 4);
  // Cracks: thin ridged lines, sparse.
  float crackNoise = ridged(p * 1.6, uPeriod * 1.6, 4);
  float crack = smoothstep(0.88, 0.99, crackNoise) * smoothstep(0.35, 0.6, wear);
  float fine = fbm(p * 40.0, uPeriod * 40.0, 2, 0.5);
  // Patched repairs: big soft blotches of fresher, darker surface.
  float repair = smoothstep(0.62, 0.78, wfbm(p * 1.3 + 21.0, uPeriod, 2.4, 3));

  // A country road, not a motorway: dusty grey-brown rather than fresh black.
  vec3 fresh = vec3(0.196, 0.188, 0.180);
  vec3 faded = vec3(0.353, 0.337, 0.306);
  albedo = mix(fresh, faded, smoothstep(0.25, 0.8, wear));
  albedo = mix(albedo, fresh * 1.15, repair * 0.7);
  albedo *= 0.8 + (1.0 - aggregate) * 0.35 + fine * 0.1;
  albedo *= 1.0 - crack * 0.5;

  height = 0.5 + (1.0 - aggregate) * 0.08 + fine * 0.05 - crack * 0.4 + wear * 0.05;
  rough = 0.87 + crack * 0.1 - (1.0 - aggregate) * 0.08;
  metal = 0.0;
}
`,
};

export const TERRAIN_RECIPES = [grassFieldRecipe, dirtRecipe, rockRecipe, asphaltRecipe];
