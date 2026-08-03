import * as THREE from 'three';
import { Heightfield, MAP_SIZE } from '../gen/terraingen';
import type { TextureFactory } from '../gen/texgen';
import { TERRAIN_RECIPES } from '../materials/library';

// Splat-blended terrain: 4x4 chunks of 128x128 quads (~524K tris before
// culling), one shared patched MeshStandardMaterial, world-XZ UVs, four
// surface categories blended by a baked 1024^2 splatmap. Each category is
// sampled behind a weight branch so open fields pay for one category, not four.

const CHUNKS = 4;
const CHUNK_QUADS = 128;
const SPLAT_SIZE = 1024;

const DETAIL_TILE = 2.6;   // metres per texture repeat, close-up
const MACRO_TILE = 43.0;   // metres per repeat for anti-tiling blend

export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private splatTex: THREE.DataTexture;

  constructor(private hf: Heightfield, factory: TextureFactory) {
    this.splatTex = this.buildSplatmap();
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

  private buildSplatmap(): THREE.DataTexture {
    const data = new Uint8Array(SPLAT_SIZE * SPLAT_SIZE * 4);
    const scale = MAP_SIZE / SPLAT_SIZE;
    let p = 0;
    for (let j = 0; j < SPLAT_SIZE; j++) {
      for (let i = 0; i < SPLAT_SIZE; i++) {
        const x = -MAP_SIZE / 2 + (i + 0.5) * scale;
        const z = -MAP_SIZE / 2 + (j + 0.5) * scale;
        const w = this.hf.splat(x, z);
        data[p] = Math.round(w.grass * 255);
        data[p + 1] = Math.round(w.dirt * 255);
        data[p + 2] = Math.round(w.rock * 255);
        data[p + 3] = Math.round(w.road * 255);
        p += 4;
      }
    }
    const tex = new THREE.DataTexture(data, SPLAT_SIZE, SPLAT_SIZE, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  private buildMaterial(factory: TextureFactory): THREE.MeshStandardMaterial {
    const [grass, dirt, rock, road] = TERRAIN_RECIPES.map((r) => factory.bake(r));

    const mat = new THREE.MeshStandardMaterial({
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.5,
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSplat = { value: this.splatTex };
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
uniform sampler2D uGrassMap; uniform sampler2D uDirtMap; uniform sampler2D uRockMap; uniform sampler2D uRoadMap;
uniform sampler2D uGrassN; uniform sampler2D uDirtN; uniform sampler2D uRockN; uniform sampler2D uRoadN;
uniform float uMapSize;

vec4 terrainSplat() {
  vec2 suv = vWPos.xz / uMapSize + 0.5;
  vec4 s = texture2D(uSplat, suv);
  float sum = s.r + s.g + s.b + s.a + 1e-5;
  return s / sum;
}

vec3 sampleCat(sampler2D tex, vec2 duv, vec2 muv, float macroAmount) {
  vec3 d = texture2D(tex, duv).rgb;
  vec3 m = texture2D(tex, muv).rgb;
  return mix(d, d * (m * 2.0), macroAmount); // soft-overlay macro breakup
}`
        )
        .replace(
          '#include <map_fragment>',
          `{
  vec4 w = terrainSplat();
  vec2 duv = vWPos.xz / ${DETAIL_TILE.toFixed(2)};
  vec2 muv = vWPos.xz / ${MACRO_TILE.toFixed(2)};
  vec3 col = vec3(0.0);
  if (w.r > 0.004) col += w.r * sampleCat(uGrassMap, duv, muv, 0.6);
  if (w.g > 0.004) col += w.g * sampleCat(uDirtMap, duv, muv, 0.5);
  if (w.b > 0.004) col += w.b * sampleCat(uRockMap, duv * 0.55, muv, 0.45);
  if (w.a > 0.004) col += w.a * texture2D(uRoadMap, duv * 0.7).rgb;
  diffuseColor.rgb *= col;
}`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `{
  vec4 w = terrainSplat();
  vec2 duv = vWPos.xz / ${DETAIL_TILE.toFixed(2)};
  vec3 nt = vec3(0.0, 0.0, 1.0);
  if (w.r > 0.004) nt += w.r * (texture2D(uGrassN, duv).xyz * 2.0 - 1.0);
  if (w.g > 0.004) nt += w.g * (texture2D(uDirtN, duv).xyz * 2.0 - 1.0);
  if (w.b > 0.004) nt += w.b * (texture2D(uRockN, duv * 0.55).xyz * 2.0 - 1.0);
  if (w.a > 0.004) nt += w.a * (texture2D(uRoadN, duv * 0.7).xyz * 2.0 - 1.0);
  nt = normalize(nt);
  // Tangent frame for a heightfield: T=+X, B=+Z around the world normal.
  vec3 wN = normalize(vWNormal);
  vec3 wT = normalize(cross(vec3(0.0, 0.0, 1.0), wN));
  vec3 wB = cross(wN, wT);
  vec3 perturbed = normalize(wT * nt.x + wB * nt.y + wN * nt.z);
  normal = normalize((viewMatrix * vec4(perturbed, 0.0)).xyz);
}`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = roughness;
{
  vec4 w = terrainSplat();
  roughnessFactor = w.r * 0.92 + w.g * 0.94 + w.b * 0.82 + w.a * 0.88;
}`
        );
    };

    // Distinct program cache key so three doesn't share the patched shader.
    mat.customProgramCacheKey = () => 'terrain-splat-v1';
    return mat;
  }
}
