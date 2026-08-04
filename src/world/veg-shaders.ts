import * as THREE from 'three';

// Every green surface in the build shares one lighting model, defined once here.
//
// Cycle 2 gave vegetation a lit shader for the first time, but the fill it
// carried was a token 6% of key. Measured on the cycle-2 stills that meant
// canopy p5 = 0.0 and 14.9% of canopy pixels below luminance 12, against 8.5
// and 1.8% in the PUBG reference — nothing in a real canopy ever hits zero, and
// half the crowns in the frame read as unlit silhouettes next to mid-green
// neighbours on the same tree. Cycle 3's model:
//
//   * A REAL HEMISPHERE AMBIENT. mix(groundBounce, skyColour, N.y*0.5+0.5) at
//     ~15-25% of key, with the sky term carrying blue at 1.6x its red. This is
//     the single change that lifts the shadow side off zero AND fixes the
//     channel balance: the build averaged blue at a third of red where the
//     reference sits at two thirds, because skylight fills the shadow side.
//   * WRAPPED diffuse — saturate((N.L + 0.5) / 1.5). Foliage is thin and
//     scatters; the shadow side must never reach zero.
//   * A SHADOW FLOOR. A cast shadow multiplies the SUN only, and even that
//     keeps ~12%: an unlit tree shadow crossing a field was turning every blade
//     under it into a black slash.
//   * A skyward-biased normal that is NEVER flipped by facing. Cards are
//     two-sided and shade as a volume, not as a cutout.
//   * A TRANSMISSION lobe, pow(saturate(dot(-L, V)), 3.5), rising toward the tip
//     of a blade and the outside of a crown. This is the strongest single cue
//     in the PUBG reference — every backlit stem glows.
//   * AN ANISOTROPIC SHEEN (Kajiya-Kay) along the blade/leaf tangent. Dry grass
//     reads bright in the reference because sun-facing faces throw a broad
//     grazing highlight; with no specular lobe at all the build's field could
//     not physically exceed p99 = 158 where the reference reaches 206.
//   * A root-to-tip AO ramp multiplied into albedo, so blades are dark where
//     they meet the ground and bright at the tip.
//   * A real shadow-map fetch. `lights: true` plus UniformsLib.lights is what
//     makes three bind directionalShadowMap/Matrix/Shadows on a ShaderMaterial.
//
// NOTE on tone mapping: the post pipeline renders the scene to a linear target,
// and three disables tone mapping whenever the target is not the canvas. So the
// tonemapping PARS chunk must NOT be included by hand (on ?nopost the program
// prefix injects it and the duplicate definitions break the shader); including
// only <tonemapping_fragment>, which is guarded on TONE_MAPPING, is correct in
// both paths.

export interface VegLightParams {
  sunDir: THREE.Vector3;
  /** Linear sun radiance, already scaled by intensity / PI. */
  sunCol: THREE.Color;
  skyCol: THREE.Color;
  gndCol: THREE.Color;
  transCol: THREE.Color;
  /** x = sheen strength, y = sheen exponent. */
  spec: THREE.Vector2;
  /** Fraction of the sun a fully shadowed foliage pixel keeps. */
  shadowFloor: number;
}

function lightUniforms(p: VegLightParams): Record<string, THREE.IUniform> {
  return {
    uSunDir: { value: p.sunDir.clone() },
    uSunCol: { value: p.sunCol.clone() },
    uSkyCol: { value: p.skyCol.clone() },
    uGndCol: { value: p.gndCol.clone() },
    uTransCol: { value: p.transCol.clone() },
    uSpec: { value: p.spec.clone() },
    uShadowFloor: { value: p.shadowFloor },
  };
}

const LIGHT_PARS = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uGndCol;
uniform vec3 uTransCol;
uniform vec2 uSpec;
uniform float uShadowFloor;

vec3 vegAmbient(vec3 N) {
  return mix(uGndCol, uSkyCol, N.y * 0.5 + 0.5);
}

/**
 * albedo  linear base colour
 * N       shading normal (skyward-biased, never facing-flipped)
 * V       fragment -> camera
 * T       long axis of the blade / leaf for the anisotropic lobe
 * shadow  0..1 from the shadow map
 * trans   how translucent this fragment is (tip 1, root 0)
 * ao      occlusion multiplier on the whole diffuse response
 * sheen   per-fragment weight on the anisotropic highlight
 * ambSc   attenuation on the hemisphere fill (1 = open sky, 0.4 = buried in a
 *         dense clump). A per-blade AO ramp CANNOT express occlusion of one
 *         blade by its neighbours, which is why cycle 3's grass mass had no
 *         interior: every stem was the same value root to tip and front rank to
 *         back rank, so the field was uniformly lit and read weightless.
 */
