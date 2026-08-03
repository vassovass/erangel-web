import * as THREE from 'three';
import { quality } from '../core/settings';

/**
 * GPU texture baker. Each material recipe is a GLSL snippet implementing:
 *
 *   void materialSample(in vec2 uv, out vec3 albedo, out float height,
 *                       out float rough, out float metal);
 *
 * (albedo authored in sRGB "artist" values). The factory bakes four passes:
 *   1. albedo+height   -> sRGB RT (height in linear alpha)
 *   2. rough+metal     -> temp linear RT
 *   3. normal map      -> sobel over height
 *   4. ORM             -> r: AO derived from height, g: rough, b: metal
 *
 * All noise in the GLSL library is PERIODIC (integer lattice mod uPeriod) so
 * every baked texture tiles seamlessly with plain RepeatWrapping.
 */

export interface MaterialRecipe {
  name: string;
  glsl: string;
  size?: number;
  /** Multiplier on the sobel step when deriving the normal map. */
  normalStrength?: number;
  /** Strength of the height-derived AO term, 0..1. */
  aoStrength?: number;
  /** Base tiling period for the noise lattice (must be a positive integer). */
  period?: number;
}

export interface PbrMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** r: AO, g: roughness, b: metalness — assign as aoMap+roughnessMap+metalnessMap. */
  orm: THREE.Texture;
}

/** Shared GLSL noise/pattern library injected into every recipe shader. */
export const GLSL_LIB = /* glsl */ `
uniform float uPeriod;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec2 pmod(vec2 p, float period) { return mod(mod(p, period) + period, period); }

// Periodic value noise, tiles at 'period' lattice cells.
float vnoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(pmod(i, period));
  float b = hash12(pmod(i + vec2(1.0, 0.0), period));
  float c = hash12(pmod(i + vec2(0.0, 1.0), period));
  float d = hash12(pmod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Periodic fBm, output [0,1].
float fbm(vec2 p, float period, int octaves, float gain) {
  float sum = 0.0, amp = 0.5, freq = 1.0, per = period;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise(p * freq, per);
    freq *= 2.0; per *= 2.0; amp *= gain;
  }
  return sum;
}

// Ridged periodic fbm, output [0,1] — sharp creases.
float ridged(vec2 p, float period, int octaves) {
  float sum = 0.0, amp = 0.5, freq = 1.0, per = period;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(vnoise(p * freq, per) * 2.0 - 1.0);
    sum += amp * n * n;
    freq *= 2.0; per *= 2.0; amp *= 0.5;
  }
  return sum;
}

// Domain-warped fbm for organic patchiness.
float wfbm(vec2 p, float period, float warp, int octaves) {
  vec2 w = vec2(fbm(p + 3.1, period, 3, 0.5), fbm(p + 17.7, period, 3, 0.5));
  return fbm(p + (w - 0.5) * warp, period, octaves, 0.5);
}

// Periodic voronoi: returns (F1, F2, cellRandom).
vec3 voronoi(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = pmod(i + g, period);
      vec2 o = hash22(cell);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = hash12(cell); }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

// Brick/plank grid helper: returns (mortarMask 0..1, brickRandom, brickUv.x, brickUv.y)
vec4 brickGrid(vec2 uv, vec2 count, float offsetEvery, float mortarWidth) {
  vec2 p = uv * count;
  float row = floor(p.y);
  p.x += mod(row, offsetEvery) / offsetEvery;
  vec2 cell = floor(p);
  vec2 f = fract(p);
  float mx = smoothstep(0.0, mortarWidth, f.x) * smoothstep(1.0, 1.0 - mortarWidth, f.x);
  float my = smoothstep(0.0, mortarWidth * count.x / count.y, f.y) * smoothstep(1.0, 1.0 - mortarWidth * count.x / count.y, f.y);
  return vec4(mx * my, hash12(pmod(cell, max(count.x, count.y))), f.x, f.y);
}

vec3 srgb2lin(vec3 c) { return pow(c, vec3(2.2)); }
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

function recipeFragment(glsl: string): string {
  return /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform int uMode;
${GLSL_LIB}
${glsl}
void main() {
  vec3 albedo; float height; float rough; float metal;
  materialSample(vUv, albedo, height, rough, metal);
  if (uMode == 0) {
    gl_FragColor = vec4(srgb2lin(albedo), clamp(height, 0.0, 1.0));
  } else {
    gl_FragColor = vec4(clamp(rough, 0.02, 1.0), clamp(metal, 0.0, 1.0), 0.0, 1.0);
  }
}
`;
}

const NORMAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uHeight;   // height in alpha
uniform float uTexel;
uniform float uStrength;
void main() {
  float hL = texture2D(uHeight, vUv + vec2(-uTexel, 0.0)).a;
  float hR = texture2D(uHeight, vUv + vec2(uTexel, 0.0)).a;
  float hD = texture2D(uHeight, vUv + vec2(0.0, -uTexel)).a;
  float hU = texture2D(uHeight, vUv + vec2(0.0, uTexel)).a;
  vec3 n = normalize(vec3((hL - hR) * uStrength, (hD - hU) * uStrength, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;

const ORM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uHeight;   // height in alpha
uniform sampler2D uRM;       // r: rough, g: metal
uniform float uTexel;
uniform float uAoStrength;
void main() {
  float h = texture2D(uHeight, vUv).a;
  // Multi-scale cavity AO: how far below the local neighbourhood is this texel.
  float ao = 0.0;
  float radii[3];
  radii[0] = 2.0; radii[1] = 6.0; radii[2] = 14.0;
  for (int r = 0; r < 3; r++) {
    float rad = radii[r] * uTexel;
    float avg = 0.0;
    avg += texture2D(uHeight, vUv + vec2(rad, 0.0)).a;
    avg += texture2D(uHeight, vUv + vec2(-rad, 0.0)).a;
    avg += texture2D(uHeight, vUv + vec2(0.0, rad)).a;
    avg += texture2D(uHeight, vUv + vec2(0.0, -rad)).a;
    avg += texture2D(uHeight, vUv + vec2(rad, rad) * 0.707).a;
    avg += texture2D(uHeight, vUv + vec2(-rad, rad) * 0.707).a;
    avg += texture2D(uHeight, vUv + vec2(rad, -rad) * 0.707).a;
    avg += texture2D(uHeight, vUv + vec2(-rad, -rad) * 0.707).a;
    avg *= 0.125;
    ao += max(0.0, avg - h);
  }
  float aoTerm = clamp(1.0 - ao * 2.2 * uAoStrength, 0.0, 1.0);
  vec2 rm = texture2D(uRM, vUv).rg;
  gl_FragColor = vec4(aoTerm, rm.r, rm.g, 1.0);
}
`;

export class TextureFactory {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private baked = new Map<string, PbrMaps>();

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: 'void main(){gl_FragColor=vec4(1.0);}' })
    );
    this.scene.add(this.quad);
  }

  get(name: string): PbrMaps {
    const maps = this.baked.get(name);
    if (!maps) throw new Error(`Material '${name}' not baked`);
    return maps;
  }

  bake(recipe: MaterialRecipe): PbrMaps {
    const cached = this.baked.get(recipe.name);
    if (cached) return cached;

    const size = recipe.size ?? quality.textureSize;
    const period = recipe.period ?? 8;

    const makeRT = (srgb: boolean) => {
      const rt = new THREE.WebGLRenderTarget(size, size, {
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
        colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
        depthBuffer: false,
      });
      rt.texture.anisotropy = quality.anisotropy;
      return rt;
    };

    const albedoRT = makeRT(true);
    const rmRT = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false });
    const normalRT = makeRT(false);
    const ormRT = makeRT(false);

    const recipeMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: recipeFragment(recipe.glsl),
      uniforms: { uMode: { value: 0 }, uPeriod: { value: period } },
    });

    // Pass 1: albedo + height
    this.quad.material = recipeMat;
    recipeMat.uniforms.uMode.value = 0;
    this.renderer.setRenderTarget(albedoRT);
    this.renderer.render(this.scene, this.camera);

    // Pass 2: rough + metal
    recipeMat.uniforms.uMode.value = 1;
    this.renderer.setRenderTarget(rmRT);
    this.renderer.render(this.scene, this.camera);

    // Pass 3: normal from height
    const normalMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: NORMAL_FRAG,
      uniforms: {
        uHeight: { value: albedoRT.texture },
        uTexel: { value: 1 / size },
        uStrength: { value: (recipe.normalStrength ?? 1.0) * size * 0.012 },
      },
    });
    this.quad.material = normalMat;
    this.renderer.setRenderTarget(normalRT);
    this.renderer.render(this.scene, this.camera);

    // Pass 4: ORM (AO from height + rough/metal)
    const ormMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: ORM_FRAG,
      uniforms: {
        uHeight: { value: albedoRT.texture },
        uRM: { value: rmRT.texture },
        uTexel: { value: 1 / size },
        uAoStrength: { value: recipe.aoStrength ?? 1.0 },
      },
    });
    this.quad.material = ormMat;
    this.renderer.setRenderTarget(ormRT);
    this.renderer.render(this.scene, this.camera);

    this.renderer.setRenderTarget(null);
    recipeMat.dispose();
    normalMat.dispose();
    ormMat.dispose();
    rmRT.dispose();

    const maps: PbrMaps = {
      map: albedoRT.texture,
      normalMap: normalRT.texture,
      orm: ormRT.texture,
    };
    this.baked.set(recipe.name, maps);
    return maps;
  }

  /** Builds a MeshStandardMaterial wired to a baked ORM set. */
  standard(recipe: MaterialRecipe, params: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
    const maps = this.bake(recipe);
    return new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.orm,
      metalnessMap: maps.orm,
      aoMap: maps.orm,
      roughness: 1.0,
      metalness: 1.0,
      ...params,
    });
  }
}
