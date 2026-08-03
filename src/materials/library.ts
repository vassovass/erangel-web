import type { MaterialRecipe } from '../gen/texgen';

// Terrain surface category recipes. Albedo is authored in sRGB; the factory
// linearizes. Height drives both the normal map and cavity AO, so give it
// real structure. PUBG Erangel palette: dry yellow-green fields, warm dirt,
// grey-brown rock, faded asphalt.

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
  // Blade clumping: stretched fine noise, two directions crossed.
  float clumpA = fbm(p * vec2(14.0, 46.0), uPeriod * 14.0, 4, 0.55);
  float clumpB = fbm(p.yx * vec2(15.0, 42.0) + 7.3, uPeriod * 15.0, 4, 0.55);
  float blades = max(clumpA, clumpB * 0.9);
  // Sparse soil shows through where blades thin out.
  float soil = smoothstep(0.32, 0.18, blades);

  vec3 lush = vec3(0.286, 0.351, 0.145);
  vec3 dry = vec3(0.462, 0.443, 0.208);
  vec3 straw = vec3(0.557, 0.502, 0.271);
  vec3 grassCol = mix(lush, dry, smoothstep(0.3, 0.75, fieldPatch));
  grassCol = mix(grassCol, straw, smoothstep(0.55, 0.95, blades) * 0.45);
  vec3 soilCol = vec3(0.271, 0.216, 0.153);
  albedo = mix(grassCol, soilCol, soil);
  // Subtle per-blade brightness variation sells density.
  albedo *= 0.82 + 0.36 * blades;

  height = blades * 0.7 + fieldPatch * 0.3;
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

  vec3 dark = vec3(0.243, 0.188, 0.133);
  vec3 mid = vec3(0.373, 0.302, 0.216);
  vec3 light = vec3(0.475, 0.404, 0.302);
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
  // Horizontal strata + ridged fracture detail.
  float strata = fbm(vec2(p.x * 0.8, p.y * 3.4), uPeriod * 3.4, 4, 0.5);
  float fracture = ridged(p * 2.4, uPeriod * 2.4, 5);
  vec3 vor = voronoi(p * 4.0, uPeriod * 4.0);
  float chip = smoothstep(0.05, 0.24, vor.x);
  float fine = fbm(p * 18.0, uPeriod * 18.0, 3, 0.5);

  vec3 dark = vec3(0.278, 0.263, 0.243);
  vec3 mid = vec3(0.427, 0.404, 0.369);
  vec3 warm = vec3(0.49, 0.437, 0.353);
  albedo = mix(dark, mid, strata);
  albedo = mix(albedo, warm, smoothstep(0.5, 0.9, fracture) * 0.4);
  albedo *= 0.75 + chip * 0.3 + fine * 0.12;
  // Mossy tint in cavities.
  float moss = smoothstep(0.35, 0.1, fracture) * vnoise(p * 3.0, uPeriod * 3.0);
  albedo = mix(albedo, vec3(0.31, 0.33, 0.18), moss * 0.35);

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

  vec3 fresh = vec3(0.161, 0.161, 0.169);
  vec3 faded = vec3(0.318, 0.31, 0.302);
  albedo = mix(fresh, faded, smoothstep(0.25, 0.8, wear));
  albedo *= 0.8 + (1.0 - aggregate) * 0.35 + fine * 0.1;
  albedo *= 1.0 - crack * 0.5;

  height = 0.5 + (1.0 - aggregate) * 0.08 + fine * 0.05 - crack * 0.4 + wear * 0.05;
  rough = 0.87 + crack * 0.1 - (1.0 - aggregate) * 0.08;
  metal = 0.0;
}
`,
};

export const TERRAIN_RECIPES = [grassFieldRecipe, dirtRecipe, rockRecipe, asphaltRecipe];