vec3 vegLight(vec3 albedo, vec3 N, vec3 V, vec3 T, float shadow, float trans, float ao, float sheen, float ambSc) {
  float sh = mix(uShadowFloor, 1.0, shadow);
  float ndl = dot(N, uSunDir);
  float wrap = clamp((ndl + 0.5) / 1.5, 0.0, 1.0);
  vec3 amb = vegAmbient(N) * ambSc;
  vec3 col = albedo * ao * (uSunCol * wrap * sh + amb);

  float t = pow(clamp(dot(-uSunDir, V), 0.0, 1.0), 3.5);
  col += albedo * uTransCol * uSunCol * (t * trans * sh);

  // Kajiya-Kay: the highlight is a ring about the fibre axis, so it stays on a
  // blade at every roll angle instead of winking on only at one orientation.
  vec3 Hv = normalize(uSunDir + V);
  float th = dot(T, Hv);
  float sinTH = sqrt(max(0.0, 1.0 - th * th));
  col += uSunCol * (pow(sinTH, uSpec.y) * uSpec.x * sheen * sh * wrap);
  return col;
}
`;

const SHADOW_PARS_VERT = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
`;

/** Writes vDirectionalShadowCoord for a world position + world normal. */
const SHADOW_VERT = /* glsl */ `
#ifdef USE_SHADOWMAP
#if NUM_DIR_LIGHT_SHADOWS > 0
  vec4 vegShadowWP;
  #pragma unroll_loop_start
  for (int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i++) {
    vegShadowWP = vec4(shadowPos, 1.0) + vec4(shadowNrm * directionalLightShadows[i].shadowNormalBias, 0.0);
    vDirectionalShadowCoord[i] = directionalShadowMatrix[i] * vegShadowWP;
  }
  #pragma unroll_loop_end
#endif
#endif
`;

const SHADOW_PARS_FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <shadowmap_pars_fragment>

float vegShadow() {
  #ifdef USE_SHADOWMAP
  #if NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow dls = directionalLightShadows[0];
    return getShadow(directionalShadowMap[0], dls.shadowMapSize, dls.shadowIntensity,
                     dls.shadowBias, dls.shadowRadius, vDirectionalShadowCoord[0]);
  #endif
  #endif
  return 1.0;
}
`;

const NOISE = /* glsl */ `
float vHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vHash(i), vHash(i + vec2(1.0, 0.0)), f.x),
             mix(vHash(i + vec2(0.0, 1.0)), vHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/**
 * Per-instance albedo variation. Cycle 2 jittered HUE, which is what produced a
 * field of same-value tufts in slightly different greens; the reference's
 * variation is almost entirely VALUE — bleached straw next to shaded straw —
 * with only a few degrees of hue either side.
 */
const JITTER = /* glsl */ `
vec3 vegJitter(vec3 albedo, float rand) {
  // 0.90-1.12, NOT 0.76-1.24. The wide range compounded with the crown AO floor
  // and the albedo floor to split one treeline into two populations — sage-green
  // crowns standing beside near-black ones under a single sun, which reads as a
  // bug rather than as variety.
  float val = 0.90 + 0.22 * rand;
  vec3 hue = mix(vec3(0.97, 1.00, 1.04), vec3(1.05, 1.00, 0.96), rand);
  return albedo * val * hue;
}
/** Pulls a fragment toward the ground colour without importing its CHROMA:
 *  the raw terrain tint runs blue at a quarter of red, and multiplying it in
 *  straight is what took the sward to saturation 0.63-0.70. */
vec3 vegGroundPull(vec3 albedo, vec3 tint, float gain, float amt) {
  vec3 t = mix(vec3(dot(tint, vec3(0.3333))), tint, 0.5) * gain;
  return mix(albedo, albedo * t, amt);
}
`;

/** Travelling gust field — one gust crosses a whole field instead of every
 *  blade nodding on the same sine. Instance phase keeps clumps out of lockstep. */
const WIND = /* glsl */ `
vec2 vegWind(vec3 iorg, float t, float phase, float amp) {
  vec2 wdir = vec2(0.8137, 0.5813);
  float gA = vNoise(iorg.xz * 0.032 - wdir * t * 0.62);
  float gB = vNoise(iorg.xz * 0.0105 - wdir * t * 0.24);
  float gust = smoothstep(0.30, 0.86, gA * 0.55 + gB * 0.60);
  float flut = sin(t * 3.1 + phase * 39.5 + iorg.x * 0.41 + iorg.z * 0.33);
  return wdir * (0.040 + gust * 0.26 + flut * (0.012 + gust * 0.05)) * amp;
}
`;

function baseUniforms(p: VegLightParams, extra: Record<string, THREE.IUniform>): Record<string, THREE.IUniform> {
  return THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    THREE.UniformsLib.fog,
    lightUniforms(p),
    extra,
  ]);
}

// ---------------------------------------------------------------------------
// Near-band ground cover: real instanced blade geometry
// ---------------------------------------------------------------------------

export interface BladeOpts extends VegLightParams {
  lush: THREE.Color;
  straw: THREE.Color;
  flower: THREE.Color;
  /** Collapsed dead-grass litter lying under the standing blades. */
  thatch: THREE.Color;
  /** Distance band the tier fades in over (x=start, y=full). */
  fadeIn: THREE.Vector2;
  /** Distance band the tier fades out over. */
  fadeOut: THREE.Vector2;
  windAmp: number;
}

