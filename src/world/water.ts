import * as THREE from 'three';
import { parseBootParams } from '../core/settings';
import {
  FOG_HEIGHT,
  hazeNearLinearFor,
  skyCubeUniform,
  sunDirectionFor,
  sunTintFor,
  useSkyEnv,
} from './sky';
import { terrainMaps } from './terrain';
import { MAP_SIZE } from '../gen/terraingen';

// Sea plane around the island. Two triangles and one patched
// MeshStandardMaterial. What makes it read as water rather than a white slab:
//
//   - A real DEPTH MODEL. The terrain's baked control map carries sea depth in
//     its red channel, so shallow and deep are different colours, the waterline
//     fades instead of cutting, and foam sits in the 0-0.9m band where it
//     belongs. Without depth the "deep" and "shallow" uniforms were mixed by a
//     noise field and body colour was statistically identical at the beach and
//     800m out.
//   - BAND-LIMITED wave normals. Each octave is faded out as its wavelength
//     approaches the pixel footprint and the variance it loses is pushed into
//     roughness (normal-map-to-roughness / LEAN filtering). That kills the
//     moire in the mid water AND is what makes the sun's glitter path appear:
//     a wider GGX lobe on a rougher surface catches the sun over a track of
//     pixels instead of a vanishing few.
//   - No emissive glint hack. A pow(ndh, 900) delta lobe on a single normal
//     sample is satisfied by almost no pixels; the standard GGX specular with
//     the filtered roughness carries the sun on its own.
//   - The SAME aerial-perspective function the terrain runs, so the sea and the
//     sky cannot disagree at the horizon.

const SEA_Y = 0.35;
const SEA_DEPTH_RANGE = 12.0;

export function createWater(): THREE.Mesh {
  const tod = parseBootParams().timeOfDay;
  const sunDir = sunDirectionFor(tod);
  const hazeNear = hazeNearLinearFor(tod);
  const sunTint = sunTintFor(tod);

  const geo = new THREE.PlaneGeometry(8000, 8000, 1, 1);
  const uTime = { value: 0 };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.11,
    metalness: 0.0,
    transparent: true,
    opacity: 1.0,
    // 1.0 -> 0.32. The PMREM's roughness-1 mip is the AVERAGE of the whole
    // dome, so leaning on it for the mirror produced a bright band wherever the
    // sky average was brightest — at the horizon — which is exactly the defect
    // the critic measured: the water's row-mean luminance peaked ON the horizon
    // line (246 at y=515) and had no organised glitter below it, when the
    // mirror-sun for a 17-degree sun and a 17m camera must sit ~420px BELOW the
    // horizon. What is left here is the broad rough-water term; the SHARP
    // Fresnel reflection now comes off the sky cube through the real wave
    // normal (see the aomap_fragment patch), and the sun's own glitter comes
    // off the standard GGX lobe, where it belongs.
    envMapIntensity: 0.32,
  });
  useSkyEnv(mat);

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uSunDir = { value: sunDir.clone() };
    shader.uniforms.uDepthMap = { value: terrainMaps.splat };
    shader.uniforms.uMapSize = { value: MAP_SIZE };
    // Linear. Extinction pulls a shallow green-teal down to a deep blue-black.
    // Shallow lifted ~55% and pushed toward turquoise. At (0.075,0.148,0.140)
    // every inland shallow — the flooded hollows that read as "ponds" in the
    // vista — rendered as a flat dark slate patch with no body at all, because
    // shallow water's colour is mostly the BOTTOM showing through and there was
    // no bottom term. uBed is that bottom (wet silt), blended in by an
    // exponential on depth below.
    shader.uniforms.uShallow = { value: new THREE.Vector3(0.115, 0.232, 0.216) };
    shader.uniforms.uDeep = { value: new THREE.Vector3(0.0035, 0.0180, 0.0300) };
    shader.uniforms.uBed = { value: new THREE.Vector3(0.148, 0.126, 0.086) };
    shader.uniforms.uFoam = { value: new THREE.Vector3(0.50, 0.53, 0.52) };
    shader.uniforms.uHazeNear = { value: new THREE.Vector3(...hazeNear) };
    shader.uniforms.uSunTint = { value: sunTint.clone() };
    shader.uniforms.uFogHeight = { value: FOG_HEIGHT };
    shader.uniforms.uSkyCube = skyCubeUniform;

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
uniform sampler2D uDepthMap;
uniform float uMapSize;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uBed;
uniform vec3 uFoam;
uniform vec3 uHazeNear;
uniform vec3 uSunTint;
uniform float uFogHeight;
uniform samplerCube uSkyCube;

