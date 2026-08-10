import * as THREE from 'three';
import { Heightfield, MAP_SIZE } from '../gen/terraingen';
import type { TextureFactory } from '../gen/texgen';
import { TERRAIN_RECIPES } from '../materials/library';
import { parseBootParams, quality } from '../core/settings';
import {
  FOG_HEIGHT,
  hazeNearLinearFor,
  skyAmbientFor,
  skyCubeUniform,
  sunDirectionFor,
  sunTintFor,
  useSkyEnv,
} from './sky';

// Splat-blended terrain: 4x4 chunks of 128x128 quads (~524K tris before
// culling), one shared patched MeshStandardMaterial, world-XZ UVs, three
// surface categories blended by a baked 1024^2 splatmap plus a road profile in
// its alpha. Each category is sampled behind a weight branch so open fields pay
// for one category, not four.
//
// Four things separate this from a "procedural blanket":
//   1. Stochastic sampling (Inigo Quilez): the flat categories are fetched
//      twice, at a noise-driven offset and again rotated, blended by a
//      low-frequency mask. The texture period stops existing.
//   2. TRIPLANAR projection on the rock category. A pure world-XZ projection
//      stretches by 1/cos(theta), so past ~35 degrees the material becomes
//      vertical noodles — that smear across the hero hill was the single
//      loudest "not a game engine" tell in the last pass.
//   3. HEIGHT-BLENDED category weights (sharpness 0.16) instead of a linear
//      lerp, so grass/scree/rock meet on an irregular, texture-driven boundary
//      rather than a constant-width blur.
//   4. A parcel layer (uField): per-farm-cell hue, plough direction, cultivated
//      mask AND boundary distance, baked next to the splat. The boundary is
//      what makes the plains read as farmland instead of tonal noise.
//
// The splat map's RED channel carries SEA DEPTH, not grass: grass is
// 1 - dirt - rock by construction, so the channel was free, and the water
// shader needs a depth field to have any body colour at all.

const CHUNKS = 4;
const CHUNK_QUADS = 128;
const SPLAT_SIZE = 1024;
/** Resolution of the sky-occlusion sweep before it is upsampled (low freq). */
const AO_SIZE = 256;

const DETAIL_TILE = 3.0;   // metres per texture repeat, close-up
/** Sub-metre repeat used only inside ~15m of the camera (see FINE_TILE use). */
const FINE_TILE = 0.34;
const SEA_Y = 0.35;        // must match the water plane in water.ts
const SEA_DEPTH_RANGE = 12.0;

/**
 * Published so the water shader can read the same baked control maps instead of
 * paying for a second 1M-query heightfield walk. Terrain is constructed before
 * the water in main.ts.
 *
 * `occ` is also the ONE place the world's cloud-shadow field lives (alpha), so
 * any other lane's material can attenuate its direct term by the same value the
 * ground under it uses — sample it at world XZ / MAP_SIZE + 0.5.
 */
export const terrainMaps: {
  splat: THREE.DataTexture | null;
  occ: THREE.DataTexture | null;
} = { splat: null, occ: null };

