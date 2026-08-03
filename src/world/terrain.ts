import * as THREE from 'three';
import { Heightfield, MAP_SIZE } from '../gen/terraingen';
import type { TextureFactory } from '../gen/texgen';
import { TERRAIN_RECIPES } from '../materials/library';
import { quality } from '../core/settings';

// Splat-blended terrain: 4x4 chunks of 128x128 quads (~524K tris before
// culling), one shared patched MeshStandardMaterial, world-XZ UVs, three
// surface categories blended by a baked 1024^2 splatmap plus a road profile in
// its alpha. Each category is sampled behind a weight branch so open fields pay
// for one category, not four.
//
// Two things kill the "procedural blanket" look here:
//   1. Stochastic sampling (Inigo Quilez): every category is fetched twice, at
//      a noise-driven offset and again rotated, blended by a low-frequency
//      mask. The texture period stops existing.
//   2. A parcel layer (uField): per-farm-cell hue, plough direction and a
//      cultivated mask, baked next to the splat. This is what makes the plains
//      read as farmland instead of noise.

const CHUNKS = 4;
const CHUNK_QUADS = 128;
const SPLAT_SIZE = 1024;

const DETAIL_TILE = 3.0;   // metres per texture repeat, close-up

export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private splatTex: THREE.DataTexture;
  private fieldTex: THREE.DataTexture;

  constructor(private hf: Heightfield, factory: TextureFactory) {
    const maps = this.buildMaps();
    this.splatTex = maps.splat;
    this.fieldTex = maps.field;
    this.material = this.buildMaterial(factory);
  }

  /** Builds chunk meshes, yielding between chunks so the loader can update. */
  async build(onProgress?: (done: number, total: number) => void): Promise<void> {
    const total = CHUNKS * CHUNKS;
    let done = 0;
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        this.group.add(this.buildChunk(cx, cz));
        done++;
        onProgress?.(done, total);
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
  }

  private buildChunk(cx: number, cz: number): THREE.Mesh {
    const chunkSize = MAP_SIZE / CHUNKS;
    const x0 = -MAP_SIZE / 2 + cx * chunkSize;
    const z0 = -MAP_SIZE / 2 + cz * chunkSize;
    const verts = CHUNK_QUADS + 1;
    const step = chunkSize / CHUNK_QUADS;

    const positions = new Float32Array(verts * verts * 3);
    const normals = new Float32Array(verts * verts * 3);
    const indices = new Uint32Array(CHUNK_QUADS * CHUNK_QUADS * 6);

    let p = 0;
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const x = x0 + i * step;
        const z = z0 + j * step;
        positions[p] = x;
        positions[p + 1] = this.hf.height(x, z);
        positions[p + 2] = z;
        const n = this.hf.normal(x, z, step * 0.75);
        normals[p] = n[0];
        normals[p + 1] = n[1];
        normals[p + 2] = n[2];
        p += 3;
      }
    }
    let q = 0;
    for (let j = 0; j < CHUNK_QUADS; j++) {
      for (let i = 0; i < CHUNK_QUADS; i++) {
        const a = j * verts + i;
        const b = a + 1;
        const c = a + verts;
        const d = c + 1;
        indices[q++] = a; indices[q++] = c; indices[q++] = b;
        indices[q++] = b; indices[q++] = c; indices[q++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = true;
    return mesh;
  }

  private makeDataTexture(data: Uint8Array): THREE.DataTexture {
    const tex = new THREE.DataTexture(data, SPLAT_SIZE, SPLAT_SIZE, THREE.RGBAFormat);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    // Mipmaps matter: without them the splat/parcel maps alias into sparkle at
    // vista range, which is exactly where the parcels have to read cleanly.
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = quality.anisotropy;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * One pass over the map producing both control textures. The height/slope
   * queries dominate the cost, so splat and parcel data share them.
   *   splat: r grass, g dirt, b rock, a road tent profile
   *   field: r parcel tone, g/b plough direction, a cultivated mask
   */
  private buildMaps(): { splat: THREE.DataTexture; field: THREE.DataTexture } {
    const sData = new Uint8Array(SPLAT_SIZE * SPLAT_SIZE * 4);
    const fData = new Uint8Array(SPLAT_SIZE * SPLAT_SIZE * 4);
    const scale = MAP_SIZE / SPLAT_SIZE;
    let p = 0;
    for (let j = 0; j < SPLAT_SIZE; j++) {
      for (let i = 0; i < SPLAT_SIZE; i++) {
        const x = -MAP_SIZE / 2 + (i + 0.5) * scale;
        const z = -MAP_SIZE / 2 + (j + 0.5) * scale;
        const s = this.hf.surface(x, z);
        sData[p] = Math.round(s.splat.grass * 255);
        sData[p + 1] = Math.round(s.splat.dirt * 255);
        sData[p + 2] = Math.round(s.splat.rock * 255);
        sData[p + 3] = Math.round(s.splat.road * 255);
        fData[p] = Math.round(s.field.tone * 255);
        fData[p + 1] = Math.round((s.field.dirX * 0.5 + 0.5) * 255);
        fData[p + 2] = Math.round((s.field.dirZ * 0.5 + 0.5) * 255);
        fData[p + 3] = Math.round(s.field.farm * 255);
        p += 4;
      }
    }
    return { splat: this.makeDataTexture(sData), field: this.makeDataTexture(fData) };
  }

  private buildMaterial(factory: TextureFactory): THREE.MeshStandardMaterial {
    const [grass, dirt, rock, road] = TERRAIN_RECIPES.map((r) => factory.bake(r));

    const mat = new THREE.MeshStandardMaterial({
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.34,
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSplat = { value: this.splatTex };
      shader.uniforms.uField = { value: this.fieldTex };
      shader.uniforms.uGrassMap = { value: grass.map };
      shader.uniforms.uDirtMap = { value: dirt.map };
      shader.uniforms.uRockMap = { value: rock.map };
      shader.uniforms.uRoadMap = { value: road.map };
      shader.uniforms.uGrassN = { value: grass.normalMap };
      shader.uniforms.uDirtN = { value: dirt.normalMap };
      shader.uniforms.uRockN = { value: rock.normalMap };
      shader.uniforms.uRoadN = { value: road.normalMap };
      shader.uniforms.uMapSize = { value: MAP_SIZE };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;'
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;
uniform sampler2D uSplat;
uniform sampler2D uField;
uniform sampler2D uGrassMap; uniform sampler2D uDirtMap; uniform sampler2D uRockMap; uniform sampler2D uRoadMap;
uniform sampler2D uGrassN; uniform sampler2D uDirtN; uniform sampler2D uRockN; uniform sampler2D uRoadN;
uniform float uMapSize;

// Shared across chunk replacements: three runs map -> roughness -> normal, so
// the control-texture fetches happen once in map_fragment and are reused.
vec3 gW;
vec4 gFld;
float gRoadT;
float gRoadW;
float gDist;

float th12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float tvn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = th12(i);
  float b = th12(i + vec2(1.0, 0.0));
  float c = th12(i + vec2(0.0, 1.0));
  float d = th12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float tfbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * tvn(p); p *= 2.03; a *= 0.5; }
  return s;
}

// --- anti-tiling ------------------------------------------------------------
// Two fetches: one pushed around by a slow offset field, one rotated 34 degrees
// and rescaled, cross-faded by an independent low-frequency mask. Both UV
// fields stay smooth so mip derivatives remain valid.
// The offset field has to vary at a few TILES, not a few hundred metres: a slow
// offset just slides one unbroken tiling around and changes nothing.
vec2 stochOff(vec2 uv, float rnd) {
  return vec2(tvn(uv * 0.085 + rnd), tvn(uv * 0.085 + rnd + 5.3)) * 2.6;
}
float stochMix(vec2 uv, float rnd) {
  return smoothstep(0.34, 0.66, tvn(uv * 0.045 + rnd * 2.0));
}
vec2 stochUvB(vec2 uv, vec2 o) {
  // Rotate 34 degrees AND drop the scale well away from 1.0, so the two
  // lattices beat against each other over a long period.
  return vec2(uv.x * 0.83 - uv.y * 0.56, uv.x * 0.56 + uv.y * 0.83) * 0.61 + o.yx * 2.1 + 17.3;
}
vec3 stochCol(sampler2D tex, vec2 uv, float rnd) {
  vec2 o = stochOff(uv, rnd);
  vec3 A = texture2D(tex, uv + o).rgb;
  vec3 B = texture2D(tex, stochUvB(uv, o)).rgb;
  return mix(A, B, stochMix(uv, rnd));
}
vec3 stochNrm(sampler2D tex, vec2 uv, float rnd) {
  vec2 o = stochOff(uv, rnd);
  vec3 A = texture2D(tex, uv + o).xyz * 2.0 - 1.0;
  vec3 B = texture2D(tex, stochUvB(uv, o)).xyz * 2.0 - 1.0;
  return mix(A, B, stochMix(uv, rnd));
}

// --- farmland ---------------------------------------------------------------
// Crop families as multiplicative tints so the underlying grass detail keeps
// its structure. Hard steps on purpose: a field ends at its margin.
vec3 parcelTint(float t) {
  if (t < 0.17) return vec3(0.78, 0.93, 0.66);   // green pasture
  if (t < 0.32) return vec3(1.14, 1.01, 0.66);   // ripening wheat
  if (t < 0.47) return vec3(0.92, 0.96, 0.80);   // mixed meadow
  if (t < 0.62) return vec3(1.20, 1.05, 0.72);   // cut straw stubble
  if (t < 0.80) return vec3(0.84, 0.90, 0.72);   // dark leaf crop
  return vec3(1.04, 0.88, 0.70);                 // worked earth
}`
        )
        .replace(
          '#include <map_fragment>',
          `{
  vec2 suv = vWPos.xz / uMapSize + 0.5;
  vec4 s = texture2D(uSplat, suv);
  gFld = texture2D(uField, suv);
  gW = s.rgb / (s.r + s.g + s.b + 1e-4);
  gRoadT = s.a;
  gDist = length(vWPos - cameraPosition);

  // Ragged road edge + slow width variation: two noise scales perturbing the
  // threshold on the tent profile, so the verge crumbles instead of ruling a line.
  float ragged = (tfbm(vWPos.xz * 0.55) - 0.5) * 0.14 + (tvn(vWPos.xz * 0.085) - 0.5) * 0.09;
  float edgeT = 0.655 + (tvn(vWPos.xz * 0.016) - 0.5) * 0.10;
  gRoadW = smoothstep(edgeT - 0.05, edgeT + 0.08, gRoadT + ragged);

  vec2 duv = vWPos.xz / ${DETAIL_TILE.toFixed(2)};
  vec3 col = vec3(0.0);
  if (gW.r > 0.004) col += gW.r * stochCol(uGrassMap, duv, 0.0);
  if (gW.g > 0.004) col += gW.g * stochCol(uDirtMap, duv * 1.25, 3.7);
  if (gW.b > 0.004) col += gW.b * stochCol(uRockMap, duv * 0.5, 8.1);

  // Parcel hue + plough furrows.
  float farm = gFld.a;
  if (farm > 0.01) {
    col *= mix(vec3(1.0), parcelTint(gFld.r), farm * (0.55 + 0.45 * gW.r));
    vec2 fdir = normalize(gFld.gb * 2.0 - 1.0 + vec2(1e-4, 1e-4));
    float rowSpace = 2.3 + 4.4 * fract(gFld.r * 6.37);
    float phase = dot(vWPos.xz, fdir) * 6.28318 / rowSpace;
    // Fade rows out once a pixel spans more than a row: keeps them off the
    // aliasing budget at vista range.
    float aa = 1.0 - smoothstep(1.4, 4.2, fwidth(phase));
    col *= 1.0 + sin(phase) * 0.15 * farm * aa;
  }

  // Macro breakup: large luminance swings plus a slow warm/cool hue drift.
  // This is what stops a 3.6m texture reading as wallpaper at 200m.
  float macro = tfbm(vWPos.xz * 0.0115);
  float macroMid = tfbm(vWPos.xz * 0.045);
  float macroB = tvn(vWPos.xz * 0.0031);
  col *= 0.74 + 0.52 * macro;
  col *= 0.88 + 0.24 * macroMid;
  col *= mix(vec3(1.07, 1.01, 0.90), vec3(0.92, 0.97, 1.05), macroB);

  // Worn rural road on top: twin wheel tracks read off the tent ramp.
  if (gRoadW > 0.003) {
    vec3 rc = stochCol(uRoadMap, vWPos.xz / 2.6, 2.3);
    // Twin wheel tracks: the tent ramp doubles as a lateral coordinate, so
    // |offset from centre| ~ 1.6m falls out of it for free, both sides at once.
    float track = smoothstep(0.055, 0.0, abs(gRoadT - 0.822));
    rc *= 1.0 - track * 0.42;
    // Polished centre crown between the tracks.
    rc *= 1.0 + smoothstep(0.045, 0.0, abs(gRoadT - 0.955)) * 0.16;
    rc *= 0.90 + 0.20 * tvn(vWPos.xz * 0.05);
    // Dust dragged in from the verge along the outer third.
    rc = mix(rc, rc * vec3(1.34, 1.20, 0.96), smoothstep(0.80, 0.66, gRoadT));
    col = mix(col, rc, gRoadW);
  }
  diffuseColor.rgb *= col;
}`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `{
  // Detail normals are a near-field effect; past 260m the geometry normal plus
  // the albedo carry it, and skipping the fetches buys back the vista frame.
  if (gDist < 260.0) {
    vec2 duv = vWPos.xz / ${DETAIL_TILE.toFixed(2)};
    vec3 nt = vec3(0.0, 0.0, 1.0);
    if (gW.r > 0.004) nt += gW.r * stochNrm(uGrassN, duv, 0.0);
    if (gW.g > 0.004) nt += gW.g * stochNrm(uDirtN, duv * 1.25, 3.7);
    if (gW.b > 0.004) nt += gW.b * stochNrm(uRockN, duv * 0.5, 8.1);
    if (gRoadW > 0.003) nt = mix(nt, texture2D(uRoadN, vWPos.xz / 3.1).xyz * 2.0 - 1.0, gRoadW);
    nt.xy *= 1.0 - smoothstep(120.0, 260.0, gDist);
    nt = normalize(nt);
    // Tangent frame for a heightfield: T=+X, B=+Z around the world normal.
    vec3 wN = normalize(vWNormal);
    vec3 wT = normalize(cross(vec3(0.0, 0.0, 1.0), wN));
    vec3 wB = cross(wN, wT);
    vec3 perturbed = normalize(wT * nt.x + wB * nt.y + wN * nt.z);
    normal = normalize((viewMatrix * vec4(perturbed, 0.0)).xyz);
  }
}`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = roughness;
{
  roughnessFactor = gW.r * 0.93 + gW.g * 0.94 + gW.b * 0.84;
  roughnessFactor = mix(roughnessFactor, 0.80, gRoadW);
}`
        );
    };

    // Distinct program cache key so three doesn't share the patched shader.
    mat.customProgramCacheKey = () => 'terrain-splat-v2';
    return mat;
  }
}
