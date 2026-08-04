import * as THREE from 'three';
import type { MaterialRecipe } from '../gen/texgen';

// Weapon surface recipes — separate file from materials/library.ts on purpose:
// the terrain stream owns that file; the weapon stream owns this one.
//
// Both recipes author their detail ELONGATED ALONG U, and vm-geometry lays every
// part out with u running down the part's length at a fixed repeats-per-metre.
// So wood grain runs along the handguard/stock and metal tool marks run along
// the receiver, at one consistent texel density from the 0.5 m barrel to a 4 mm
// rivet — instead of BoxGeometry's 0..1-per-face UVs, which stretched the same
// tile over every part regardless of size.
//
// Anisotropic noise rule (see materials/library.ts): when the two axis scales
// differ, the SMALLER one is the lattice period and the larger must be an
// integer multiple of it, or the bake stops tiling.
//
// FREQUENCY BUDGET: the viewmodel is on screen 100% of the time and is the
// closest surface in the game, so these bakes run at 1024 (not the 512 a world
// surface gets) and every detail term is held at >= 12 texels per cycle. Detail
// authored at Nyquist in the bake (the old pore at 32 cycles/period = 4 texels)
// is erased by mip 1, and a first-person weapon is seen almost entirely down
// its own length where high mips dominate no matter what the anisotropy is.

// SCREEN-FREQUENCY BUDGET (cycle 3). A viewmodel surface's on-screen detail
// period is  bakeCycles/1024 texels  x  tilesPerMetre  x  metresPerPixel, and
// the cycle-2 metal bake ran its grit layer at 30 cycles per period unit = 180
// cycles across the 1024 bake = 5.7 TEXELS per lattice cell. Value noise at 5.7
// texels shows its own lattice, and at viewmodel magnification that lattice
// landed at a 3-4 screen-pixel period across the whole gun: an axis-aligned
// cross-hatch that reads as window screen, not gunmetal. Nothing here now runs
// under ~19 texels per cycle for a value-noise lattice or ~9 for a ridged line.