// CPU twins of the shader's value-noise stack, used to bake the cloud field
// into the occlusion map's alpha. Same hash, so the bake is deterministic in
// WORLD_SEED-independent world space exactly as the old per-fragment version was.
function chash2(x: number, y: number): number {
  const f = (v: number) => v - Math.floor(v);
  let px = f(x * 0.1031);
  let py = f(y * 0.1031);
  let pz = px;
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d; py += d; pz += d;
  return f((px + py) * pz);
}
function cvn2(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = chash2(ix, iy);
  const b = chash2(ix + 1, iy);
  const c = chash2(ix, iy + 1);
  const d = chash2(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
function cfbm2(x: number, y: number): number {
  let s = 0, amp = 0.5;
  for (let i = 0; i < 4; i++) {
    s += amp * cvn2(x, y);
    x *= 2.03; y *= 2.03; amp *= 0.5;
  }
  return s;
}
function smooth01(v: number, a: number, b: number): number {
  const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private splatTex: THREE.DataTexture;
  private fieldTex: THREE.DataTexture;
  private occTex: THREE.DataTexture;

  constructor(private hf: Heightfield, factory: TextureFactory) {
    const maps = this.buildMaps();
    this.splatTex = maps.splat;
    this.fieldTex = maps.field;
    this.occTex = maps.occ;
    terrainMaps.splat = maps.splat;
    terrainMaps.occ = maps.occ;
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
    // The landscape shadows itself from the BAKED horizon march (buildOcclusion),
    // not from the real-time map. A single camera-fitted 2048 cascade stretched
    // over a vista is ~0.9 m/texel and cannot hold a 600m ridge shadow anyway;
    // the bake is exact to 1.2m over the whole island, costs one fetch, and
    // takes 524K triangles straight back out of the depth pass. The real-time
    // map is left to props, where its texel density now actually pays.
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
   * queries dominate the cost, so splat, depth and parcel data share them.
   *   splat: r SEA DEPTH (0..12m), g dirt, b rock, a road tent profile
   *          (grass = 1 - dirt - rock, reconstructed in the shader)
   *   field: r parcel tone, g plough angle, b parcel edge distance, a farm mask
   */
  private buildMaps(): {
    splat: THREE.DataTexture;
    field: THREE.DataTexture;
    occ: THREE.DataTexture;
  } {
    const sData = new Uint8Array(SPLAT_SIZE * SPLAT_SIZE * 4);
    const fData = new Uint8Array(SPLAT_SIZE * SPLAT_SIZE * 4);
    // Heights are cached from this same pass: the occlusion sweep below needs
    // ~40 height lookups per texel and re-querying the heightfield for them
    // would be 40M noise evaluations instead of 40M array reads.
    const hArr = new Float32Array(SPLAT_SIZE * SPLAT_SIZE);
    const scale = MAP_SIZE / SPLAT_SIZE;
    let p = 0;
    for (let j = 0; j < SPLAT_SIZE; j++) {
      for (let i = 0; i < SPLAT_SIZE; i++) {
        const x = -MAP_SIZE / 2 + (i + 0.5) * scale;
        const z = -MAP_SIZE / 2 + (j + 0.5) * scale;
        const s = this.hf.surface(x, z);
        const depth = Math.min(Math.max((SEA_Y - s.height) / SEA_DEPTH_RANGE, 0), 1);
        hArr[j * SPLAT_SIZE + i] = s.height;
        sData[p] = Math.round(depth * 255);
        sData[p + 1] = Math.round(s.splat.dirt * 255);
        sData[p + 2] = Math.round(s.splat.rock * 255);
        sData[p + 3] = Math.round(s.splat.road * 255);
        fData[p] = Math.round(s.field.tone * 255);
        fData[p + 1] = Math.round(s.field.angle * 255);
        fData[p + 2] = Math.round(s.field.edge * 255);
        fData[p + 3] = Math.round(s.field.farm * 255);
        p += 4;
      }
    }
    return {
      splat: this.makeDataTexture(sData),
      field: this.makeDataTexture(fData),
      occ: this.makeDataTexture(this.buildOcclusion(hArr)),
    };
  }

  /**
   * The occlusion control map — the single change that turns a lit preview into
   * a lit landscape.
   *
   *   r  SUN VISIBILITY. A horizon march up the sun vector over the cached
   *      heightfield: exact terrain self-shadowing across the whole 1200m
   *      island at 1.17 m/texel, with a penumbra that widens with the
   *      occluder's distance. Multiplies the DIRECT term only.
   *   g  SKY OCCLUSION. 8 azimuths x 8 radii of horizon search out to 62m.
   *      Multiplies the INDIRECT term only, so valley floors and ridge bases
   *      stop sitting at the same value as ridge tops.
   *   b  CURVATURE CAVITY from a wide-stencil Laplacian: 0.5 flat, above 0.5
   *      concave. Folds into the indirect term as well.
   *   a  CLOUD SHADOW, projected down the sun vector. Baked here rather than
   *      recomputed per fragment so every other material in the build can
   *      attenuate by the same field the ground under it uses.
   */
  private buildOcclusion(h: Float32Array): Uint8Array {
    const N = SPLAT_SIZE;
    const scale = MAP_SIZE / N;
    const sun = sunDirectionFor(parseBootParams().timeOfDay);
    const horiz = Math.max(Math.hypot(sun.x, sun.z), 1e-4);
    const ux = sun.x / horiz;
    const uz = sun.z / horiz;
    const tanElev = sun.y / horiz;

    let maxH = -1e9;
    for (let i = 0; i < h.length; i++) if (h[i] > maxH) maxH = h[i];

    // --- sun visibility ------------------------------------------------------
    // THE bug behind three separate cycle-3 blockers. The march used to start
    // 1.7 texels (2.0m) up-sun and divide the overshoot by a penumbra width of
    // 0.45m at that range, so ANY neighbouring texel a quarter of a metre above
    // the ray halved the sun — and on a 1.17 m/texel heightfield carrying real
    // sub-metre roughness, that is most of the island. Back-solving the capture
    // put sun visibility near 0.10 over open ground: the terrain was receiving
    // a tenth of the key while every tree, fence and building next to it
    // received all of it.
    //
    // Everything downstream followed from that. Cast shadows on the road
    // removed nothing measurable (there was almost no direct light left to
    // remove — 78.4 p50 in shadow against 93.6 in sun). The ridge went to
    // literal zero because a tenth of a key plus a 1.0 ambient on a 0.05 albedo
    // is below the 8-bit floor. And the landscape read as "painted" because it
    // genuinely was almost entirely ambient-lit.
    //
    // Three changes: start 2.5 texels out (a surface does not shadow itself —
    // that is what N.L is for), bias the ray up by 0.30m to account for the
    // receiver sitting on a smoothed surface, and widen the near penumbra from
    // 0.45m to 0.80m so a 25cm bump can no longer throw a hard shadow.
    //
    // Dialled against the bake's own console line, which is why it prints a
    // full-sun percentage as well as a shadowed one: a first pass at bias 0.6 /
    // penumbra 1.10 swung to 98.5% FULL SUN, i.e. the landform stopped casting
    // at all, which is just as wrong in the other direction. The numbers below
    // land in single-digit-to-low-teens percent, which is what a 24-degree sun
    // over 60m of relief should produce.
    const vis = new Float32Array(N * N);
    const RANGE = 480;
    const RAY_BIAS = 0.30;
    const hAt = (fi: number, fj: number): number => {
      const i0 = Math.min(Math.max(fi | 0, 0), N - 2);
      const j0 = Math.min(Math.max(fj | 0, 0), N - 2);
      const tx = Math.min(Math.max(fi - i0, 0), 1);
      const ty = Math.min(Math.max(fj - j0, 0), 1);
      const a = h[j0 * N + i0], b = h[j0 * N + i0 + 1];
      const c = h[(j0 + 1) * N + i0], d = h[(j0 + 1) * N + i0 + 1];
      return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
    };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const h0 = h[j * N + i] + RAY_BIAS;
        let occl = 0;
        let t = scale * 2.5;
        while (t < RANGE) {
          const ray = h0 + tanElev * t;
          if (ray > maxH) break;
          const si = i + (ux * t) / scale;
          const sj = j + (uz * t) / scale;
          if (si < 0 || sj < 0 || si >= N - 1 || sj >= N - 1) break;
          // Penumbra: a ridge 300m up-sun throws a soft edge, a bank 5m up-sun
          // throws a hard one. Dividing the overshoot by a distance-growing
          // width is the cheap version of an area light.
          const d = (hAt(si, sj) - ray) / (0.80 + 0.015 * t);
          if (d > occl) {
            occl = d;
            if (occl >= 1) break;
          }
          t = t * 1.055 + 0.85;
        }
        const o = occl < 0 ? 0 : occl > 1 ? 1 : occl;
        vis[j * N + i] = 1 - o * o * (3 - 2 * o);
      }
    }
    // One 3x3 box pass: the march writes per-texel, and without this the
    // shadow edges carry a 1-texel staircase that reads at vista range.
    const visB = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      const j0 = j > 0 ? j - 1 : 0;
      const j1 = j < N - 1 ? j + 1 : N - 1;
      for (let i = 0; i < N; i++) {
        const i0 = i > 0 ? i - 1 : 0;
        const i1 = i < N - 1 ? i + 1 : N - 1;
        visB[j * N + i] =
          (vis[j0 * N + i0] + vis[j0 * N + i] + vis[j0 * N + i1] +
            vis[j * N + i0] + vis[j * N + i] + vis[j * N + i1] +
            vis[j1 * N + i0] + vis[j1 * N + i] + vis[j1 * N + i1]) / 9;
      }
    }

    // --- sky occlusion (coarse, then bilinear upsample) ----------------------
    const A = AO_SIZE;
    const aoC = new Float32Array(A * A);
    const radii = [3, 6, 10, 16, 24, 34, 46, 62];
    const AZ = 8;
    const cellT = N / A;
    const at = (fi: number, fj: number): number => {
      const i = fi < 0 ? 0 : fi > N - 1 ? N - 1 : fi | 0;
      const j = fj < 0 ? 0 : fj > N - 1 ? N - 1 : fj | 0;
      return h[j * N + i];
    };
    for (let aj = 0; aj < A; aj++) {
      const cj = (aj + 0.5) * cellT;
      for (let ai = 0; ai < A; ai++) {
        const ci = (ai + 0.5) * cellT;
        const h0 = at(ci, cj);
        let sum = 0;
        for (let k = 0; k < AZ; k++) {
          const ang = (k + 0.37) * ((Math.PI * 2) / AZ);
          const dx = Math.cos(ang) / scale;
          const dz = Math.sin(ang) / scale;
          let tanMax = 0;
          for (let r = 0; r < radii.length; r++) {
            const rr = radii[r];
            const e = (at(ci + dx * rr, cj + dz * rr) - h0) / rr;
            if (e > tanMax) tanMax = e;
          }
          sum += 1 - tanMax / Math.sqrt(1 + tanMax * tanMax);
        }
        aoC[aj * A + ai] = sum / AZ;
      }
    }

    // --- assemble ------------------------------------------------------------
    const out = new Uint8Array(N * N * 4);
    const LAP = 4;
    let p = 0;
    for (let j = 0; j < N; j++) {
      const fj = (j + 0.5) / cellT - 0.5;
      const j0 = Math.min(Math.max(Math.floor(fj), 0), A - 1);
      const j1 = Math.min(j0 + 1, A - 1);
      const tj = Math.min(Math.max(fj - j0, 0), 1);
      const jm = j >= LAP ? j - LAP : 0;
      const jp = j < N - LAP ? j + LAP : N - 1;
      const z = -MAP_SIZE / 2 + (j + 0.5) * scale;
      for (let i = 0; i < N; i++) {
        const fi = (i + 0.5) / cellT - 0.5;
        const i0 = Math.min(Math.max(Math.floor(fi), 0), A - 1);
        const i1 = Math.min(i0 + 1, A - 1);
        const ti = Math.min(Math.max(fi - i0, 0), 1);
        const ao =
          (aoC[j0 * A + i0] * (1 - ti) + aoC[j0 * A + i1] * ti) * (1 - tj) +
          (aoC[j1 * A + i0] * (1 - ti) + aoC[j1 * A + i1] * ti) * tj;

        const im = i >= LAP ? i - LAP : 0;
        const ip = i < N - LAP ? i + LAP : N - 1;
        const lap =
          h[j * N + im] + h[j * N + ip] + h[jm * N + i] + h[jp * N + i] - 4 * h[j * N + i];
        const cav = Math.min(Math.max(0.5 + lap * 0.055, 0), 1);

        const x = -MAP_SIZE / 2 + (i + 0.5) * scale;
        const cx = x + ux * (900 * horiz) / Math.max(sun.y, 0.15);
        const cz = z + uz * (900 * horiz) / Math.max(sun.y, 0.15);
        const cloud = 1 - smooth01(cfbm2(cx * 0.0014, cz * 0.0014), 0.40, 0.60) * 0.42;

        out[p] = Math.round(Math.min(Math.max(visB[j * N + i], 0), 1) * 255);
        out[p + 1] = Math.round(Math.min(Math.max(ao, 0), 1) * 255);
        out[p + 2] = Math.round(cav * 255);
        out[p + 3] = Math.round(Math.min(Math.max(cloud, 0), 1) * 255);
        p += 4;
      }
    }
    // Warn-level so it survives the capture harness's console filter: an
    // occlusion map that came out all-ones or all-zeros is invisible in a
    // screenshot but destroys the entire lighting read, and this is the cheapest
    // possible way to know which.
    const mean = (off: number): number => {
      let acc = 0;
      for (let q = off; q < out.length; q += 4) acc += out[q];
      return Math.round((acc / (out.length / 4)) * 10) / 10;
    };
    let shadowed = 0;
    let fullSun = 0;
    for (let q = 0; q < out.length; q += 4) {
      if (out[q] < 128) shadowed++;
      if (out[q] > 230) fullSun++;
    }
    const npx = out.length / 4;
    console.warn(
      `[terrain] occlusion baked: sunVis mean ${mean(0)} (${((shadowed / npx) * 100).toFixed(1)}% in shadow, ` +
        `${((fullSun / npx) * 100).toFixed(1)}% full sun), ` +
        `skyAO mean ${mean(1)}, cavity mean ${mean(2)}, cloud mean ${mean(3)}`
    );
    return out;
  }

  private buildMaterial(factory: TextureFactory): THREE.MeshStandardMaterial {
    const [grass, dirt, rock, road] = TERRAIN_RECIPES.map((r) => factory.bake(r));
    const tod = parseBootParams().timeOfDay;
    const hazeNear = hazeNearLinearFor(tod);
    const amb = skyAmbientFor(tod);
    const sunDir = sunDirectionFor(tod);
    const sunTint = sunTintFor(tod);

    const mat = new THREE.MeshStandardMaterial({
      roughness: 1.0,
      metalness: 0.0,
      // 0.72 -> 0.30. The PMREM is no longer carrying the ambient on its own:
      // the sky irradiance is now an EXPLICIT, auditable pair of uniforms added
      // straight into `irradiance` (see the lights_fragment_maps patch), which
      // is the only way to guarantee the shadow side of a slope gets skylight
      // and gets it with the right chroma. What is left here is the directional
      // part of the sky bounce plus the wet-sand reflection.
      envMapIntensity: 0.34,
    });
    useSkyEnv(mat);

    // THE reason the landscape cast nothing in the last pass. three flips
    // shadowSide to BackSide for a FrontSide material (a closed mesh's back
    // faces are the far side from the light, which cheaply avoids acne). A
    // heightfield is an OPEN surface: its back faces point underground, so the
    // whole terrain was back-face culled out of the shadow map and every draw
    // call in the depth pass wrote nothing. Forcing FrontSide puts the lit
    // surface back in the map; the acne that costs is paid for by the
    // texel-scaled normalBias in sky.ts fitSunShadow.
    mat.shadowSide = THREE.FrontSide;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSplat = { value: this.splatTex };
      shader.uniforms.uField = { value: this.fieldTex };
      shader.uniforms.uOcc = { value: this.occTex };
      shader.uniforms.uGrassMap = { value: grass.map };
      shader.uniforms.uDirtMap = { value: dirt.map };
      shader.uniforms.uRockMap = { value: rock.map };
      shader.uniforms.uRoadMap = { value: road.map };
      shader.uniforms.uGrassN = { value: grass.normalMap };
      shader.uniforms.uDirtN = { value: dirt.normalMap };
      shader.uniforms.uRockN = { value: rock.normalMap };
      shader.uniforms.uRoadN = { value: road.normalMap };
      shader.uniforms.uMapSize = { value: MAP_SIZE };
      shader.uniforms.uSunDir = { value: sunDir.clone() };
      shader.uniforms.uHazeNear = { value: new THREE.Vector3(...hazeNear) };
      shader.uniforms.uSunTint = { value: sunTint.clone() };
      shader.uniforms.uSkyIrr = { value: new THREE.Vector3(...amb.sky) };
      shader.uniforms.uGndIrr = { value: new THREE.Vector3(...amb.ground) };
      shader.uniforms.uFogHeight = { value: FOG_HEIGHT };
      // Shared uniform OBJECT, not a copy: the cube is baked after the terrain
      // material exists (main.ts builds the world, then the atmosphere), so the
      // binding has to be live. A null samplerCube binds three's 1x1 empty cube
      // for the frames before the bake, which is harmless in a static capture.
      shader.uniforms.uSkyCube = skyCubeUniform;

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

      if (quality.terrainCheap) {
        shader.fragmentShader = '#define TERRAIN_CHEAP 1\n' + shader.fragmentShader;
      }
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;
uniform sampler2D uSplat;
uniform sampler2D uField;
uniform sampler2D uOcc;
uniform sampler2D uGrassMap; uniform sampler2D uDirtMap; uniform sampler2D uRockMap; uniform sampler2D uRoadMap;
uniform sampler2D uGrassN; uniform sampler2D uDirtN; uniform sampler2D uRockN; uniform sampler2D uRoadN;
uniform float uMapSize;
uniform vec3 uSunDir;
uniform vec3 uHazeNear;
uniform vec3 uSunTint;
uniform vec3 uSkyIrr;
uniform vec3 uGndIrr;
uniform float uFogHeight;
uniform samplerCube uSkyCube;

// Shared across chunk replacements: the run maps -> lights -> roughness ->
// normal -> fog, so the control-texture fetches happen once in map_fragment
// and everything downstream reuses them.
vec3 gW;        // grass / dirt / rock, height-blended
vec4 gFld;
float gRoadT;
float gRoadW;
float gDist;
float gKey;     // sun visibility * cloud shadow -> DIRECT term only
float gAmb;     // sky occlusion * curvature cavity -> INDIRECT term only
float gWet;
float gFine;    // near-field detail weight, 1 under 4m -> 0 past 15m
float gBed;     // rock bedding mask 0..1
float gBedD;    // vertical derivative of the bedding signal
float gCrack;   // world-scale dried-mud crazing weight (albedo only)
float gRockD;   // near-field rock mid-band detail weight
float gRotC;    // per-parcel rotation for the second stochastic fetch
float gRotS;
vec3 gGeoN;

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
// fields stay smooth so mip derivatives remain valid. Alpha carries the
// recipe's HEIGHT channel, which the category blend needs.
vec2 stochOff(vec2 uv, float rnd) {
  return vec2(tvn(uv * 0.085 + rnd), tvn(uv * 0.085 + rnd + 5.3)) * 2.6;
}
float stochMix(vec2 uv, float rnd) {
  return smoothstep(0.34, 0.66, tvn(uv * 0.045 + rnd * 2.0));
}
// The rotation is PER PARCEL (gRotC/gRotS come off the field map's angle
// channel), not a fixed 34 degrees. With one shared angle every parcel's second
// fetch lands on the same orientation and the anti-tiling pair beats into one
// visible period across the whole plain.
vec2 stochUvB(vec2 uv, vec2 o) {
  return vec2(uv.x * gRotC - uv.y * gRotS, uv.x * gRotS + uv.y * gRotC) * 0.61 + o.yx * 2.1 + 17.3;
}
// PERF: the anti-tiling pair costs TWO texture fetches plus three noise
// evaluations per category, and the splat runs up to four categories for both
// albedo and normal — around sixteen dependent fetches on every ground pixel,
// which is the largest single fill cost in the frame on an integrated GPU.
// Below high quality the second fetch is dropped: the field tiles again at ~3.6 m,
// which is visible if you look for it and is worth roughly a third of the
// frame time on the target hardware.
vec4 stochCol(sampler2D tex, vec2 uv, float rnd) {
#ifdef TERRAIN_CHEAP
  return texture2D(tex, uv);
#else
  vec2 o = stochOff(uv, rnd);
  vec4 A = texture2D(tex, uv + o);
  vec4 B = texture2D(tex, stochUvB(uv, o));
  return mix(A, B, stochMix(uv, rnd));
#endif
}
vec3 stochNrm(sampler2D tex, vec2 uv, float rnd) {
#ifdef TERRAIN_CHEAP
  return texture2D(tex, uv).xyz * 2.0 - 1.0;
#else
  vec2 o = stochOff(uv, rnd);
  vec3 A = texture2D(tex, uv + o).xyz * 2.0 - 1.0;
  vec3 B = texture2D(tex, stochUvB(uv, o)).xyz * 2.0 - 1.0;
  return mix(A, B, stochMix(uv, rnd));
#endif
}

// --- triplanar (rock only) --------------------------------------------------
// Slope pixels pay 3 fetches; flat fields keep the single-fetch path. Gated on
// the rock weight so the cost lands exactly where the stretch would.
// Exponent 3.5, not 6.0: at 6.0 the blend is a knife edge on a 45-degree face,
// so the three projections swap over about two pixels and the face reads as two
// flat plates meeting on a line.
vec3 triWeights(vec3 n) {
  vec3 w = pow(abs(n), vec3(3.5));
  return w / max(dot(w, vec3(1.0)), 1e-4);
}
vec4 triCol(sampler2D tex, vec3 wp, float sc, vec3 w) {
  vec4 ax = texture2D(tex, wp.zy * sc);
  vec4 ay = texture2D(tex, wp.xz * sc);
  vec4 az = texture2D(tex, wp.xy * sc);
  return ax * w.x + ay * w.y + az * w.z;
}
// Whiteout blend: each projection carries its own tangent frame, so the side
// planes are not forced through the heightfield's +X/+Z frame.
vec3 triNrmWorld(sampler2D tex, vec3 wp, float sc, vec3 w, vec3 n) {
  vec3 tx = texture2D(tex, wp.zy * sc).xyz * 2.0 - 1.0;
  vec3 ty = texture2D(tex, wp.xz * sc).xyz * 2.0 - 1.0;
  vec3 tz = texture2D(tex, wp.xy * sc).xyz * 2.0 - 1.0;
  tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x);
  ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y);
  tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
  return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
}