export function bladeMaterial(o: BladeOpts): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    lights: true,
    fog: true,
    side: THREE.DoubleSide,
    transparent: false,
    uniforms: baseUniforms(o, {
      uTime: { value: 0 },
      uLush: { value: o.lush.clone() },
      uStraw: { value: o.straw.clone() },
      uFlower: { value: o.flower.clone() },
      uThatch: { value: o.thatch.clone() },
      uFadeIn: { value: o.fadeIn.clone() },
      uFadeOut: { value: o.fadeOut.clone() },
      uWindAmp: { value: o.windAmp },
      uTintGain: { value: 3.1 },
    }),
    vertexShader: /* glsl */ `
      ${SHADOW_PARS_VERT}
      #include <fog_pars_vertex>
      ${NOISE}
      ${WIND}
      uniform float uTime;
      uniform vec2 uFadeIn;
      uniform vec2 uFadeOut;
      uniform float uWindAmp;
      attribute vec4 aBlade;   // h, side, bladeRand, kind
      attribute vec3 aTan;
      attribute float aRand;
      attribute float aDry;
      attribute float aShade;
      attribute float aDens;
      attribute vec3 aTint;
      varying vec3 vN;
      varying vec3 vT;
      varying vec3 vWPos;
      varying float vH;
      varying float vSide;
      varying float vBladeRand;
      varying float vKind;
      varying float vDry;
      varying float vShade;
      varying float vDens;
      varying vec3 vTint;
      varying float vRand;

      void main() {
        vec3 iorg = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 opos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
        mat3 im = mat3(modelMatrix) * mat3(instanceMatrix);
        // Deliberately not named tan: that shadows a GLSL built-in.
        vec3 nrm = normalize(im * normal);
        vec3 tng = normalize(im * aTan);

        // Ring cross-fade by SHRINKING the instance, never by clipping it:
        // a hard distance cull draws a visible arc across the field.
        float d = distance(cameraPosition.xz, iorg.xz);
        float fade = smoothstep(uFadeIn.x, uFadeIn.y, d) * (1.0 - smoothstep(uFadeOut.x, uFadeOut.y, d));
        vec3 wpos = mix(iorg, opos, fade);

        // Wind bends only the upper blade (h^2), scaled by the instance height.
        float hN = aBlade.x;
        float sy = length(instanceMatrix[1].xyz);
        vec2 bend = vegWind(iorg, uTime, aRand, uWindAmp) * (hN * hN) * sy * fade;
        wpos.xz += bend;
        wpos.y -= length(bend) * 0.34;

        vN = nrm;
        vT = tng;
        vWPos = wpos;
        vH = hN;
        vSide = aBlade.y;
        vBladeRand = aBlade.z;
        vKind = aBlade.w;
        vDry = aDry;
        vShade = aShade;
        vDens = aDens;
        vTint = aTint;
        vRand = aRand;

        vec3 shadowPos = wpos;
        vec3 shadowNrm = nrm;
        ${SHADOW_VERT}

        vec4 mvPosition = viewMatrix * vec4(wpos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      ${SHADOW_PARS_FRAG}
      ${LIGHT_PARS}
      ${JITTER}
      #include <fog_pars_fragment>
      uniform vec3 uLush;
      uniform vec3 uStraw;
      uniform vec3 uFlower;
      uniform vec3 uThatch;
      uniform float uTintGain;
      varying vec3 vN;
      varying vec3 vT;
      varying vec3 vWPos;
      varying float vH;
      varying float vSide;
      varying float vBladeRand;
      varying float vKind;
      varying float vDry;
      varying float vShade;
      varying float vDens;
      varying vec3 vTint;
      varying float vRand;

      void main() {
        float isFlower = step(0.5, vKind) * (1.0 - step(1.5, vKind));
        float isLitter = step(1.5, vKind) * (1.0 - step(2.5, vKind));
        float isSeed   = step(2.5, vKind);

        vec3 albedo = mix(uLush, uStraw, clamp(vDry, 0.0, 1.0));
        // Base-to-tip ramp. A blade is greener and darker where it leaves the
        // sheath and bleached where the sun has had it all summer; without it
        // every stem is one flat value root to tip, which is the "smooth
        // untextured wire" read at sub-metre range.
        vec3 tipCol = mix(albedo * vec3(1.34, 1.24, 1.02), uStraw * 1.30, 0.35);
        albedo = mix(albedo * 0.74, tipCol, pow(clamp(vH, 0.0, 1.0), 1.4));
        // Per-blade value spread, then per-INSTANCE value jitter. Hue jitter is
        // deliberately tiny: bleached-straw variation is a value story.
        albedo *= 0.80 + 0.34 * vBladeRand;
        albedo = vegJitter(albedo, vRand);
        // Bleached seed stalks stand a shade lighter and much less saturated.
        albedo = mix(albedo, mix(albedo, vec3(dot(albedo, vec3(0.3333))), 0.45) * 1.30, isSeed);
        albedo = mix(albedo, uFlower, isFlower);
        // THATCH IS A VALUE DROP, NOT A GRAPHIC MARK. Cycle 3 stacked three
        // darkeners on it (a 0.72 base, a further 0.90, and an ao of 0.76) over
        // a thatch colour a quarter of the straw's, and the stratum rendered as
        // scattered charcoal sticks — the hardest-edged, darkest marks in the
        // frame. Real thatch is a pale, low-contrast mat sitting slightly below
        // the standing grass, so it is mixed halfway to the live sward and the
        // per-card spread is narrowed to 0.88-1.12.
        vec3 thatch = mix(uThatch, mix(uLush, uStraw, clamp(vDry, 0.0, 1.0)), 0.5)
                    * (0.88 + 0.24 * vBladeRand);
        albedo = mix(albedo, thatch, isLitter);

        // Grass inherits the hue of the ground it grows out of — strongly at
        // the root, barely at the tip, and with the tint's own chroma halved.
        float gt = mix(0.44, 0.12, smoothstep(0.0, 0.55, vH)) * (1.0 - isFlower);
        albedo = vegGroundPull(albedo, vTint, uTintGain, gt);

        // Contact darkening baked straight into albedo: 0.5 at the base vertex,
        // full by a quarter of blade height. Litter is contact by definition.
        albedo *= mix(mix(0.62, 1.0, smoothstep(0.0, 0.22, vH)), 0.94, isLitter);
        // Pooled shade under trees and dense bush masses — and, since cycle 4,
        // the raked directional shadow the woody layer throws across the field.
        albedo *= 1.0 - vShade * 0.60;

        // Root-to-tip occlusion on the light response.
        float ao = mix(0.48 + 0.52 * smoothstep(0.0, 0.32, vH), 0.82, isLitter);

        vec3 V = normalize(cameraPosition - vWPos);
        float trans = (0.16 + 0.84 * vH) * (1.0 - isLitter);
        // A faked midrib: the blade catches the fibre highlight down its spine
        // and loses it toward the two folded edges.
        float rib = 1.0 - 0.42 * smoothstep(0.10, 0.85, abs(vSide));
        // The sheen belongs to blades and stalks; a flat litter card or a petal
        // catching a fibre highlight reads as wet plastic.
        float sheen = (0.55 + 0.75 * vH) * rib * (1.0 - isLitter) * (1.0 - isFlower) * (1.0 + isSeed * 0.5);
        // Interior of the sward: hemisphere fill falls away with local density
        // and toward the root, which is where the reference gets its deep
        // inter-stalk shadow and therefore its gold lit tips.
        float ambSc = mix(1.0, 0.42, clamp(vDens, 0.0, 1.0) * (1.0 - vH * 0.85));
        vec3 col = vegLight(albedo, normalize(vN), V, normalize(vT), vegShadow(), trans, ao, sheen, ambSc);

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
  return mat;
}

// ---------------------------------------------------------------------------
// Mid / far ground cover: billboard cards off the cover atlas
// ---------------------------------------------------------------------------

export interface CoverCardOpts extends VegLightParams {
  atlas: THREE.Texture;
  tiles: number;
  fadeIn: THREE.Vector2;
  fadeOut: THREE.Vector2;
  windAmp: number;
  tintGain: number;
  /** How far albedo is pulled toward the ground tint: x at the tip, y at the root. */
  tintAmt: THREE.Vector2;
  /** The SAME palette pair the near band uses — see the seam note below. */
  lush: THREE.Color;
  straw: THREE.Color;
  /** Measured mean RGB of the atlas's opaque texels, linear. */
  atlasMean: THREE.Color;
}

export function coverCardMaterial(o: CoverCardOpts): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    lights: true,
    fog: true,
    side: THREE.DoubleSide,
    transparent: false,
    uniforms: baseUniforms(o, {
      uTime: { value: 0 },
      uMap: { value: null },
      uTileStep: { value: 1 / o.tiles },
      uFadeIn: { value: o.fadeIn.clone() },
      uFadeOut: { value: o.fadeOut.clone() },
      uWindAmp: { value: o.windAmp },
      uTintGain: { value: o.tintGain },
      uTintAmt: { value: o.tintAmt.clone() },
      uLush: { value: o.lush.clone() },
      uStraw: { value: o.straw.clone() },
      uAtlasMean: { value: o.atlasMean.clone() },
    }),
    vertexShader: /* glsl */ `
      ${SHADOW_PARS_VERT}
      #include <fog_pars_vertex>
      ${NOISE}
      ${WIND}
      uniform float uTime;
      uniform float uTileStep;
      uniform vec2 uFadeIn;
      uniform vec2 uFadeOut;
      uniform float uWindAmp;
      attribute float aRand;
      attribute float aTile;
      attribute float aDry;
      attribute float aShade;
      attribute float aDens;
      attribute vec3 aTint;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vT;
      varying vec3 vWPos;
      varying float vRoot;
      varying float vRand;
      varying float vDry;
      varying float vShade;
      varying float vDens;
      varying vec3 vTint;

      void main() {
        // Per-instance horizontal MIRROR. Six atlas tiles read as six repeated
        // motifs across a field; mirroring doubles the apparent variety for the
        // price of one sign flip, and it is what breaks the "same shaving-brush
        // clump over and over" read in the mid band.
        float flip = step(0.5, fract(aRand * 7.31));
        float u = mix(uv.x, 1.0 - uv.x, flip);
        vUv = vec2((mix(0.006, 0.994, u) + aTile) * uTileStep, uv.y);

        vec3 iorg = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float sw = instanceMatrix[0][0];
        float sh = instanceMatrix[1][1];
        float d = distance(cameraPosition.xz, iorg.xz);
        float fade = smoothstep(uFadeIn.x, uFadeIn.y, d) * (1.0 - smoothstep(uFadeOut.x, uFadeOut.y, d));
        sw *= fade;
        sh *= fade;

        vec3 toCam = cameraPosition - iorg;
        vec2 fwd = normalize(toCam.xz + vec2(1e-4));
        vec2 right = vec2(fwd.y, -fwd.x);

        vec3 wpos = iorg;
        wpos.xz += right * (position.x * sw);
        wpos.y += position.y * sh;
        // A small per-instance lean so a field of billboards does not present
        // one shared vertical axis.
        float lean = (fract(aRand * 13.17) - 0.5) * 0.34;
        wpos.xz += right * (lean * uv.y * sh);

        float tip = uv.y * uv.y;
        vec2 bend = vegWind(iorg, uTime, aRand, uWindAmp) * tip * sh;
        wpos.xz += bend;
        wpos.y -= length(bend) * 0.34;

        // Hemispherical foliage normal: bows outward across the card and stays
        // strongly skyward, so a clump shades as a tuft rather than a plane.
        vN = normalize(vec3(right.x * position.x * 1.2, 0.78, right.y * position.x * 1.2));
        // Blade axis of a clump card is essentially vertical, splayed with x.
        vT = normalize(vec3(right.x * position.x * 0.55, 1.0, right.y * position.x * 0.55));
        vWPos = wpos;
        vRoot = 1.0 - uv.y;
        vRand = aRand;
        vDry = aDry;
        vShade = aShade;
        vDens = aDens;
        vTint = aTint;

        vec3 shadowPos = wpos;
        vec3 shadowNrm = vN;
        ${SHADOW_VERT}

        vec4 mvPosition = viewMatrix * vec4(wpos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      ${SHADOW_PARS_FRAG}
      ${LIGHT_PARS}
      ${JITTER}
      #include <fog_pars_fragment>
      uniform sampler2D uMap;
      uniform float uTintGain;
      uniform vec2 uTintAmt;
      uniform vec3 uLush;
      uniform vec3 uStraw;
      uniform vec3 uAtlasMean;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vT;
      varying vec3 vWPos;
      varying float vRoot;
      varying float vRand;
      varying float vDry;
      varying float vShade;
      varying float vDens;
      varying vec3 vTint;

      void main() {
        // Negative mip bias keeps mid-distance blades crisp instead of letting
        // them dissolve into speckle; the mip chain itself is coverage-corrected
        // in veg-atlas.ts, which is what stops the base going solid.
        vec4 tex = texture2D(uMap, vUv, -0.5);
        // Sharpen the cutout in screen space near the camera, and RELAX it with
        // distance: at treeline range fwidth is large and the hard step lands
        // mid-texel, which produces per-pixel speckle instead of a silhouette.
        float dCam = distance(cameraPosition, vWPos);
        float aSharp = (tex.a - 0.42) / max(fwidth(tex.a), 1e-4) + 0.5;
        float aSoft = smoothstep(0.36, 0.50, tex.a);
        if (mix(aSharp, aSoft, smoothstep(28.0, 70.0, dCam)) < 0.5) discard;

        // ONE PALETTE FOR BOTH TIERS. Cycle 3 took the near band's colour from
        // uLush/uStraw and the mid band's straight off the baked atlas, so the
        // hand-over at ~15 m carried a hard horizontal hue seam — grey-taupe
        // near, orange mid. Dividing by the atlas's measured mean turns the
        // tile into a pure luminance/detail signal and lets the same two stops
        // drive every tier, after which the seam cannot exist.
        vec3 sward = mix(uLush, uStraw, clamp(vDry, 0.0, 1.0));
        // The ratio is COMPRESSED before it drives the palette. Straight
        // tex/mean sends a lit blade pixel to 3-4x the atlas mean, which put the
        // whole mid band several stops above the near band it is supposed to
        // hand over to — a pale sage shag carpet sitting on a warm khaki field.
        // pow(0.55) keeps the tile's light-to-dark ORDER while pulling its range
        // in to something a single palette stop can carry.
        vec3 ratio = pow(tex.rgb / max(uAtlasMean, vec3(0.02)), vec3(0.55));
        // A quarter of the raw tile stays in, so straw tiles and green tiles are
        // still distinguishable from each other; too little to reopen the seam.
        vec3 albedo = mix(sward * ratio * 0.90, tex.rgb, 0.25);
        albedo = vegJitter(albedo, vRand);
        float gt = mix(uTintAmt.x, uTintAmt.y, vRoot * vRoot);
        albedo = vegGroundPull(albedo, vTint, uTintGain, gt);
        albedo *= mix(1.0, 0.52, smoothstep(0.55, 1.0, vRoot));
        albedo *= 1.0 - vShade * 0.55;

        float ao = 0.40 + 0.60 * smoothstep(0.0, 0.5, 1.0 - vRoot);
        vec3 V = normalize(cameraPosition - vWPos);
        float trans = (0.2 + 0.8 * (1.0 - vRoot));
        float ambSc = mix(1.0, 0.55, clamp(vDens, 0.0, 1.0) * vRoot);
        vec3 col = vegLight(albedo, normalize(vN), V, normalize(vT), vegShadow(), trans, ao,
                            0.35 + 0.65 * (1.0 - vRoot), ambSc);

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
  mat.uniforms.uMap.value = o.atlas;
  return mat;
}

// ---------------------------------------------------------------------------
// Tree / bush leaf-cluster cards
// ---------------------------------------------------------------------------

export interface FoliageOpts extends VegLightParams {
  atlas: THREE.Texture;
  tiles: number;
  windAmp: number;
  /** Distance over which crowns lift and desaturate toward the haze. */
  aerial: THREE.Vector2;
}

export function foliageCardMaterial(o: FoliageOpts): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    lights: true,
    fog: true,
    side: THREE.DoubleSide,
    transparent: false,
    uniforms: baseUniforms(o, {
      uTime: { value: 0 },
      uMap: { value: null },
      uTileStep: { value: 1 / o.tiles },
      uWindAmp: { value: o.windAmp },
      uAerial: { value: o.aerial.clone() },
    }),
    vertexShader: /* glsl */ `
      ${SHADOW_PARS_VERT}
      #include <fog_pars_vertex>
      ${NOISE}
      ${WIND}
      uniform float uTime;
      uniform float uTileStep;
      uniform float uWindAmp;
      attribute float aRand;
      attribute float aTile;
      attribute vec4 aCore;   // xyz = crown centre (world), w = crown radius
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vT;
      varying vec3 vWPos;
      varying float vRand;
      varying float vOut;
      varying float vUp;

      void main() {
        float flip = step(0.5, fract(aRand * 5.77));
        float u = mix(uv.x, 1.0 - uv.x, flip);
        vUv = vec2((mix(0.006, 0.994, u) + aTile) * uTileStep, uv.y);

        vec4 wp4 = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vec3 wpos = wp4.xyz;
        vec3 centre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

        // Canopy sway: whole clusters swing, amplitude rising with height above
        // the crown core so a crown does not shear.
        float lift = clamp((wpos.y - aCore.y) / max(aCore.w, 0.2) * 0.4 + 0.6, 0.0, 1.5);
        vec2 bend = vegWind(aCore.xyz, uTime, aRand, uWindAmp) * lift;
        wpos.xz += bend;

        // Volume normal: blend the card's own facing toward the outward normal
        // of the crown sphere, then bias skyward. Never flipped by facing, so a
        // two-sided card cannot shade from a downward normal. At 0.72 the crown
        // shades as a rounded mass with a lit top and a sky-filled underside
        // rather than as N independent planes.
        vec3 cardN = normalize(mat3(modelMatrix) * (mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0)));
        vec3 rel = centre - aCore.xyz;
        vec3 volN = normalize(rel + vec3(0.0, 1e-4, 0.0));
        vOut = clamp(length(rel) / max(aCore.w, 0.001), 0.0, 1.0);
        vUp = clamp((centre.y - aCore.y) / max(aCore.w, 0.001) * 0.5 + 0.5, 0.0, 1.0);
        // At 0.72 with a CONSTANT +0.42 skyward bias the volume normal was
        // flattening the very gradient it exists to create: the sunlit top of a
        // crown shaded the same value as its underside and the canopy read as a
        // two-tone stencil. The bias is now proportional to how high the card
        // sits in the crown, so only the upper cards face the sky and the mass
        // carries a real light-direction gradient top to bottom.
        vN = normalize(mix(cardN, volN, 0.90) + vec3(0.0, 0.10 + 0.52 * vUp, 0.0));
        vT = normalize(mat3(modelMatrix) * (mat3(instanceMatrix) * vec3(1.0, 0.0, 0.0)) + vec3(0.0, 0.12, 0.0));
        vWPos = wpos;
        vRand = aRand;

        vec3 shadowPos = wpos;
        vec3 shadowNrm = vN;
        ${SHADOW_VERT}

        vec4 mvPosition = viewMatrix * vec4(wpos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      ${SHADOW_PARS_FRAG}
      ${LIGHT_PARS}
      ${JITTER}
      #include <fog_pars_fragment>
      uniform sampler2D uMap;
      uniform vec2 uAerial;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vT;
      varying vec3 vWPos;
      varying float vRand;
      varying float vOut;
      varying float vUp;

      void main() {
        // -0.9 instead of -0.4: a crown has to dissolve into leaf-scale detail
        // at range, not into chunky angular polygon shards several pixels wide.
        vec4 tex = texture2D(uMap, vUv, -0.9);
        // Same distance-blended cutout as the cover cards. The hard fwidth step
        // is right within a few tens of metres and is exactly what produces the
        // crunchy 1-bit speckled crown edges at treeline range.
        float dCam = distance(cameraPosition, vWPos);
        float aSharp = (tex.a - 0.42) / max(fwidth(tex.a), 1e-4) + 0.5;
        float aSoft = smoothstep(0.40, 0.52, tex.a);
        if (mix(aSharp, aSoft, smoothstep(45.0, 90.0, dCam)) < 0.5) discard;

        vec3 albedo = vegJitter(tex.rgb, vRand);
        // Albedo floor with a real BLUE component: the baked cluster underlayer
        // is deliberately dark, and with no blue in it the sky ambient had
        // nothing to light, which is why interior canopy went to RGB 0. Raised
        // in cycle 4 so no crown pixel can resolve below the ambient — a third
        // of the crowns were rendering as near-black masses beside mid-green
        // neighbours in the same treeline, which no sunlit woodland ever shows.
        albedo = max(albedo, vec3(0.110, 0.130, 0.100));

        // Interior of the crown is occluded; the outside catches the sky, and
        // the top of the crown catches more than the underside. The floor came
        // up with the albedo floor: at 0.44 it compounded with the value jitter
        // into the second population of black crowns.
        float ao = (0.60 + 0.40 * pow(vOut, 0.8)) * (0.86 + 0.20 * vUp);
        vec3 V = normalize(cameraPosition - vWPos);
        // Two-sided leaf transmission: a backlit canopy glows warm-green rather
        // than going black, which is the strongest single cue the reference has.
        vec3 col = vegLight(albedo, normalize(vN), V, normalize(vT), vegShadow(),
                            0.70 + 0.70 * vOut, ao, 0.18 + 0.32 * vOut, 1.0);

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // Extra aerial perspective: without it a treeline at 400 m stays darker
        // and more saturated than the terrain behind it, which is backwards.
        float ap = smoothstep(uAerial.x, uAerial.y, distance(cameraPosition, vWPos)) * 0.72;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, ap);
        #include <fog_fragment>
      }
    `,
  });
  mat.uniforms.uMap.value = o.atlas;
  return mat;
}