export const gunMetalRecipe: MaterialRecipe = {
  name: 'gunMetal',
  period: 6,
  normalStrength: 0.22,
  aoStrength: 0.7,
  size: 1024,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;

  // Phosphate tooth: the fine matte crystal structure of a parkerized finish.
  // It must stay a ROUGHNESS story, not an albedo one — pushing it into albedo
  // is what turned the receiver into reptile skin. Held at 5 cycles per period
  // unit (top fbm octave = 20, i.e. 120 across the bake, ~8.5 texels/cycle).
  float tooth = fbm(p * 5.0, uPeriod * 5.0, 3, 0.5);
  float grit = vnoise(p * 9.0, uPeriod * 9.0);

  // Handling wear. Kept deliberately rare (a few per cent of the surface):
  // bare steel is far brighter than the finish, so anything generous here
  // reads as galvanised sheet rather than a blued rifle. The burnish blotches
  // are down to a quarter of their old weight — at cycle-2 contrast they read
  // as paint spatter thrown across the receiver.
  float worn = wfbm(p * 2.0, uPeriod * 2.0, 1.5, 3);
  float draw = ridged(vec2(p.x * 1.5, p.y * 12.0), uPeriod * 1.5, 3);
  float scratch = smoothstep(0.962, 0.999, ridged(vec2(p.x * 2.0, p.y * 18.0), uPeriod * 2.0, 2));
  float burnish = smoothstep(0.78, 0.96, worn) * (0.3 + draw * 0.45);
  float wear = clamp(burnish * 0.2 + scratch * 0.7, 0.0, 1.0);

  // Parkerizing is a phosphate CONVERSION COATING, not bare metal: it keeps a
  // real diffuse floor and only a partial metallic response. Authoring it as
  // near-black at metalness 0.9 removed the diffuse term entirely, which left
  // the whole receiver riding on grazing-angle specular — i.e. a black cut-out
  // with no plane separation between dust cover, gas tube and barrel.
  vec3 park = vec3(0.132, 0.128, 0.121);
  vec3 steel = vec3(0.40, 0.405, 0.415);
  albedo = mix(park, steel, wear);
  // Keep the tooth mostly OUT of albedo. At viewmodel scale its cycle lands
  // near a pixel, and an albedo term at that frequency aliases into sandpaper
  // speckle instead of reading as a fine matte finish.
  albedo *= 0.96 + tooth * 0.07;

  height = 0.5 + tooth * 0.1 + draw * 0.04 - scratch * 0.22;
  rough = mix(0.58 - tooth * 0.12, 0.34, wear) + grit * 0.03;
  metal = mix(0.35, 0.90, wear);
}
`,
};

export const gunWoodRecipe: MaterialRecipe = {
  name: 'gunWood',
  period: 4,
  normalStrength: 0.3,
  aoStrength: 0.7,
  size: 1024,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;

  // Russian arsenal laminate: plywood layers pressed and dyed red-amber. The
  // layers are bands across v; the grain fibres stretch along u (1 : 10 : 18).
  //
  // CYCLE-3 RE-CUT. The cycle-2 palette rendered at roughly #B05F3F — a
  // high-chroma terracotta that was the loudest colour anywhere in an
  // otherwise muted frame, and it read as painted plastic rather than as
  // laminate. Base chroma is down ~35% and value ~25%, landing the RENDERED
  // furniture (which the camera-parented key rig brightens ~1.5x over albedo)
  // near the reference's #7A4A32. A low-frequency length-wise value multiply
  // was added on top: the old furniture held one flat value from ferrule to
  // ferrule, and real laminate never does.
  float layer = fbm(vec2(p.x * 1.0, p.y * 8.0), uPeriod, 3, 0.55);
  float fibre = fbm(vec2(p.x * 1.5, p.y * 15.0), uPeriod * 1.5, 3, 0.5);
  float pore = ridged(vec2(p.x * 2.0, p.y * 18.0), uPeriod * 2.0, 2);
  float sweepv = fbm(vec2(p.x * 2.0, p.y * 2.0), uPeriod * 2.0, 2, 0.5);
  float band = smoothstep(0.28, 0.72, layer);

  // Lacquer: shine pools on the flats, breaks up where the finish is rubbed.
  float rub = smoothstep(0.66, 0.94, wfbm(p * 2.5, uPeriod * 2.5, 1.3, 3));
  float ding = smoothstep(0.95, 1.0, ridged(p * 7.0, uPeriod * 7.0, 2));

  vec3 deep = vec3(0.135, 0.085, 0.062);
  vec3 mid = vec3(0.245, 0.155, 0.112);
  vec3 amber = vec3(0.335, 0.215, 0.155);
  albedo = mix(deep, mid, band);
  albedo = mix(albedo, amber, fibre * fibre * 0.72);
  albedo = mix(albedo, deep * 0.86, pore * 0.34);
  albedo = mix(albedo, mid * 1.12, rub * 0.3);
  albedo = mix(albedo, vec3(0.115, 0.072, 0.055), ding * 0.5);
  albedo *= 0.86 + sweepv * 0.30;

  height = 0.5 + layer * 0.08 + fibre * 0.04 - pore * 0.12 - ding * 0.26;
  rough = 0.4 + rub * 0.24 + pore * 0.1 + ding * 0.18;
  metal = 0.0;
}
`,
};

/**
 * Shooting glove — matte olive-brown leather/nomex with raised knuckle panels.
 *
 * TWO CYCLE-2 FAILURES ARE FIXED HERE. (1) The weave ran at 10 cycles per
 * period unit and vm-hands tiled it at 10 repeats/metre, which put a regular
 * cross-hatch at roughly 2 SCREEN PIXELS on a support hand 25 cm from the eye —
 * a moiring checkerboard that reads as a UV-debug texture shipping in a
 * marketing frame. It now runs at 4 and is tiled at 4/m. (2) The glove was
 * authored within 5% of the receiver's albedo, so the hand had no value step
 * against the metal it was wrapped around and read as more gun. It is now
 * ~1.8x the parkerizing's value and clearly warmer.
 */
