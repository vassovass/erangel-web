import type { MaterialRecipe } from '../gen/texgen';

// Weapon surface recipes — separate file from materials/library.ts on purpose:
// the terrain stream owns that file; the weapon stream owns this one.

export const gunMetalRecipe: MaterialRecipe = {
  name: 'gunMetal',
  period: 6,
  normalStrength: 0.5,
  aoStrength: 0.7,
  size: 512,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  float grain = fbm(p * 26.0, uPeriod * 26.0, 3, 0.5);
  float wearMask = wfbm(p * 1.4, uPeriod * 1.4, 1.6, 4);
  // Edge wear brightens: bare steel through the parkerized finish.
  float wear = smoothstep(0.62, 0.85, wearMask);
  float scratch = smoothstep(0.9, 0.99, ridged(vec2(p.x * 9.0, p.y * 1.6), uPeriod * 9.0, 3));

  vec3 finish = vec3(0.075, 0.078, 0.082);
  vec3 steel = vec3(0.35, 0.36, 0.38);
  albedo = mix(finish, steel, wear * 0.55 + scratch * 0.5);
  albedo *= 0.9 + grain * 0.2;

  height = 0.5 + grain * 0.06 - scratch * 0.2;
  rough = 0.52 - wear * 0.18 + grain * 0.12;
  metal = 0.85 + wear * 0.1;
}
`,
};

export const gunWoodRecipe: MaterialRecipe = {
  name: 'gunWood',
  period: 4,
  normalStrength: 0.6,
  aoStrength: 0.7,
  size: 512,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Long-grain laminate: stretched fbm rings with warm lacquer.
  float ring = fbm(vec2(p.x * 1.5, p.y * 14.0), uPeriod * 14.0, 4, 0.55);
  float streak = fbm(vec2(p.x * 2.0, p.y * 40.0), uPeriod * 40.0, 3, 0.5);
  float scuff = smoothstep(0.75, 0.95, wfbm(p * 2.2, uPeriod * 2.2, 1.4, 3));

  vec3 dark = vec3(0.30, 0.145, 0.06);
  vec3 mid = vec3(0.45, 0.23, 0.10);
  vec3 light = vec3(0.55, 0.32, 0.15);
  albedo = mix(dark, mid, ring);
  albedo = mix(albedo, light, streak * 0.35);
  albedo = mix(albedo, albedo * 1.35, scuff * 0.4);

  height = 0.5 + ring * 0.08 + streak * 0.04;
  rough = 0.32 + scuff * 0.3 + streak * 0.08;
  metal = 0.0;
}
`,
};