// --- farmland ---------------------------------------------------------------
// Crop families as multiplicative tints so the underlying grass detail keeps
// its structure. Hard steps on purpose: a field ends at its margin. The spread
// is ~1.95x in luminance between the darkest and brightest family — at half
// that, adjacent crops separate by under 0.05 display luminance and the plains
// collapse back into one wash.
vec3 parcelTint(float t) {
  if (t < 0.12) return vec3(0.72, 0.84, 0.52);   // green pasture
  if (t < 0.34) return vec3(1.30, 1.10, 0.66);   // ripening wheat
  if (t < 0.48) return vec3(1.02, 0.98, 0.72);   // mixed meadow
  if (t < 0.70) return vec3(1.42, 1.22, 0.80);   // cut straw stubble
  if (t < 0.82) return vec3(0.60, 0.70, 0.46);   // dark leaf crop
  return vec3(1.10, 0.88, 0.62);                 // worked earth
}`
        )
        .replace(
          '#include <map_fragment>',
          `{
  vec2 suv = vWPos.xz / uMapSize + 0.5;
  vec4 s = texture2D(uSplat, suv);
  gFld = texture2D(uField, suv);
  vec4 occT = texture2D(uOcc, suv);
  // r is sea depth; grass is whatever dirt and rock leave behind.
  vec3 raw = vec3(clamp(1.0 - s.g - s.b, 0.0, 1.0), s.g, s.b);
  gRoadT = s.a;
  gDist = length(vWPos - cameraPosition);
  gGeoN = normalize(vWNormal);
  // Detail band pushed out 15m -> 25m and held at full strength for the first
  // six. At 4-15m the ground inside 5m of an eye-height camera was already
  // rolling off, which is most of what "the near field is an untextured plane"
  // was measuring.
  gFine = 1.0 - smoothstep(6.0, 25.0, gDist);

  // Baked occlusion. Sun visibility and cloud shadow ride the DIRECT term; sky
  // occlusion and curvature cavity ride the INDIRECT term. Keeping them on
  // separate sides is what stops a shadowed valley going dead: it loses the
  // key but keeps the sky, exactly as it should.
  gKey = occT.r * occT.a;
  // Floor 0.50 -> 0.36 and the curvature term strengthened 0.50 -> 0.72. With
  // the ambient rebuilt (sky.ts skyAmbientFor) the indirect side is no longer
  // the thing keeping shadows off zero, so horizon occlusion can do its actual
  // job: a gully floor sees a fraction of the dome and must read darker than
  // the ridge above it. At the old floor every concavity on the island was
  // clamped to within a factor of two of open sky and the landform lost its
  // large-scale form shading entirely.
  gAmb = clamp(occT.g * (1.0 - (occT.b - 0.5) * 0.72), 0.36, 1.15);

  // Per-parcel rotation for the anti-tiling second fetch.
  float rotA = gFld.g * 3.14159265 + 0.6;
  gRotC = cos(rotA);
  gRotS = sin(rotA);

  // Ragged road edge + slow width variation: two noise scales perturbing the
  // threshold on the tent profile, so the verge crumbles instead of ruling a line.
  float ragged = (tfbm(vWPos.xz * 0.55) - 0.5) * 0.14 + (tvn(vWPos.xz * 0.085) - 0.5) * 0.09;
  float edgeT = 0.655 + (tvn(vWPos.xz * 0.016) - 0.5) * 0.10;
  gRoadW = smoothstep(edgeT - 0.05, edgeT + 0.08, gRoadT + ragged);

  vec2 duv = vWPos.xz / ${DETAIL_TILE.toFixed(2)};
  vec3 sel = step(vec3(0.004), raw);
  vec4 cg = vec4(0.0), cd = vec4(0.0), cr = vec4(0.0);
  if (sel.x > 0.5) cg = stochCol(uGrassMap, duv, 0.0);
  if (sel.y > 0.5) cd = stochCol(uDirtMap, duv * 1.25, 3.7);

  vec3 tw = triWeights(gGeoN);
  if (sel.z > 0.5) {
    cr = triCol(uRockMap, vWPos, 1.0 / 6.0, tw);
    // BEDDING PLANES. Three frequencies at roughly 1/2.5m, 1/9m and 1/28m,
    // warped in XZ so the beds are not perfectly level. The old single
    // fract(y*0.12) term was albedo-only at mix(0.80,1.16) and the macro stack
    // washed it out completely — seven beds on a 60m peak resolved to none.
    // The DERIVATIVE is kept as well so the beds can be pushed into the normal
    // in <normal_fragment_maps> and actually catch the key.
    float bw = tvn(vWPos.xz * 0.024) * 5.0;
    float y = vWPos.y;
    gBed = 0.139 * sin(y * 2.513 + bw)
         + 0.430 * sin(y * 0.698 + bw * 0.45)
         + 0.804 * sin(y * 0.224 + bw * 0.18);
    gBedD = 0.350 * cos(y * 2.513 + bw)
          + 0.300 * cos(y * 0.698 + bw * 0.45)
          + 0.180 * cos(y * 0.224 + bw * 0.18);
    gBed = clamp(gBed * 0.62 + 0.5, 0.0, 1.0);
    cr.rgb *= mix(0.70, 1.24, gBed);
    // Bedding tint pulled off blue. The cool end used to be (0.92,0.96,1.05),
    // which stacked on top of an already blue ambient and a recipe whose "cool"
    // ramp sat at hue 214 — three cold terms in series, and the measured
    // mid-tone rock came out hue 215 (slate blue) rather than stone.
    cr.rgb *= mix(vec3(1.00, 0.99, 0.965), vec3(1.12, 1.00, 0.85), gBed);
    // MASSIF HUE/VALUE DRIFT at ~40-60m. A single tone across a whole flank is
    // the loudest "one noise octave stretched over a cone" tell there is; real
    // rock changes colour with its bedding and its weathering front.
    float rHue = tvn(vWPos.xz * 0.024 + 7.7);
    float rVal = tvn(vWPos.xz * 0.017 + 13.1);
    cr.rgb *= mix(vec3(1.10, 1.00, 0.90), vec3(0.93, 0.98, 1.04), rHue);
    cr.rgb *= 0.87 + 0.28 * rVal;
    // Cavity/curvature darkening from the landform itself, so faces read as
    // faceted rock instead of a painted hillside.
    cr.rgb *= 1.0 - (1.0 - clamp(gGeoN.y, 0.0, 1.0)) * 0.16;
  }

  // Height-lerped category blend (sharpness 0.16) with per-pixel jitter on the
  // rock term: a linear weight lerp gives a constant-width blur along the whole
  // grass/rock boundary, which is the giveaway that the mask is one threshold.
  vec3 hb = (raw + vec3(cg.a, cd.a, cr.a) * 0.35) * sel;
  hb.z += (tvn(vWPos.xz * 3.0) - 0.5) * 0.16 * sel.z;
  float hmax = max(hb.x, max(hb.y, hb.z));
  gW = max(hb - (hmax - 0.16), 0.0) * sel;
  gW /= max(gW.x + gW.y + gW.z, 1e-4);
  vec3 col = cg.rgb * gW.x + cd.rgb * gW.y + cr.rgb * gW.z;

  // HILL GRASS IS MOSS, NOT LIME. The lowland pasture tint measured
  // (190,215,140) where it wrapped the ridge shoulders — a chroma that appears
  // nowhere else in the frame and that sat straight against the forest green
  // beside it. Anything on a real slope is browsed, thin and shaded, so it
  // desaturates toward the treeline instead of standing out from it.
  float steepG = smoothstep(0.09, 0.34, 1.0 - gGeoN.y) * gW.x;
  if (steepG > 0.01) {
    vec3 moss = vec3(dot(col, vec3(0.30, 0.59, 0.11))) * vec3(0.86, 0.96, 0.68);
    col = mix(col, moss * 0.88, steepG * 0.62);
  }

  // DRIED-MUD CRAZING, at WORLD scale.
  //
  // This pattern used to live in the dirt recipe's own height channel, where
  // the 16-cells-per-tile albedo floor (see library.ts rule 2) forced it to a
  // ~15cm cell — and 15cm polygonal cells with a bevelled rim, at one frequency,
  // covering every square metre of verge, is the crocodile skin the capture
  // shows across the whole near field. Worse, being in HEIGHT it drove the
  // category height-blend, so grass won in every cell gutter and green bled
  // through the lattice.
  //
  // Rebuilt here: 0.6-1.1m cells (impossible inside a 2.4m baked tile), ALBEDO
  // ONLY so it cannot emboss or leak into the splat blend, weighted by an
  // independent dryness field with a decorrelated hash offset so it appears in
  // patches, and faded out by 26m so it is a near-field material cue rather
  // than a texture that tiles to the horizon.
  float dryM = smoothstep(0.44, 0.72, tvn(vWPos.xz * 0.105 + vec2(37.4, 11.9)));
  gCrack = 0.0;
  float dirtish = clamp(gW.y + gRoadW * 0.6, 0.0, 1.0);
  if (dirtish * dryM > 0.02) {
    float cellA = abs(tvn(vWPos.xz * 1.15) - 0.5);
    float cellB = abs(tvn(vWPos.xz * 0.52 + 21.3) - 0.5);
    gCrack = ((1.0 - smoothstep(0.012, 0.052, cellA)) * 0.62
            + (1.0 - smoothstep(0.010, 0.042, cellB)) * 0.38)
           * dryM * dirtish * (1.0 - smoothstep(9.0, 26.0, gDist));
    col *= 1.0 - gCrack * 0.17;
  }
  // Per-parcel value jitter on the dirt, on a rotated lattice, so the baked
  // tile's own period stops being the only signal in the verge.
  if (gW.y > 0.02) {
    vec2 drot = vec2(vWPos.x * 0.6 - vWPos.z * 0.8, vWPos.x * 0.8 + vWPos.z * 0.6);
    col *= mix(vec3(1.0), vec3(0.86 + 0.28 * tvn(drot * 0.47)), gW.y);
  }

  // Parcel hue, plough furrows and the margin that closes each field.
  float farm = gFld.a;
  if (farm > 0.01) {
    col *= mix(vec3(1.0), parcelTint(gFld.r), farm * (0.55 + 0.45 * gW.x));
    // Margin narrowed 0.30 -> 0.11 of the parcel's edge-distance channel. A
    // surveyed field ENDS; it does not dissolve over five metres into its
    // neighbour, and the soft boundary was the single most PUBG-specific miss
    // in the vista — Erangel farmland is legible from 800m precisely because
    // the edges are human and straight.
    float marg = 1.0 - smoothstep(0.0, 0.11, gFld.b);
    // Not every parcel is a ploughed crop — roughly a third stay as pasture,
    // otherwise the whole island reads as corduroy.
    float rowed = smoothstep(0.30, 0.40, fract(gFld.r * 3.11));
    if (rowed > 0.01) {
      // Row angle comes off the parcel's own hash channel, and the two source
      // channels are decorrelated (tone drives pitch, angle drives heading) so
      // neighbouring cells cannot land on the same hatch.
      float ang = gFld.g * 3.14159265 + fract(gFld.r * 11.7) * 0.9;
      vec2 fdir = vec2(cos(ang), sin(ang));
      float rowSpace = 0.6 + 1.9 * fract(gFld.r * 6.37) + 1.1 * fract(gFld.g * 4.31);
      float phase = dot(vWPos.xz, fdir) * 6.28318 / rowSpace;
      // Fade rows out once a pixel spans several rows. Pushed out from 1.4-4.2
      // to 2.2-6.0 so furrows survive to ~250m instead of dying near 90m, and
      // attenuated with range on top so the hatch cannot shimmer at the horizon.
      float aa = (1.0 - smoothstep(2.2, 6.0, fwidth(phase))) * (1.0 - smoothstep(90.0, 420.0, gDist) * 0.75);
      // Crop archetype: stubble rows are a hard sawtooth, standing cereal is a
      // soft sine. One re-tinted map for every parcel was the tell.
      float sharp = smoothstep(0.45, 0.75, fract(gFld.r * 2.7));
      float wave = mix(sin(phase), sign(sin(phase)) * pow(abs(sin(phase)), 0.45), sharp);
      col *= 1.0 + wave * 0.22 * farm * aa * rowed * (1.0 - marg);
    }
    // 2-4m scrubby unploughed strip along every cell boundary.
    col = mix(col, col * vec3(0.70, 0.72, 0.58), marg * farm * 0.85);
  }

  // Macro breakup: large luminance swings plus a slow warm/cool hue drift.
  // Sampled in world XZ ONLY — never in a warped or stretched UV, which is what
  // combed the fields into wood grain.
  float macro = tfbm(vWPos.xz * 0.0115);
  float macroMid = tfbm(vWPos.xz * 0.045);
  float macroB = tvn(vWPos.xz * 0.0031);
  // Second octave rotated 37 degrees at ~1/90m, to beat the first one's period.
  vec2 rot = vec2(vWPos.x * 0.799 - vWPos.z * 0.602, vWPos.x * 0.602 + vWPos.z * 0.799);
  float macroC = tvn(rot * 0.0111);
  // The macro stack used to swing albedo by up to 2.8x, which is THREE TIMES
  // the luminance range the lighting itself was producing — the ground read as
  // painted rather than lit because the texture noise really was the dominant
  // signal. Combined swing is now ~1.35x, and the third octave was moved out of
  // luminance into the hue term where it costs nothing.
  col *= 0.90 + 0.20 * macro;
  col *= 0.95 + 0.10 * macroMid;
  col *= mix(vec3(1.09, 1.02, 0.88), vec3(0.92, 0.97, 1.06), macroB * 0.7 + macroC * 0.3);

  // Worn rural track on top: twin wheel ruts read off the tent ramp.
  if (gRoadW > 0.003) {
    vec3 rc = stochCol(uRoadMap, vWPos.xz / 2.6, 2.3).rgb;
    // The tent ramp doubles as a lateral coordinate, so |offset from centre|
    // falls out of it for free, both ruts at once.
    float rut = smoothstep(0.055, 0.0, abs(gRoadT - 0.822));
    rc *= 1.0 - rut * 0.42;
    // Polished compacted crown between the ruts.
    rc *= 1.0 + smoothstep(0.045, 0.0, abs(gRoadT - 0.955)) * 0.18;
    rc *= 0.90 + 0.20 * tvn(vWPos.xz * 0.05);
    // Loose gravel scatter, then dust dragged in from the verge.
    rc *= 1.0 + smoothstep(0.34, 0.62, tvn(vWPos.xz * 1.7)) * smoothstep(0.80, 0.62, gRoadT) * 0.22;
    rc = mix(rc, rc * vec3(1.30, 1.16, 0.92), smoothstep(0.80, 0.66, gRoadT));
    // ERANGEL, not Miramar. The recipe base sits at hue ~34 degrees and the
    // frame read as orange-tan dried playa; an Erangel rural road is compacted
    // pale grey-brown. Red down 17%, blue up 10%.
    rc *= vec3(0.83, 0.93, 1.10);
    // Second rotated octave at ~1/97m so the single tiling period stops being
    // the only macro signal on the surface.
    vec2 rrot = vec2(vWPos.x * 0.7986 - vWPos.z * 0.6018, vWPos.x * 0.6018 + vWPos.z * 0.7986);
    rc *= 0.86 + 0.28 * tvn(rrot * 0.0103);
    col = mix(col, rc, gRoadW);
  }

  // Wet line. Measured backwards in cycle 3: sand AT the waterline came out
  // 226,218,205 against 209,198,159 ten metres inland, i.e. brighter and less
  // saturated exactly where it should be darker and more saturated. The dry
  // beach lift reached all the way down to the water and the wet darkening was
  // both too weak and spread over 0.75m of height.
  //
  // Now: a dry pale sand band above 0.9m, and a 0.42m wet run-up band that
  // takes albedo down to ~0.55 and pushes it cool, with the boundary breathing
  // on the same frame clock the sea uses so the line is not painted on.
  float aboveSea = vWPos.y - ${SEA_Y.toFixed(2)};
  float beach = smoothstep(7.0, 1.6, vWPos.y) * gW.y;
  // Dry lift cut 0.80 -> 0.50 and pulled off white. The capture measured sand
  // at the waterline at value 0.93 against dry sand up the beach at 0.80 —
  // inverted, and the dry end was blowing out on its own.
  col = mix(col, col * vec3(1.13, 1.05, 0.91), beach * 0.50);
  // WET BAND. 0.42m of vertical run-up is a couple of screen pixels on a
  // shallow shore, which is why a row scan from water to dry sand rose
  // monotonically with no dark band anywhere in it. A real swash reaches well
  // over a metre of vertical on a 1-in-20 beach, and the wet strip is the
  // single most legible thing about a shoreline.
  float runUp = 1.30 + 0.45 * sin(tvn(vWPos.xz * 0.045) * 6.2832);
  gWet = smoothstep(runUp, -0.10, aboveSea) * smoothstep(9.0, 3.0, vWPos.y);
  col *= mix(vec3(1.0), vec3(0.50, 0.51, 0.55), gWet);
  // SWASH LINE: the bright salt/foam rim left at the top of the last run-up,
  // sitting between the wet strip and the dry sand. Without it the wet band is
  // a gradient rather than an event.
  float sw = (1.0 - smoothstep(0.0, 0.26, abs(aboveSea - runUp))) * beach;
  col = mix(col, col * 1.24 + vec3(0.035), sw * 0.55);
  // A second, seaward break line 6-9m out, driven by the same low-frequency
  // field so it stays parallel to the shore without needing a shore normal.
  float brk = (1.0 - smoothstep(0.0, 0.16, abs(aboveSea - runUp * 0.34))) * beach;
  col = mix(col, col * 1.16, brk * 0.35);

  // NEAR-FIELD GRAIN. DETAIL_TILE is 3m against a 1024 bake, i.e. ~2.9mm per
  // texel at the tile but only ~6 texels per screen pixel at 2-4m — which is
  // why a ground autocorrelation at 8px lag measured 0.93 and the first three
  // metres of every eye-level frame were a bilinear smear. This resamples the
  // same recipes at 0.42m for roughly 7x the texel density inside 15m, using
  // the HEIGHT channel so it adds relief without shifting hue. Two octaves: a
  // clod scale and a soil-speck scale, the second only in the first 6m.
  if (gFine > 0.01) {
    vec2 fuv = vWPos.xz / ${FINE_TILE.toFixed(2)};
    float g1 = texture2D(uGrassMap, fuv + stochOff(fuv * 0.11, 8.1)).a;
    float g2 = texture2D(uDirtMap, fuv * 3.8 + 4.7).a;
    float micro = 1.0 - smoothstep(2.0, 9.0, gDist);
    // WEIGHTED BY THE CATEGORY THAT IS ACTUALLY THERE. Unweighted, the dirt
    // recipe's crack network — which lives in its HEIGHT channel, so it rides
    // this band, not the albedo — was modulated onto grass and road alike. That
    // is the dried-playa polygon pattern the critic tracked 8-10m past the road
    // edge and straight under the green splat: it was never masked to anything.
    float dw = clamp(gW.y + gRoadW, 0.0, 1.0);
    float gwt = clamp(1.0 - dw, 0.0, 1.0);
    // Dirt detail deliberately quieter and finer than the grass band (0.34 at
    // a 0.75m cell read as Miramar dried playa across the whole near road, and
    // Erangel roads are compacted grey-brown dirt, not cracked lakebed).
    col *= 1.0
         + (g1 - 0.5) * 0.36 * gFine * gwt
         + (g2 - 0.5) * 0.21 * gFine * dw
         + (g2 - 0.5) * 0.12 * micro * dw;
  }

  // Cloud shadow (baked into the occlusion map's alpha) attenuates the key
  // further down; nothing to compute here.
  diffuseColor.rgb *= col;
}`
        )
        .replace(
          '#include <lights_fragment_begin>',
          `#include <lights_fragment_begin>
  // Terrain self-shadow and cloud shadow attenuate the KEY only; the sky fill
  // still reaches the ground inside them, which is what keeps a shadowed valley
  // readable rather than dead. RE_Direct has already run by this point, so
  // reflectedLight.directDiffuse is the complete direct term.
  reflectedLight.directDiffuse *= gKey;
  reflectedLight.directSpecular *= gKey;`
        )
        .replace(
          '#include <lights_fragment_maps>',
          `#include <lights_fragment_maps>
  {
    // EXPLICIT SKY IRRADIANCE. This is the term whose absence made 64% of the
    // hill-ridge shadow measure exactly (0,0,0) and 53.9% of the whole hillside
    // read as a hole in the frame. It is added to the irradiance sum and is
    // NEVER multiplied by gKey — a surface loses the sun in shadow, it does not
    // lose the sky. Only the baked sky occlusion (gAmb) attenuates it, which is
    // where AO physically belongs.
    //
    // Two lobes, which is the cheap stand-in for an SH-L2 projection of the
    // dome and costs about six instructions:
    //   sky:    weighted by how much of the hemisphere the facet can see,
    //           blue-shifted, so a shadow reads as "the sun was subtracted"
    //           rather than "the exposure fell". Measured B/R in cycle 3's
    //           residual was 0.548 — WARMER than neutral, i.e. carrying no
    //           skylight chroma at all.
    //   ground: the warm bounce that keeps downward-facing facets and the
    //           undersides of banks off zero.
    float ny = clamp(gGeoN.y, -1.0, 1.0);
    vec3 skyA = uSkyIrr * (0.55 + 0.45 * ny);
    vec3 gndA = uGndIrr * (0.45 - 0.45 * ny);
    irradiance += skyA + gndA;
    irradiance *= gAmb;
    iblIrradiance *= gAmb;
    radiance *= gAmb;
  }`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `{
  // Detail normals are a near-field effect on flat ground; past 260m the
  // geometry normal plus the albedo carry it. Rock is the exception — a 100m
  // face at 400m still needs its surface or it goes optically flat.
  if (gDist < 260.0 || gW.z > 0.15) {
    vec2 duv = vWPos.xz / ${DETAIL_TILE.toFixed(2)};
    vec3 nt = vec3(0.0, 0.0, 1.0);
    if (gW.x > 0.004) nt += gW.x * stochNrm(uGrassN, duv, 0.0);
    if (gW.y > 0.004) nt += gW.y * stochNrm(uDirtN, duv * 1.25, 3.7);
    if (gRoadW > 0.003) nt = mix(nt, texture2D(uRoadN, vWPos.xz / 3.1).xyz * 2.0 - 1.0, gRoadW);
    nt.xy *= 1.0 - smoothstep(120.0, 260.0, gDist);
    // Micro-relief in the first 15m, at the same 0.42m tile the albedo grain
    // uses. Without a real tangent-space normal here the near ground has no
    // shading response at all and none of the lighting work upstream shows.
    if (gFine > 0.01) {
      vec2 fuv = vWPos.xz / ${FINE_TILE.toFixed(2)};
      vec3 fn = texture2D(uGrassN, fuv + stochOff(fuv * 0.11, 8.1)).xyz * 2.0 - 1.0;
      vec3 fm = texture2D(uDirtN, fuv * 3.8 + 4.7).xyz * 2.0 - 1.0;
      // Matched to the albedo band above: the same category weights, so a crack
      // that is not in the albedo cannot appear in the relief either. Strength
      // up (0.85/0.45 -> 1.15/0.90) because this is the ONLY thing giving the
      // first ten metres a per-pixel response to sun angle; without it the
      // ground is lit flat off the interpolated vertex normal and reads painted.
      float dwn = clamp(gW.y + gRoadW, 0.0, 1.0);
      float gwn = clamp(1.0 - dwn, 0.0, 1.0);
      // Dirt relief halved (0.62/0.28 -> 0.32/0.15). With the crack network out
      // of the recipe's height channel the remaining signal is genuine soil
      // grain, and at the old strength it was still reading as embossed plastic.
      nt.xy += fn.xy * 1.15 * gFine * gwn
             + fm.xy * 0.32 * gFine * dwn
             + fm.xy * 0.15 * gFine * dwn * (1.0 - smoothstep(2.0, 9.0, gDist));
      // Wet-sand ripple marks: a 0.4m corrugation that only exists inside the
      // swash band, which is where every real beach has them.
      if (gWet > 0.02) {
        vec2 rp = vWPos.xz * 2.5;
        float r0 = tvn(rp), rx = tvn(rp + vec2(0.2, 0.0)), rz = tvn(rp + vec2(0.0, 0.2));
        nt.xy += (vec2(rx, rz) - r0) * 3.4 * gWet * gFine;
      }
    }
    nt = normalize(nt);
    // Tangent frame for a heightfield: T=+X, B=+Z around the world normal.
    vec3 wN = gGeoN;
    vec3 wT = normalize(cross(vec3(0.0, 0.0, 1.0), wN));
    vec3 wB = cross(wN, wT);
    vec3 perturbed = normalize(wT * nt.x + wB * nt.y + wN * nt.z);
    if (gW.z > 0.02) {
      vec3 tw2 = triWeights(wN);
      vec3 rn = triNrmWorld(uRockN, vWPos, 1.0 / 6.0, tw2, wN);
      // Near-field rock carries its surface at 0.8; the distance rolloff still
      // pulls it back toward the landform normal past 320m so a face at vista
      // range does not dissolve into noise.
      rn = normalize(mix(wN, rn, 0.80 - smoothstep(320.0, 620.0, gDist) * 0.50));
      perturbed = normalize(mix(perturbed, rn, gW.z));
      // BEDDING into the normal. The beds are horizontal planes, so the tilt
      // axis is world up projected into the surface's tangent plane: stepping
      // the normal along it makes each bed catch or lose the key instead of
      // only tinting. This is what puts legible strata on the peak.
      vec3 upT = vec3(-wN.x * wN.y, 1.0 - wN.y * wN.y, -wN.z * wN.y);
      float ul = length(upT);
      if (ul > 0.05) {
        float bedAmt = gW.z * (1.0 - smoothstep(260.0, 700.0, gDist)) * 0.68;
        perturbed = normalize(perturbed + (upT / ul) * gBedD * bedAmt);
      }
      // THE EMPTY 0.5-5m BAND. The rock had exactly two frequencies on it: a
      // ~5cm grain from the 6m triplanar tile, and the landform itself. Nothing
      // in between, which is why the ridge had no readable scale and could have
      // been three metres tall or three hundred. Two procedural gradient octaves
      // at roughly 1.6m and 6m, the second rotated 37 degrees so they cannot
      // beat into one direction, evaluated in WORLD space so the frequency falls
      // off correctly with distance. Six value-noise taps, no texture units, and
      // it only runs on rock pixels.
      gRockD = gW.z * (1.0 - smoothstep(300.0, 820.0, gDist));
      if (gRockD > 0.02) {
        vec2 mp = vWPos.xz * 0.62;
        vec2 mq = vec2(vWPos.x * 0.799 - vWPos.z * 0.602,
                       vWPos.x * 0.602 + vWPos.z * 0.799) * 0.168;
        float m0 = tvn(mp);
        float m1 = tvn(mp + vec2(0.17, 0.0));
        float m2 = tvn(mp + vec2(0.0, 0.17));
        float q0 = tvn(mq);
        float q1 = tvn(mq + vec2(0.17, 0.0));
        float q2 = tvn(mq + vec2(0.0, 0.17));
        vec2 mg = (vec2(m1, m2) - m0) * 3.2 + (vec2(q1, q2) - q0) * 6.2;
        perturbed = normalize(perturbed - vec3(mg.x, 0.0, mg.y) * gRockD);
      }
    }
    // EROSION CHANNELS on anything past ~25 degrees. A ridged field at ~1/34m,
    // differentiated in world XZ and pushed into the normal, so slopes gain
    // gullies and ridgelines gain crest structure instead of doming into a
    // smooth blob wearing a uniform fine bump. Two extra value-noise taps, no
    // geometry, and it costs nothing on the flat because of the slope gate.
    float steep = smoothstep(0.40, 0.68, 1.0 - wN.y);
    if (steep > 0.01) {
      vec2 ep = vWPos.xz * 0.029;
      float e0 = abs(tvn(ep) - 0.5);
      float ex = abs(tvn(ep + vec2(0.14, 0.0)) - 0.5);
      float ez = abs(tvn(ep + vec2(0.0, 0.14)) - 0.5);
      vec2 eg = (vec2(ex, ez) - e0) * 7.1;
      float amt = steep * (1.0 - smoothstep(320.0, 950.0, gDist)) * 0.55;
      perturbed = normalize(perturbed - vec3(eg.x, 0.0, eg.y) * amt);
    }
    normal = normalize((viewMatrix * vec4(perturbed, 0.0)).xyz);
  }
}`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = roughness;
{
  // Rock roughness is driven by the bedding mask, 0.55 to 0.88: weathered and
  // polished bands then separate under the key instead of one flat 0.82 that
  // never catches a sheen anywhere on the peak. Grass and dirt keep a small
  // macro variance so open field is not one constant value either.
  float rRock = mix(0.55, 0.88, gBed) + (tvn(vWPos.xz * 0.09) - 0.5) * 0.10;
  roughnessFactor = gW.x * (0.93 + (tvn(vWPos.xz * 0.031) - 0.5) * 0.08)
                  + gW.y * 0.94
                  + gW.z * rRock;
  roughnessFactor = mix(roughnessFactor, 0.80, gRoadW);
  // Wet sand is the only glossy thing on this island.
  roughnessFactor = mix(roughnessFactor, 0.15, gWet * 0.88);
  roughnessFactor = clamp(roughnessFactor, 0.10, 1.0);
}`
        )
        .replace(
          '#include <fog_fragment>',
          `{
  // AERIAL PERSPECTIVE, with the in-scatter read off the SAME DOME the camera
  // sees behind the pixel.
  //
  // Cycle 3 fogged the land toward one hand-authored cool constant, the sea
  // toward a second and the sky toward a third, and the three drifted: the
  // horizon field measured saturation 0.340 against a haze band at 0.023, and
  // the sea under the horizon came out 33/255 DARKER than the sky above it, so
  // the skyline was a drawn line rather than a dissolve. Sampling the sky cube
  // along the view ray makes convergence structural — as the fog factor goes to
  // 1 the surface literally becomes the sky pixel it is standing in front of.
  vec3 vdir = normalize(vWPos - cameraPosition);
  // Clamp the sample just above the horizon: distant ground is seen a couple of
  // degrees BELOW horizontal, and the dome below y=0 is extrapolation.
  vec3 sdir = normalize(vec3(vdir.x, max(vdir.y, 0.004), vdir.z));
  vec3 fc = textureCube(uSkyCube, sdir).rgb;

  float hAvg = max(0.5 * (vWPos.y + cameraPosition.y), 0.0);
  float dens = fogDensity * exp(-hAvg / uFogHeight);
  float fx = dens * vFogDepth;
  // Cap 0.985 -> 0.945. At 0.985 a ridge at 1km was 98% the sky's own value and
  // the reference's distant hills measure value 0.47 against a sky of 0.75 —
  // they are emphatically still hills. 0.945 plus the lower base density lands
  // the same range near 0.60 fogged instead of 0.98.
  float amt = min(1.0 - exp(-fx * fx), 0.945);

  // MIE FORWARD SCATTER on top of the dome sample. Haze brightens and warms
  // hard toward the sun and stays cool away from it; the dome already carries
  // some of this, but the near-field dust column the camera looks through does
  // not exist in the dome at all.
  float fwd = max(dot(vdir, uSunDir), 0.0);
  float mie = pow(fwd, 7.0) * 0.40 + pow(fwd, 2.0) * 0.10;
  fc *= mix(vec3(1.0), uSunTint * vec3(1.34, 1.20, 1.02), clamp(mie, 0.0, 1.0));

  // MULTIPLE-SCATTERING DESATURATION. Cut 0.66 -> 0.16.
  //
  // This term was the wrong answer to the right observation. Chroma does have
  // to fall with range, but the reference does NOT lose it — PUBG holds ground
  // saturation at 0.423 / 0.353 / 0.320 across near / mid / far while the build
  // ran 0.411 / 0.256 / 0.059, and its distant hills come out at hue 224,
  // saturation 0.111, i.e. they gained BLUE rather than going achromatic. A
  // luminance mix cannot produce that; only an in-scatter colour that is itself
  // chromatic can, which is what the horizon rewrite in sky.ts now supplies.
  // What is left here is a token amount of true multiple scattering.
  vec3 surf = gl_FragColor.rgb;
  surf = mix(surf, vec3(dot(surf, vec3(0.2126, 0.7152, 0.0722))), clamp(amt * 1.4, 0.0, 1.0) * 0.16);
  gl_FragColor.rgb = mix(surf, fc, amt);
}`
        );
    };

    // Distinct program cache key so three doesn't share the patched shader.
    mat.customProgramCacheKey = () => `terrain-splat-v7${quality.terrainCheap ? '-cheap' : ''}`;
    return mat;
  }
}