export const gunGloveRecipe: MaterialRecipe = {
  name: 'gunGlove',
  period: 4,
  normalStrength: 0.2,
  aoStrength: 0.85,
  size: 512,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;

  // Weave: two exact-integer cosine runs, so it tiles by construction. 4 per
  // period unit = 16 cycles over the bake = ~32 texels per cycle.
  float warp = 0.5 + 0.5 * cos(p.x * 4.0 * 6.2831853);
  float weft = 0.5 + 0.5 * cos(p.y * 4.0 * 6.2831853);
  float weave = warp * 0.55 + weft * 0.45;
  float grain = fbm(p * 6.0, uPeriod * 6.0, 3, 0.5);
  float panel = smoothstep(0.42, 0.86, fbm(p * 3.0, uPeriod * 3.0, 2, 0.5));

  // Light enough to hold shape against a sunlit background: a 0.05 albedo
  // glove is a silhouette, and a silhouette on the handguard reads as a hole
  // in the gun rather than a hand on it.
  // Value is set against the RENDERED receiver, not against its albedo: the
  // metal runs metalness 0.35-0.9 so most of its albedo never reaches the
  // diffuse term, while the glove at metalness 0 keeps all of it. Authored at
  // 0.196 the glove measured luma 102 against the receiver's 24 and read as
  // bare cream plastic. ~0.10 puts it around 2x the receiver — a clear value
  // step, which is what the reference shows, without becoming the brightest
  // object in the frame.
  vec3 leather = vec3(0.098, 0.089, 0.076);
  vec3 pad = vec3(0.128, 0.115, 0.096);
  albedo = mix(leather, pad, panel * 0.55);
  albedo *= 0.97 + weave * 0.035 + grain * 0.06;

  height = 0.5 + weave * 0.08 + panel * 0.12 - grain * 0.06;
  rough = 0.9 - panel * 0.14 - weave * 0.04;
  metal = 0.0;
}
`,
};

export interface VmSurfaceOpts {
  /** Cache key suffix — must differ per distinct patch configuration. */
  key: string;
  /** Sky-tinted fresnel rim so the silhouette reads against bright terrain. */
  rimColor: number;
  rimStrength: number;
  /** How much the per-vertex edge-wear term polishes (>0) or dulls (<0). */
  wearRough: number;
  /** Horizon-occlusion knee: specular fades below this N·V. Higher = darker
   *  grazing surfaces. 0 disables. */
  grazeKnee: number;
  /** Horizon-occlusion floor for a fully ROUGH surface (polished surfaces keep
   *  more; see below). */
  grazeFloor: number;
  /** Rig key/fill weight — 1 = the standard camera-parented viewmodel rig. */
  rigStrength: number;
  /** Weight on the rig's specular lobe (metal wants more than wood). */
  rigSpecular: number;
  /**
   * SHARED uniform object, one per rig, driven from viewmodel.ts. 1 = the rig
   * at full strength; it ducks toward ~0.35 while the muzzle flash's own light
   * is up so the two keys do not stack into a uniform white band across the
   * whole weapon. Passing the uniform object itself (rather than a value) is
   * what lets one assignment reach all three materials.
   */
  keyScale: THREE.IUniform<number>;
}

/**
 * Viewmodel surface patch. Three jobs, all of them things a world surface does
 * not need and a first-person weapon cannot ship without.
 *
 * 1. EDGE WEAR. vm-geometry writes an edge-wear weight into vertex colours (>1
 *    on bevels, rims and corners); the base shader would only use that to
 *    brighten albedo, which on a metal reads as "lighter paint" rather than
 *    "burnished steel". This routes the same term into roughness.
 *
 * 2. HORIZON OCCLUSION. The player looks down the length of the gun, so most of
 *    its visible area sits at 80-89 degrees of incidence, where the specular
 *    term runs to f90 = 1 no matter how dark and rough the base material is — a
 *    black parkerised receiver renders as polished chrome. Real surfaces lose
 *    that energy to self-shadowing at those angles. The floor is now
 *    ROUGHNESS-AWARE: rough parkerizing loses energy, but a burnished edge or a
 *    lacquered flat keeps its highlight, which is what stops the whole gun
 *    flattening into a silhouette.
 *
 * 3. A CAMERA-PARENTED LIGHT RIG, in view space, inside the shader. A viewmodel
 *    lit only by the world sun loses all form the moment the player turns away
 *    from it. Every shipped FPS carries its own weapon lights; doing it as
 *    shader math rather than real THREE lights means zero extra draw cost and
 *    zero chance of the rig leaking onto world geometry.
 */
export function applyViewmodelSurface(mat: THREE.MeshStandardMaterial, o: VmSurfaceOpts): void {
  mat.vertexColors = true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uVmRim = { value: new THREE.Color(o.rimColor) };
    shader.uniforms.uVmRimStrength = { value: o.rimStrength };
    shader.uniforms.uVmWearRough = { value: o.wearRough };
    shader.uniforms.uVmGraze = { value: o.grazeKnee };
    shader.uniforms.uVmFloor = { value: o.grazeFloor };
    // Near-neutral key: a warm rig on top of an already-warm sun pushed the
    // laminate furniture into saturated terracotta.
    shader.uniforms.uVmKey = { value: new THREE.Color(0xfaf6ee).multiplyScalar(5.2 * o.rigStrength) };
    shader.uniforms.uVmFill = { value: new THREE.Color(0xb2c4d4).multiplyScalar(1.5 * o.rigStrength) };
    shader.uniforms.uVmSpecW = { value: o.rigSpecular };
    shader.uniforms.uVmKeyScale = o.keyScale;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uVmRim;
        uniform float uVmRimStrength;
        uniform float uVmWearRough;
        uniform float uVmGraze;
        uniform float uVmFloor;
        uniform vec3 uVmKey;
        uniform vec3 uVmFill;
        uniform float uVmSpecW;
        uniform float uVmKeyScale;`
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        if (uVmGraze > 0.0) {
          float vmNV = abs(dot(geometryNormal, geometryViewDir));
          float vmFloor = mix(uVmFloor, 0.8, 1.0 - roughnessFactor);
          float vmHorizon = mix(vmFloor, 1.0, smoothstep(0.0, uVmGraze, vmNV));
          reflectedLight.directSpecular *= vmHorizon;
          reflectedLight.indirectSpecular *= vmHorizon;
        }
        // Sky/ground split on the AMBIENT term. A weapon held at arm's length
        // is a cave for the lower hemisphere: without this every plane on it
        // picks up the same probe energy and the dust cover, gas tube, barrel
        // and handguard all resolve to one flat grey mass with no separation
        // between them. Cheap, and it is the single biggest readability win on
        // a part this cluttered.
        float vmSky = 0.34 + 0.66 * (geometryNormal.y * 0.5 + 0.5);
        reflectedLight.indirectDiffuse *= vmSky;
        reflectedLight.indirectSpecular *= 0.5 + 0.5 * vmSky;
        // Camera-parented rig: constant directions in VIEW space, so the gun is
        // lit the same way whichever way the player faces. Added after the
        // horizon term on purpose — this rig is 40 cm from the surface, and
        // horizon occlusion is the right model for a distant sky probe and the
        // wrong one for a light in the shooter's own hands.
        vec3 vmKeyL = normalize(vec3(-0.46, 0.70, 0.55));
        vec3 vmFillL = normalize(vec3(0.62, -0.30, 0.44));
        float vmKd = max(dot(geometryNormal, vmKeyL), 0.0);
        float vmFd = max(dot(geometryNormal, vmFillL), 0.0);
        reflectedLight.directDiffuse +=
          uVmKeyScale * (uVmKey * vmKd + uVmFill * vmFd) * BRDF_Lambert(material.diffuseContribution);
        // THE RIG'S SPECULAR LOBE IS CLAMPED, and this is not cosmetic.
        // Unclamped, the normalisation factor (vmPow+8)/25.13 reaches 41 at the
        // roughness floor the edge-wear term drives bevels to, and 41 x a 5.2x
        // key is a 170x highlight — which is exactly the hot white line that ran
        // the whole length of barrel AND receiver at CONSTANT intensity in
        // cycle 2, blowing a matte black receiver to pure white on an edge it
        // physically cannot produce. Fired-state highlights are the muzzle
        // light's job now (fx.ts), not a fixed rig's.
        vec3 vmH = normalize(vmKeyL + geometryViewDir);
        float vmA = max(roughnessFactor * roughnessFactor, 0.0256);
        float vmPow = clamp(2.0 / (vmA * vmA) - 2.0, 2.0, 220.0);
        float vmSpec = min(pow(max(dot(geometryNormal, vmH), 0.0), vmPow) * (vmPow + 8.0) / 25.13, 6.0);
        reflectedLight.directSpecular +=
          material.specularColorBlended * (uVmKeyScale * uVmKey * (vmSpec * vmKd * uVmSpecW));`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float vmWear = clamp((vColor.r - 1.0) * 2.2, 0.0, 1.0);
        // Floor raised 0.05 -> 0.16: below that the rig's specular exponent hits
        // its ceiling and every worn bevel on the gun turns mirror.
        roughnessFactor = clamp(roughnessFactor - vmWear * uVmWearRough, 0.16, 1.0);
        // The viewmodel draws in the TRANSPARENT queue (it owns the last depth
        // range in the frame — see viewmodel.ts), and the baked albedo carries
        // HEIGHT in its alpha channel. Without this the gun would render at
        // ~50% opacity.
        diffuseColor.a = 1.0;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // Rim light gated on SMOOTHNESS. A constant-strength fresnel rim is a
        // view-dependent term applied at fixed weight, which is why a matte
        // black receiver showed a pure-white edge line: matte surfaces have no
        // grazing lobe tight enough to produce one. (1 - rough)^4 kills it on
        // anything above ~0.45 roughness and leaves it for burnished edges.
        float vmRimGate = clamp(pow(max(0.0, 1.0 - roughnessFactor), 4.0) * 3.0, 0.0, 1.0);
        float vmFres = saturate(1.0 - abs(dot(normal, normalize(vViewPosition))));
        totalEmissiveRadiance += uVmRim * (pow(vmFres, 4.0) * uVmRimStrength * vmRimGate);`
      );
  };
  mat.customProgramCacheKey = () => `vm-${o.key}`;
}
