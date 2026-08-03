import type { MaterialRecipe } from '../gen/texgen';

// Building surface recipes — owned by the buildings stream (3), separate from
// the terrain stream's library.ts. Erangel rural kit: weathered plaster,
// rusted sheet-metal roofs, sun-bleached plank wood.

export const plasterRecipe: MaterialRecipe = {
  name: 'plaster',
  period: 6,
  normalStrength: 0.8,
  aoStrength: 0.9,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  float base = fbm(p * 5.0, uPeriod * 5.0, 4, 0.5);
  float blotch = wfbm(p * 0.9, uPeriod * 0.9, 1.8, 4);
  // Cracked, fallen-off patches expose brick-toned scratch coat (sparse).
  float damage = smoothstep(0.76, 0.86, wfbm(p * 2.6 + 7.7, uPeriod * 2.6, 1.6, 4));
  float crack = smoothstep(0.90, 0.99, ridged(p * 2.2, uPeriod * 2.2, 4));
  // Rain streaking down walls.
  float streak = fbm(vec2(p.x * 14.0, p.y * 1.0), uPeriod * 14.0, 3, 0.5) * smoothstep(0.3, 0.9, uv.y);

  vec3 clean = vec3(0.78, 0.74, 0.66);
  vec3 dirty = vec3(0.58, 0.54, 0.46);
  vec3 scratch = vec3(0.45, 0.32, 0.24);
  albedo = mix(clean, dirty, smoothstep(0.2, 0.8, blotch) * 0.8);
  albedo *= 0.92 + base * 0.16;
  albedo = mix(albedo, scratch, damage);
  albedo *= 1.0 - streak * 0.18;
  albedo *= 1.0 - crack * 0.4;

  height = 0.6 + base * 0.1 - damage * 0.35 - crack * 0.3;
  rough = 0.9 - damage * 0.1;
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

  vec3 paint = vec3(0.42, 0.24, 0.18);      // faded oxide-red paint
  vec3 rustCol = vec3(0.44, 0.26, 0.12);
  vec3 deepRustCol = vec3(0.28, 0.15, 0.08);
  albedo = mix(paint, rustCol, rust);
  albedo = mix(albedo, deepRustCol, deepRust * (0.5 + speck * 0.5));
  albedo *= 0.85 + corr * 0.2 + speck * 0.1;
  albedo *= 1.0 - seam * 0.35;

  height = 0.5 + corr * 0.22 - seam * 0.25 - deepRust * 0.1;
  rough = 0.55 + rust * 0.35 + speck * 0.05;
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