vec3 gWN;        // world-space wave normal
float gWDist;    // distance to camera
float gWFade;    // 1 near, 0 far
float gLost;     // normal variance removed by band-limiting -> roughness
float gDepth;    // metres of water under this fragment
float gFoam;

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

// Gradient of a stack of rotating sine trains, band-limited per octave. The
// texel footprint is measured once; any octave whose wavelength drops under
// ~2 texels is faded out and its variance accumulated into gLost, which widens
// the specular lobe instead of aliasing into corduroy.
// A DIRECTIONAL SPECTRUM, not a rotating stack. Six trains with headings drawn
// from a +/-35 degree cone about one swell heading, amplitudes on a Phillips-ish
// falloff and a per-train random phase. The old version rotated one direction by
// a constant 51.6 degrees per octave with a geometric a *= 0.62, which produced
// evenly spaced concentric arcs at one wavelength — corrugated metal, not sea.
const float SWELL = 0.62;   // radians, heading of the dominant swell
vec3 waveNormal(vec2 p, float t, float scale, float texel) {
  vec2 g = vec2(0.0);
  gLost = 0.0;
  float f = 0.29;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    // Spread inside the cone, alternating sides so successive trains cross.
    float spread = (wvn(vec2(fi * 5.7, 1.3)) - 0.5) * 1.22;
    float ang = SWELL + spread;
    vec2 dir = vec2(cos(ang), sin(ang));
    // Phillips falloff: energy ~ k^-2.5, so amplitude ~ f^-1.25 rather than a
    // flat geometric ratio. Steeper at the short end, which is what keeps the
    // long swell dominant and the chop as a rider on it.
    float a = 0.115 * scale * pow(0.29 / f, 1.25);
    float lim = 1.0 - smoothstep(0.5, 1.5, texel * f / 6.28318);
    float ph = dot(p, dir) * f + t * (1.05 + fi * 0.31) + wvn(vec2(fi * 7.3, 2.1)) * 6.28318;
    g += dir * cos(ph) * a * f * lim;
    gLost += (1.0 - lim) * a * f;
    f *= 1.79;
  }
  g += (vec2(wvn(p * 0.55 + t * 0.15), wvn(p * 0.55 + 31.7 - t * 0.11)) - 0.5) * 0.09 * scale;
  return normalize(vec3(-g.x, 1.0, -g.y));
}`
      )
      .replace(
        '#include <map_fragment>',
        `{
  gWDist = length(vWPos - cameraPosition);
  gWFade = 1.0 - smoothstep(35.0, 620.0, gWDist);

  // Waves are evaluated HERE, not in normal_fragment_maps: three runs
  // <roughnessmap_fragment> before <normal_fragment_maps>, and the roughness
  // needs the variance this discards.
  float texel = max(fwidth(vWPos.x), fwidth(vWPos.z));
  gWN = waveNormal(vWPos.xz, uTime, mix(0.34, 1.0, gWFade), texel);
  // NO blanket flattening. The old mix toward +Y by smoothstep(0,300)*0.85
  // destroyed the slope variance the glitter path is made of — mid-water ripple
  // contrast collapsed 21.9 -> 13.5 -> 3.0 across near/mid/far and the sea went
  // dead flat past 200m. The per-octave band-limiter above already removes
  // exactly the octaves that would alias, which is the correct place to do it;
  // all that is left here is a gentle far-field settle.
  gWN = normalize(mix(gWN, vec3(0.0, 1.0, 0.0), smoothstep(250.0, 1600.0, gWDist) * 0.45));

  // Depth from the terrain's baked control map (red channel).
  vec2 duv = clamp(vWPos.xz / uMapSize + 0.5, 0.0, 1.0);
  gDepth = texture2D(uDepthMap, duv).r * ${SEA_DEPTH_RANGE.toFixed(1)};

  // Per-channel extinction: red dies within a metre, blue carries metres.
  vec3 ext = exp(-gDepth * vec3(1.30, 0.50, 0.32));
  vec3 col = mix(uDeep, uShallow, ext);
  // SEABED / POND BED. Under about 1.5m of water you are looking at the ground,
  // not at the water, and the transmitted bottom colour is what turns a flat
  // navy polygon into a body of water sitting IN a landscape. Two-way
  // extinction, so it dies fast with depth.
  float seeBed = exp(-gDepth * 1.55);
  col = mix(col, uBed, seeBed * 0.62);

  // Foam arriving in SETS. A shore-parallel travelling phase read off the depth
  // field (k ~ 2.2 rad/m) means breakers march up the beach instead of the foam
  // ringing the island as one lace ribbon at constant width.
  float fw = wvn(vWPos.xz * 1.6 + uTime * 0.45) * 0.6 + wvn(vWPos.xz * 5.5 - uTime * 0.9) * 0.4;
  float sets = 0.45 + 0.55 * sin(gDepth * 2.2 - uTime * 1.5 + wvn(vWPos.xz * 0.09) * 6.28318);
  gFoam = smoothstep(1.05, 0.02, gDepth) * smoothstep(0.30, 0.72, fw) * sets;
  gFoam += smoothstep(0.20, 0.0, gDepth) * 0.55;
  gFoam = clamp(gFoam, 0.0, 1.0);
  col = mix(col, uFoam, gFoam);

  diffuseColor.rgb *= col;
  // Soft intersect with the beach instead of a razor geometric edge. The depth
  // field is a 1024 map over 1200m (1.17 m/texel), so a 0.55m fade is under one
  // texel of feather and the waterline came out as a jagged aliased mask edge —
  // most visible on the inland hollows, where it is the whole silhouette. A
  // noise-perturbed 1.2m fade breaks the texel staircase and lets the water
  // feather into wet sand.
  float edgeN = wvn(vWPos.xz * 0.85) + wvn(vWPos.xz * 3.1) * 0.4;
  diffuseColor.a *= clamp((gDepth + (edgeN - 0.7) * 0.30) / 1.15, 0.0, 1.0);
}`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
{
  // Rough the surface off with distance AND with the normal detail the
  // band-limiter removed — this is what turns a delta-function glint into a
  // specular track running from the horizon toward the camera.
  // Floor raised (0.11 -> 0.155 near, 0.22 -> 0.30 far). At 0.11 the GGX peak
  // for a 22-intensity key is four orders of magnitude above the sky, so the
  // glitter path clipped to a solid 255,255,255 slab 45px deep instead of
  // breaking up into a track. Spreading the lobe puts the same energy over
  // more pixels, which is what a real sun track looks like.
  // Near roughness 0.155 -> 0.21. The glitter path measured as a solid clipped
  // (255,255,255) slab with no wave structure inside it: a 22-intensity key
  // through a GGX lobe this tight puts the peak four orders of magnitude over
  // the sky, and no tone curve recovers detail from that. Widening the lobe
  // spreads the same energy over ~4x the pixels, which is what a real sun track
  // looks like — a field of separate highlights, not a plate.
  roughnessFactor = mix(0.30, 0.21, gWFade) + gLost * 2.4;
  roughnessFactor = mix(roughnessFactor, 0.55, gFoam);
  // Floor raised 0.03 -> 0.045 so the GGX lobe is wide enough to catch the sun
  // over a contiguous track rather than a handful of pixels; ceiling dropped
  // 0.9 -> 0.85 so the far water still returns a reflection at all.
  roughnessFactor = clamp(roughnessFactor, 0.105, 0.85);
}`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `{
  normal = normalize((viewMatrix * vec4(gWN, 0.0)).xyz);
}`
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
{
  // SHARP FRESNEL SKY REFLECTION, sampled through the actual wave normal.
  //
  // Two cycle-3 defects close here. (1) Off the sun track the sea had no normal
  // perturbation visible at all — the ripple normals were only feeding the
  // specular lobe, so the left of the coast frame was a flat gradient. Sampling
  // a real cube through those normals puts texture across the WHOLE plane.
  // (2) At ~89.9 degrees of incidence Schlick for water (F0=0.02) exceeds 0.95,
  // so the sea within a few pixels of the horizon must land within a few
  // percent of the sky; it measured 33/255 darker. The reflection vector is
  // clamped above the horizon plane so a facet tilted past the view ray cannot
  // sample the underside of the dome and drag a dark band across the water.
  vec3 Vw = normalize(cameraPosition - vWPos);
  vec3 Rw = reflect(-Vw, gWN);
  Rw = normalize(vec3(Rw.x, max(Rw.y, 0.010), Rw.z));
  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(gWN, Vw), 0.0, 1.0), 5.0);
  // Foam is a diffuse scatterer, not a mirror.
  float gloss = (1.0 - roughnessFactor * 0.55) * (1.0 - gFoam * 0.85);
  reflectedLight.indirectSpecular += textureCube(uSkyCube, Rw).rgb * fres * gloss;
  // ...and the body colour is what is LEFT after that reflection, otherwise the
  // sea is brighter than the sky it mirrors.
  reflectedLight.indirectDiffuse *= 1.0 - fres * 0.85;
  reflectedLight.directDiffuse *= 1.0 - fres * 0.85;
}`
      )
      .replace(
        '#include <fog_fragment>',
        `{
  float hAvg = max(0.5 * (vWPos.y + cameraPosition.y), 0.0);
  float dens = fogDensity * exp(-hAvg / uFogHeight);
  float fx = dens * vFogDepth;
  // Capped higher than the land: the sea runs to the horizon, so it has to
  // finish ON the sky value or the frame gets a drawn line where they meet.
  float amt = min(1.0 - exp(-fx * fx), 0.992);
  // SAME sky cube the terrain fogs toward, sampled along the same view ray, so
  // sea and sky converge on one value by construction. Cycle 3 fogged the sea
  // toward SEA_HORIZON_LINEAR and the land toward a different constant and the
  // dome toward a third, which is why the waterline was a drawn 33/255 step.
  vec3 vdir = normalize(vWPos - cameraPosition);
  vec3 sdir = normalize(vec3(vdir.x, max(vdir.y, 0.004), vdir.z));
  vec3 fc = textureCube(uSkyCube, sdir).rgb;
  // Same Mie lobe the land runs, so the sea-to-sky junction softens on the sun
  // side instead of stepping into a hard grey line.
  float fwd = max(dot(vdir, uSunDir), 0.0);
  fc *= mix(vec3(1.0), uSunTint * vec3(1.34, 1.20, 1.02), clamp(pow(fwd, 7.0) * 0.40 + pow(fwd, 2.0) * 0.10, 0.0, 1.0));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fc, amt);
}`
      );
  };

  mat.customProgramCacheKey = () => 'sea-v6';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = SEA_Y;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  // Frame-stepped so captures stay reproducible (see sky.ts).
  let frame = 0;
  mesh.onBeforeRender = () => {
    uTime.value = frame++ / 60;
  };
  return mesh;
}
