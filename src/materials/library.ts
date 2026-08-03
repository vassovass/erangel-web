import type { MaterialRecipe } from '../gen/texgen';

// Terrain surface category recipes. Albedo is authored in sRGB; the factory
// linearizes. Height drives both the normal map and cavity AO, so give it
// real structure. PUBG Erangel palette: dry yellow-green fields, warm dirt,
// grey-brown rock, faded asphalt.
//
// TWO RULES, both learned from a capture that looked like a knitted jumper:
//
// 1. TILING RULE. The GLSL noise lattice takes ONE scalar period, so any
//    non-uniform scale on p must have its axes in an integer ratio and must
//    pass the SMALLER scale as the period. `fbm(p * vec2(8.0, 24.0),
//    uPeriod * 8.0, ...)` tiles once in x and three times in y — correct.
//    `fbm(p * vec2(0.8, 3.4), uPeriod * 3.4, ...)` does not tile at all.
//
// 2. FREQUENCY RULE. Nothing that drives ALBEDO may run below ~16 lattice
//    cells per tile. A 3m texture carrying 1m blobs shows those blobs marching
//    across the field in lockstep, and no amount of stochastic sampling hides
//    it. All large-scale variation — patchiness, hue drift, crop parcels —
//    is generated in the terrain shader at world scale instead. Height may
//    carry a little more low frequency; it only shows in the normal map.

export const grassFieldRecipe: MaterialRecipe = {
  name: 'grassField',
  period: 8,
  normalStrength: 0.75,
  aoStrength: 0.8,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Blade speckle, clumping, and a slight directional lay (grass lies over) —
  // all fine enough that a tile averages to a flat value at 40m.
  float fine = fbm(p * 46.0, uPeriod * 46.0, 4, 0.5);
  float mid = fbm(p * 17.0, uPeriod * 17.0, 3, 0.5);
  float lean = fbm(p * vec2(8.0, 24.0), uPeriod * 8.0, 2, 0.5);
  float blades = fine * 0.50 + mid * 0.32 + lean * 0.18;
  // Sparse soil shows through where blades thin out.
  float soil = smoothstep(0.36, 0.22, blades);

  vec3 lush = vec3(0.216, 0.271, 0.129);
  vec3 dry = vec3(0.400, 0.384, 0.196);
  vec3 straw = vec3(0.510, 0.462, 0.255);
  vec3 grassCol = mix(lush, dry, smoothstep(0.32, 0.68, mid));
  grassCol = mix(grassCol, straw, smoothstep(0.54, 0.88, blades) * 0.5);
  vec3 soilCol = vec3(0.243, 0.192, 0.137);
  albedo = mix(grassCol, soilCol, soil * 0.7);
  albedo *= 0.88 + 0.24 * fine;

  height = blades;
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
  float grain = fbm(p * 30.0, uPeriod * 30.0, 4, 0.5);
  float clod = fbm(p * 13.0, uPeriod * 13.0, 3, 0.5);
  // Embedded pebbles via voronoi F2-F1 ridges.
  vec3 vor = voronoi(p * 16.0, uPeriod * 16.0);
  float pebble = smoothstep(0.10, 0.28, vor.y - vor.x);
  // Dried crack lines, tight enough not to read as crazy paving.
  float crack = smoothstep(0.05, 0.0, abs(vnoise(p * 11.0, uPeriod * 11.0) - 0.5) - 0.02);

  vec3 dark = vec3(0.235, 0.180, 0.126);
  vec3 mid = vec3(0.376, 0.302, 0.208);
  vec3 light = vec3(0.478, 0.404, 0.294);
  albedo = mix(dark, mid, clod);
  albedo = mix(albedo, light, pebble * vor.z * 0.55);
  albedo *= 1.0 - crack * 0.22;
  albedo *= 0.9 + grain * 0.2;

  height = clod * 0.42 + pebble * 0.34 + grain * 0.24 - crack * 0.25;
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
  float strata = fbm(p * vec2(4.0, 16.0), uPeriod * 4.0, 4, 0.5);
  float fracture = ridged(p * 7.0, uPeriod * 7.0, 5);
  vec3 vor = voronoi(p * 11.0, uPeriod * 11.0);
  float chip = smoothstep(0.05, 0.24, vor.x);
  float fine = fbm(p * 26.0, uPeriod * 26.0, 3, 0.5);

  // Erangel rock is dark grey-brown schist. The first pass read as a snowcap
  // under a low sun — these values are deliberately well under half grey.
  vec3 dark = vec3(0.129, 0.125, 0.118);
  vec3 mid = vec3(0.235, 0.224, 0.204);
  vec3 warm = vec3(0.294, 0.255, 0.200);
  albedo = mix(dark, mid, strata);
  albedo = mix(albedo, warm, smoothstep(0.5, 0.9, fracture) * 0.45);
  albedo *= 0.82 + chip * 0.20 + fine * 0.10;
  // Lichen and moss in the cavities: rock is never one flat grey.
  float moss = smoothstep(0.35, 0.1, fracture) * vnoise(p * 9.0, uPeriod * 9.0);
  albedo = mix(albedo, vec3(0.212, 0.235, 0.141), moss * 0.5);

  height = fracture * 0.55 + strata * 0.25 + chip * 0.2;
  rough = 0.84 - smoothstep(0.6, 1.0, fracture) * 0.10 + fine * 0.08;
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
  vec3 vor = voronoi(p * 40.0, uPeriod * 40.0);
  float aggregate = smoothstep(0.02, 0.16, vor.x);
  float wear = fbm(p * 18.0, uPeriod * 18.0, 3, 0.5);
  // Cracks: thin ridged lines, sparse.
  float crackNoise = ridged(p * 9.0, uPeriod * 9.0, 4);
  float crack = smoothstep(0.86, 0.99, crackNoise) * smoothstep(0.35, 0.62, wear);
  float fine = fbm(p * 60.0, uPeriod * 60.0, 2, 0.5);

  // A country road, not a motorway: dusty grey-brown, warmed off neutral so it
  // does not read as blue against the fields.
  vec3 fresh = vec3(0.204, 0.192, 0.176);
  vec3 faded = vec3(0.376, 0.353, 0.310);
  albedo = mix(fresh, faded, smoothstep(0.28, 0.74, wear));
  albedo *= 0.84 + (1.0 - aggregate) * 0.28 + fine * 0.1;
  albedo *= 1.0 - crack * 0.45;

  height = 0.5 + (1.0 - aggregate) * 0.08 + fine * 0.05 - crack * 0.4 + wear * 0.05;
  rough = 0.87 + crack * 0.1 - (1.0 - aggregate) * 0.08;
  metal = 0.0;
}
`,
};

export const TERRAIN_RECIPES = [grassFieldRecipe, dirtRecipe, rockRecipe, asphaltRecipe];