/**
 * Depth-pass twin for the foliage cards. three's auto-generated depth material
 * knows nothing about the per-instance atlas tile or the canopy sway, so it
 * would cast SOLID RECTANGLES for every leaf cluster. Sharing uTime with the
 * beauty material keeps the shadow welded to the crown.
 */
export function foliageDepthMaterial(o: FoliageOpts, timeUniform: THREE.IUniform): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: timeUniform,
      uMap: { value: o.atlas },
      uTileStep: { value: 1 / o.tiles },
      uWindAmp: { value: o.windAmp },
    },
    vertexShader: /* glsl */ `
      ${NOISE}
      ${WIND}
      uniform float uTime;
      uniform float uTileStep;
      uniform float uWindAmp;
      attribute float aRand;
      attribute float aTile;
      attribute vec4 aCore;
      varying vec2 vUv;
      void main() {
        float flip = step(0.5, fract(aRand * 5.77));
        float u = mix(uv.x, 1.0 - uv.x, flip);
        vUv = vec2((mix(0.006, 0.994, u) + aTile) * uTileStep, uv.y);
        vec3 wpos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
        float lift = clamp((wpos.y - aCore.y) / max(aCore.w, 0.2) * 0.4 + 0.6, 0.0, 1.5);
        wpos.xz += vegWind(aCore.xyz, uTime, aRand, uWindAmp) * lift;
        gl_Position = projectionMatrix * viewMatrix * vec4(wpos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      void main() {
        if (texture2D(uMap, vUv).a < 0.42) discard;
        gl_FragColor = vec4(1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Ground carpet
// ---------------------------------------------------------------------------

export interface CarpetOpts extends VegLightParams {
  canopy: THREE.Texture;
  /** Radius at which the carpet has faded out entirely. */
  radius: number;
}

/**
 * A camera-following sheet hugging the terrain, textured with a top-down grass
 * canopy and modulated by the same coverage mask the instances use.
 *
 * This is what makes the world read as vegetated rather than as a small carpet
 * of tufts on an empty plain: the instanced rings can now end anywhere, because
 * the ground under them is already grass-coloured and grass-textured.
 *
 * It is also, since cycle 3, the ONLY ground-contact occlusion in the build:
 * an aShade channel rasterised from the tree and bush positions darkens the
 * sheet under every canopy and every dense thicket, so trunks stop reading as
 * pasted onto a uniformly lit plane. That is deliberately done here rather than
 * with decals — a decal per tree is 3000 blended quads, this is free.
 */
export function carpetMaterial(o: CarpetOpts): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    lights: true,
    fog: true,
    // DoubleSide, and the fan is now wound the right way round in
    // Vegetation.buildCarpet. THIS is why the sheet never appeared: the ring
    // fan was indexed (a, c, b), whose right-hand normal points DOWN, so with
    // FrontSide every triangle of the ground carpet was back-face-culled from
    // any camera above it. It has never drawn, at any distance, since it was
    // written — which is the whole of "the ground is brighter than the plants
    // standing on it", because the layer that owns ground colour, density
    // occlusion and tree contact pools was simply not in the frame.
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    uniforms: baseUniforms(o, {
      uMap: { value: null },
      uRadius: { value: o.radius },
      uScale: { value: 3.2 },
      // Calibrates the sheet's ABSOLUTE value. Nothing could calibrate it
      // before cycle 4, because the sheet was back-face-culled and had never
      // appeared in a frame at all.
      uGain: { value: 2.6 },
    }),
    vertexShader: /* glsl */ `
      ${SHADOW_PARS_VERT}
      #include <fog_pars_vertex>
      attribute float aCov;
      attribute float aDry;
      attribute float aShade;
      attribute vec3 aTint;
      varying vec3 vN;
      varying vec3 vWPos;
      varying float vCov;
      varying float vDry;
      varying float vShade;
      varying vec3 vTint;

      void main() {
        vec3 wpos = (modelMatrix * vec4(position, 1.0)).xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vWPos = wpos;
        vCov = aCov;
        vDry = aDry;
        vShade = aShade;
        vTint = aTint;

        // A large, near-flat receiver needs a much bigger normal offset than the
        // shared 0.35 m cap the sun's single whole-frustum map hands out, or the
        // depth compare lands inside its own texel error and the sheet breaks
        // into hard black blotches. 0.55 m along the surface normal shifts a
        // shadow edge by under a metre on the ground and removes them entirely.
        vec3 shadowPos = wpos + vN * 0.55;
        vec3 shadowNrm = vN;
        ${SHADOW_VERT}

        vec4 mvPosition = viewMatrix * vec4(wpos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      ${SHADOW_PARS_FRAG}
      ${LIGHT_PARS}
      ${JITTER}
      #include <fog_pars_fragment>
      uniform sampler2D uMap;
      uniform float uRadius;
      uniform float uScale;
      uniform float uGain;
      varying vec3 vN;
      varying vec3 vWPos;
      varying float vCov;
      varying float vDry;
      varying float vShade;
      varying vec3 vTint;

      void main() {
        float cov = vCov;
        // Contact pools under trees and thickets survive even where the
        // coverage mask is thin — bare soil under a canopy still darkens.
        if (cov < 0.02 && vShade < 0.05) discard;
        float d = distance(cameraPosition.xz, vWPos.xz);
        // Two texture scales beat the single-period repeat that a ground-hugging
        // sheet would otherwise show as a visible grid from any elevation. At
        // uScale 0.62 the period was 1.6 m, which IS the metre-scale cream/lime
        // blob pattern the critics read in the crop; 3.2 puts it at ~31 cm.
        // The coarse octave is weighted in with distance so the far field gets
        // low-frequency break-up instead of aliasing into noise.
        vec4 t0 = texture2D(uMap, vWPos.xz * uScale);
        vec4 t1 = texture2D(uMap, vWPos.xz * uScale * 0.31 + 0.37);
        vec4 tex = mix(t0, t1, 0.30 + 0.45 * smoothstep(20.0, 90.0, d));

        float rim = 1.0 - smoothstep(uRadius * 0.72, uRadius, d);
        // Alpha runs deliberately hot. The terrain plate between the blades is
        // a bright yellow-green mottle that does NOT match the ochre sward, and
        // the carpet is the only surface this lane owns that can cover it — so
        // it has to actually cover it, not veil it.
        float a = min(1.0, max(tex.a * 1.30 + 0.56, vShade * 0.95) * cov * rim * 1.70);
        if (a < 0.012) discard;

        // Ground tint keeps the carpet inside the terrain's own palette, so it
        // reads as the field's canopy rather than as a green decal on top. It
        // also has to follow DRYNESS: a green carpet under straw instances is
        // the same "sticker" failure the tufts had, one layer down.
        vec3 albedo = mix(tex.rgb, tex.rgb * vec3(1.26, 1.04, 0.86), vDry) * uGain;
        albedo = vegGroundPull(albedo, vTint, 3.0, 0.30);
        // The two multipliers that stop the sward reading as pasted onto a lit
        // plane: density-driven occlusion, and the tree/bush contact pool.
        // Hard density occlusion. Measured on the cycle-3 stills the sheet was
        // rendering BRIGHTER than the sward standing on it, which inverts the
        // reference completely: under a dense sward the ground drops well below
        // the open-ground value, and a floor lighter than its own grass is the
        // main reason the fields read chalky and weightless.
        // 0.22, not 0.40: a dense sward floor has to sit WELL below the blades
        // it carries. Ground under a canopy is the most occluded surface in the
        // scene and every frame in cycle 3 had it as the brightest.
        // Well below the blades it carries, but a field floor is soil in shade,
        // NOT a hole. The four multipliers below (coverage occlusion, contact
        // shade, AO and the hemisphere attenuation) all land on the same
        // fragment, so each one has to be gentle or they compound: a layer-coded
        // probe capture caught the first calibration of this sheet rendering at
        // 11-19/255 and reading as hard black blobs scattered over the sward.
        // The target is ~0.55-0.60 of the lit grass value in the open.
        albedo *= mix(1.0, 0.55, clamp(cov, 0.0, 1.0));
        albedo *= 1.0 - vShade * 0.42;
        vec3 V = normalize(cameraPosition - vWPos);
        // A ground sheet does not glow: transmission near zero. The hemisphere
        // fill is attenuated by coverage for the same reason as the albedo —
        // the floor of a closed sward sees very little sky.
        vec3 col = vegLight(albedo, normalize(vN), V, vec3(0.0, 1.0, 0.0), vegShadow(), 0.08,
                            0.85 - vShade * 0.20, 0.0, mix(1.0, 0.75, clamp(cov, 0.0, 1.0)));

        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
  mat.uniforms.uMap.value = o.canopy;
  return mat;
}
