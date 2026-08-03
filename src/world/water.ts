import * as THREE from 'three';
import { parseBootParams } from '../core/settings';
import { hazeSrgbFor, sunDirectionFor } from './sky';

// Sea plane around the island. Two triangles and one patched
// MeshStandardMaterial: the PBR path already gives it the sky environment and a
// correct grazing-angle Fresnel, so the shader work is limited to
//   - deep/shallow body colour under the reflection,
//   - animated ripple normals (five rotating wave trains + a noise wobble),
//   - a tight sun glint lobe on the emissive channel,
//   - a distance blend to the horizon haze so the far water, the fog and the
//     sky's haze band all land on the same value at the seam.
//
// The plane is bigger than the camera far plane, so it is the far plane, not
// the geometry edge, that cuts the sea off — which is exactly why the haze
// colours have to agree.

export function createWater(): THREE.Mesh {
  const tod = parseBootParams().timeOfDay;
  const sunDir = sunDirectionFor(tod);
  const haze = hazeSrgbFor(tod);

  const geo = new THREE.PlaneGeometry(8000, 8000, 1, 1);
  const uTime = { value: 0 };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.06,
    metalness: 0.0,
    transparent: true,
    opacity: 1.0,
    envMapIntensity: 1.15,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uSunDir = { value: sunDir.clone() };
    shader.uniforms.uSunCol = { value: new THREE.Vector3(1.0, 0.82, 0.60) };
    shader.uniforms.uDeep = { value: new THREE.Color(0x08262e) };
    shader.uniforms.uShallow = { value: new THREE.Color(0x1c5f61) };
    shader.uniforms.uHaze = { value: new THREE.Color().setRGB(haze[0], haze[1], haze[2], THREE.SRGBColorSpace) };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWPos;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uHaze;

vec3 gWN;      // world-space wave normal
float gWDist;  // distance to camera
float gWFade;  // 1 near, 0 far — kills ripple aliasing in the distance

float wh12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float wvn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wh12(i), wh12(i + vec2(1.0, 0.0)), f.x),
             mix(wh12(i + vec2(0.0, 1.0)), wh12(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Gradient of a stack of rotating sine trains. Each octave keeps roughly the
// same slope contribution so the surface stays gently choppy at every scale.
vec3 waveNormal(vec2 p, float t, float scale) {
  vec2 g = vec2(0.0);
  vec2 dir = vec2(0.92, 0.39);
  float a = 0.11 * scale, f = 0.35, sp = 1.35;
  for (int i = 0; i < 5; i++) {
    float ph = dot(p, dir) * f + t * sp;
    g += dir * cos(ph) * a * f;
    dir = vec2(dir.x * 0.62 - dir.y * 0.785, dir.x * 0.785 + dir.y * 0.62);
    a *= 0.62; f *= 1.6; sp *= 1.22;
  }
  // Irregularity so it never reads as a sine grid.
  g += (vec2(wvn(p * 0.55 + t * 0.15), wvn(p * 0.55 + 31.7 - t * 0.11)) - 0.5) * 0.09 * scale;
  return normalize(vec3(-g.x, 1.0, -g.y));
}`
      )
      .replace(
        '#include <map_fragment>',
        `{
  gWDist = length(vWPos - cameraPosition);
  gWFade = 1.0 - smoothstep(35.0, 620.0, gWDist);
  vec3 V = normalize(cameraPosition - vWPos);
  float down = clamp(V.y, 0.0, 1.0);

  // Body colour: looking down you see into the water, grazing angles hand over
  // to the environment reflection via the standard BRDF Fresnel.
  float swell = wvn(vWPos.xz * 0.06 + uTime * 0.05);
  vec3 col = mix(uDeep, uShallow, smoothstep(0.35, 0.85, swell) * (0.35 + 0.4 * down));

  // Meet the sky: the fog does most of it, this guarantees the seam matches.
  col = mix(col, uHaze * 0.55, smoothstep(220.0, 1500.0, gWDist) * 0.6);

  diffuseColor.rgb *= col;
  diffuseColor.a *= mix(1.0, 0.80, down * down);
}`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
{
  // Rough the surface off with distance: a mirror-smooth sea at 800m is pure
  // specular aliasing.
  roughnessFactor = mix(0.30, roughness, gWFade);
}`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `{
  gWN = waveNormal(vWPos.xz, uTime, mix(0.18, 1.0, gWFade));
  normal = normalize((viewMatrix * vec4(gWN, 0.0)).xyz);
}`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  vec3 V = normalize(cameraPosition - vWPos);
  vec3 H = normalize(uSunDir + V);
  float ndh = max(dot(gWN, H), 0.0);
  // Tight glitter plus a broad sheen: the two together read as sun on water.
  float glint = pow(ndh, 900.0) * 5.5 + pow(ndh, 70.0) * 0.30;
  totalEmissiveRadiance += uSunCol * glint * gWFade;
}`
      );
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.35;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  // Frame-stepped so captures stay reproducible (see sky.ts).
  let frame = 0;
  mesh.onBeforeRender = () => {
    uTime.value = (frame++) / 60;
  };
  return mesh;
}
