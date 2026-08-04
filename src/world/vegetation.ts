import * as THREE from 'three';
import { NoiseField, clamp, hash2, smoothstep, voronoiCell } from '../gen/noise';
import { MAP_SIZE, type Heightfield } from '../gen/terraingen';
import { makeBarkMaps, deadTreeGeometry } from '../gen/treegen';
import {
  CLUMP_TILES, COVER_TILES, LEAF_TILES, SWATH_TILES,
  makeCanopyTexture, makeCoverAtlas, makeLeafAtlas,
} from '../gen/veg-atlas';
import {
  COVER_DRY, COVER_DRY_GAIN, COVER_KINDS, COVER_SIZE, coverGeometry, type CoverKind,
} from '../gen/veg-blades';
import {
  BUSH_VARIANTS, bushBranchGeometry, bushCrown, snagCrown, treeCrown, treeSkeleton,
  type BushVariant, type FoliageCard, type TreeSpecies,
} from '../gen/veg-trees';
import {
  bladeMaterial, carpetMaterial, coverCardMaterial, foliageCardMaterial, foliageDepthMaterial,
  type VegLightParams,
} from './veg-shaders';
import { sunDirectionFor, sunElevationFor } from './sky';
import { parseBootParams, quality } from '../core/settings';
import type { PhysicsWorld } from '../player/physics';
import type { System } from '../core/engine';

// Vegetation in four layers, because one layer is what made cycle 1 read as a
// placeholder scatter:
//
//   1. GROUND CARPET  — a camera-following sheet hugging the terrain, textured
//      with a top-down grass canopy. It is why the world no longer ends in a
//      bare arc: the ground past the instance rings is already vegetated, so
//      the rings have nothing to reveal when they fade.
//   2. NEAR COVER     — REAL instanced blade geometry, six archetypes, out to
//      ~20 m. No alpha test, no billboarding, roots buried below the terrain.
//   3. MID / FAR COVER— cutout cards off a coverage-corrected atlas, 13-72 m
//      and 78-145 m, cross-faded by instance SCALE so no ring edge exists.
//   4. WOODY          — three tree species (oak / birch / Scots pine) built
//      from a branch skeleton plus leaf-CLUSTER cards, dead snags, and two
//      bush variants. Every card in layer 4 rides one instanced draw.
//
// Species selection, dryness and density all read a baked mask: coverage
// (slope/height/road/yard), forest, vigor and a per-parcel DRYNESS taken from
// the same crop palette the terrain shader uses. That is what makes wheat
// parcels go straw-gold and pasture stay green, in patches, instead of every
// species interleaving uniformly.

const MASK_RES = 256;
/**
 * Contact + cast-shadow grid. 512 was 2.34 m/texel, far too coarse to darken
 * the 40 cm ring where a trunk meets the sward, so every trunk read as pushed
 * into the grass; 1024 is 1.17 m/texel, which holds a trunk collar AND the
 * raked directional shadow the woody layer now splats into it.
 */
const SHADE_RES = 1024;

/** Near ring: real geometry. Small cell => cheap, frequent rebuilds. */
const CELL_N = 6;
const NEAR_FULL = 13;
const NEAR_END = 21;
// 22.0, not 24.5: the tier's own fade zeroes an instance's scale by 21 m, so
// every clump placed past that was pure vertex cost for degenerate triangles.
const NEAR_PLACE = 22.0;
const NEAR_PER_M2 = 3.9;
/** Multiplier on near density at the camera, decaying to 1.0 by NEAR_DENSE_END. */
const NEAR_DENSE_GAIN = 2.1;
const NEAR_DENSE_START = 4.0;
const NEAR_DENSE_END = 14.0;

/** Mid ring: single-clump cards. Bands widened over cycle 2 so the hand-over
 *  spans 10 m instead of 7 — a short band is a readable ring. */
const CELL_F = 24;
const MID_IN0 = 10, MID_IN1 = 20;
const MID_OUT0 = 48, MID_OUT1 = 76;
const MID_PLACE = 92;
const MID_PER_M2 = 1.90;

/**
 * Far ring: wide multi-clump swathes. Pulled forward to 30 m so the swath layer
 * UNDERLAPS the clump band instead of starting where it ends — the mid band
 * needs a low-frequency mass under its clump-frequency detail, or it reads as
 * discrete ornaments scattered on a lawn no matter how many of them there are.
 */
const FAR_IN0 = 30, FAR_IN1 = 58;
const FAR_OUT0 = 112, FAR_OUT1 = 152;
const FAR_PLACE = 168;
const FAR_PER_M2 = 0.26;

const CARPET_R = 190;
const CARPET_RINGS = 56;
const CARPET_SPOKES = 84;
/** Radius inside which the carpet reconstructs the exact terrain triangle plane. */
const CARPET_EXACT_R = 100;

const MAX_TREES = 3000;
const MAX_BUSHES = 5200;
const TREE_SPACING = 5.0;
const BUSH_SPACING = 4.0;

/** Per-archetype share of the near cap (sums above 1 on purpose: headroom). */
const NEAR_SHARE: Record<CoverKind, number> = {
  tussock: 0.52, dry: 0.55, mat: 0.46, dock: 0.30, fern: 0.34, herb: 0.30,
};

interface BuildingDisc { x: number; z: number; r: number }

/**
 * The terrain mesh samples hf.height on a FIXED lattice — MAP_SIZE / CHUNKS /
 * CHUNK_QUADS = 300/128 = 2.34375 m — and splits each cell along its b-c
 * anti-diagonal. Anything that has to LIE ON that surface must reconstruct the
 * same triangle plane rather than query the analytic height: across a hollow the
 * flat triangle sits ABOVE the analytic value, so a ground-hugging sheet planted
 * at hf.height + 3 cm vanishes under it.
 *
 * That is exactly what had happened to the ground carpet. A red-channel probe
 * capture in cycle 3 showed the sheet surfacing only past ~100 m, where its
 * distance lift finally exceeded the interpolation error — meaning the entire
 * near-field ground layer (and with it every tree contact pool) had been
 * invisible since it was written in cycle 2, which is why the terrain plate
 * between the blades stayed a bright yellow-green that no amount of tuning on
 * the carpet's own colour could change.
 */
const TERRAIN_STEP = 300 / 128;

function terrainSurfaceY(hf: Heightfield, x: number, z: number): number {
  const gx = (x + MAP_SIZE / 2) / TERRAIN_STEP;
  const gz = (z + MAP_SIZE / 2) / TERRAIN_STEP;
  const i = Math.floor(gx);
  const j = Math.floor(gz);
  const u = gx - i;
  const v = gz - j;
  const x0 = -MAP_SIZE / 2 + i * TERRAIN_STEP;
  const z0 = -MAP_SIZE / 2 + j * TERRAIN_STEP;
  const a = hf.height(x0, z0);
  const b = hf.height(x0 + TERRAIN_STEP, z0);
  const c = hf.height(x0, z0 + TERRAIN_STEP);
  if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
  const d = hf.height(x0 + TERRAIN_STEP, z0 + TERRAIN_STEP);
  return d + (b - d) * (1 - v) + (c - d) * (1 - u);
}

/** Crop families, mirrored from the terrain shader's parcelTint(). */
function parcelTint(t: number): [number, number, number] {
  if (t < 0.12) return [0.72, 0.84, 0.52];
  if (t < 0.34) return [1.30, 1.10, 0.66];
  if (t < 0.48) return [1.02, 0.98, 0.72];
  if (t < 0.70) return [1.42, 1.22, 0.80];
  if (t < 0.82) return [0.60, 0.70, 0.46];
  return [1.10, 0.88, 0.62];
}
/** How dry each crop family reads. Wheat and stubble are straw; pasture is not. */
function parcelDryness(t: number): number {
  if (t < 0.12) return 0.04;
  if (t < 0.34) return 0.74;
  if (t < 0.48) return 0.30;
  if (t < 0.70) return 0.84;
  if (t < 0.82) return 0.04;
  return 0.55;
}

// Approximate linear albedo of the baked terrain layers. Only the RATIOS matter
// — this drives a hue pull, never a brightness set.
const GRASS_A: [number, number, number] = [0.112, 0.126, 0.056];
const DIRT_A: [number, number, number] = [0.150, 0.114, 0.072];
const ROCK_A: [number, number, number] = [0.132, 0.130, 0.120];

class VegetationMask {
  readonly grass = new Uint8Array(MASK_RES * MASK_RES);
  readonly forest = new Uint8Array(MASK_RES * MASK_RES);
  readonly vigor = new Uint8Array(MASK_RES * MASK_RES);
  readonly built = new Uint8Array(MASK_RES * MASK_RES);
  /** 0 lush .. 1 straw, in coherent parcel-sized patches. */
  readonly dry = new Uint8Array(MASK_RES * MASK_RES);
  /** Terrain height, bilinear-sampled for the mid/far tiers (saves ~25 ms/rebuild). */
  readonly hgt = new Float32Array(MASK_RES * MASK_RES);
  /** Terrain albedo estimate, linear, 3 floats per texel. */
  readonly tint = new Float32Array(MASK_RES * MASK_RES * 3);
  /**
   * Ground-contact occlusion, splatted from the woody layer after planting.
   * This is the whole of finding 13 in one array: without it the terrain
   * between and beneath the sward renders exactly as bright as open ground and
   * every trunk reads as pasted onto a lit plane.
   */
  readonly shade = new Float32Array(SHADE_RES * SHADE_RES);
  readonly step = MAP_SIZE / MASK_RES;
  private readonly shadeStep = MAP_SIZE / SHADE_RES;

  constructor(hf: Heightfield, seed: number, buildings: BuildingDisc[]) {
    const forestNoise = new NoiseField(seed + 707);
    const meadowNoise = new NoiseField(seed + 811);
    const dryNoise = new NoiseField(seed + 919);
    const step = this.step;
    let p = 0;
    for (let j = 0; j < MASK_RES; j++) {
      for (let i = 0; i < MASK_RES; i++) {
        const x = -MAP_SIZE / 2 + (i + 0.5) * step;
        const z = -MAP_SIZE / 2 + (j + 0.5) * step;
        const s = hf.surface(x, z);
        const h = s.height;
        const slope = hf.slope(x, z);
        const road = hf.roadDistance(x, z);
        this.hgt[p] = h;

        let prox = 0;
        for (const b of buildings) {
          const d = Math.hypot(x - b.x, z - b.z);
          if (d > b.r + 20) continue;
          const t = smoothstep(b.r + 18, b.r + 1.5, d);
          if (t > prox) prox = t;
        }
        this.built[p] = Math.round(prox * 255);

        let g = 1;
        if (h < 2.2 || h > 55) g = 0;
        else {
          g *= Math.min(1, Math.max(0, (0.3 - slope) / 0.3));
          g *= Math.min(1, Math.max(0, (road - 5.0) / 6));
          g *= 1 - prox * 0.82;
          // Lush cover does not grow on cracked dry ground or bare rock.
          g *= clamp(1 - s.splat.rock * 1.4, 0, 1);
        }
        this.grass[p] = Math.round(g * 255);

        const meadow = meadowNoise.fbm(x / 190, z / 190, { octaves: 3 }) * 0.5 + 0.5;
        let vig = smoothstep(6.5, 22, road);
        vig *= 1 - prox * 0.7;
        vig *= 0.52 + meadow * 0.58;
        this.vigor[p] = Math.round(Math.min(1, Math.max(0, vig)) * 255);

        // Woodland runs UP the hillsides here. Cycle 1 gated forest on
        // slope < 0.24, which excluded every ridge — so the pose literally
        // named "treeline" had no treeline in it.
        let f = 0;
        if (h > 3 && h < 54 && slope < 0.42 && road > 12 && prox < 0.05) {
          const n = forestNoise.warped(x / 240 + 3.1, z / 240 - 7.7, 0.8, { octaves: 3 });
          f = n > 0.24 ? Math.min(1, (n - 0.24) * 3.4) : 0;
          f *= Math.min(1, Math.max(0, (0.44 - slope) / 0.18));
        }
        this.forest[p] = Math.round(f * 255);

        // Dryness follows the CROP PARCEL, so straw and green form coherent
        // field-sized patches instead of interleaving clump by clump.
        const farm = s.field.farm;
        const cropDry = parcelDryness(s.field.tone);
        const roam = dryNoise.fbm(x / 165 + 4.7, z / 165 - 2.3, { octaves: 3 }) * 0.5 + 0.5;
        // Pushed through a contrast curve rather than left as a wash: the
        // island wants straw FIELDS next to green FIELDS, not a uniform 0.45
        // everywhere, which is what turned every pose the same shade of hay.
        const roamC = clamp((roam - 0.42) * 2.1 + 0.30, 0, 1);
        let d = cropDry * farm + roamC * 0.80 * (1 - farm);
        d = clamp(d * (1 - f * 0.65) + s.splat.dirt * 0.16, 0, 1);
        this.dry[p] = Math.round(d * 255);

        // Terrain albedo estimate: splat mix, then the parcel crop tint.
        const w = s.splat;
        let R = w.grass * GRASS_A[0] + w.dirt * DIRT_A[0] + w.rock * ROCK_A[0];
        let G = w.grass * GRASS_A[1] + w.dirt * DIRT_A[1] + w.rock * ROCK_A[1];
        let B = w.grass * GRASS_A[2] + w.dirt * DIRT_A[2] + w.rock * ROCK_A[2];
        if (farm > 0.01) {
          const pt = parcelTint(s.field.tone);
          const k = farm * (0.55 + 0.45 * w.grass);
          R *= 1 + (pt[0] - 1) * k;
          G *= 1 + (pt[1] - 1) * k;
          B *= 1 + (pt[2] - 1) * k;
        }
        this.tint[p * 3] = R;
        this.tint[p * 3 + 1] = G;
        this.tint[p * 3 + 2] = B;
        p++;
      }
    }
  }

  private idx(x: number, z: number): number {
    const i = Math.floor(((x + MAP_SIZE / 2) / MAP_SIZE) * MASK_RES);
    const j = Math.floor(((z + MAP_SIZE / 2) / MAP_SIZE) * MASK_RES);
    if (i < 0 || j < 0 || i >= MASK_RES || j >= MASK_RES) return -1;
    return j * MASK_RES + i;
  }

  sample(arr: Uint8Array, x: number, z: number): number {
    const p = this.idx(x, z);
    return p < 0 ? 0 : arr[p] / 255;
  }

  /** Bilinear terrain height — accurate to a few cm at the ranges it is used. */
  heightAt(x: number, z: number): number {
    const fx = ((x + MAP_SIZE / 2) / MAP_SIZE) * MASK_RES - 0.5;
    const fz = ((z + MAP_SIZE / 2) / MAP_SIZE) * MASK_RES - 0.5;
    const i0 = Math.max(0, Math.min(MASK_RES - 2, Math.floor(fx)));
    const j0 = Math.max(0, Math.min(MASK_RES - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - i0));
    const tz = Math.max(0, Math.min(1, fz - j0));
    const a = this.hgt[j0 * MASK_RES + i0];
    const b = this.hgt[j0 * MASK_RES + i0 + 1];
    const c = this.hgt[(j0 + 1) * MASK_RES + i0];
    const d = this.hgt[(j0 + 1) * MASK_RES + i0 + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  /** Smooth terrain normal off the height grid — 1 lookup instead of 4 hf calls. */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = this.step;
    const nx = (this.heightAt(x - e, z) - this.heightAt(x + e, z)) / (2 * e);
    const nz = (this.heightAt(x, z - e) - this.heightAt(x, z + e)) / (2 * e);
    return out.set(nx, 1, nz).normalize();
  }

  tintAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.idx(x, z);
    if (p < 0) return out.set(GRASS_A[0], GRASS_A[1], GRASS_A[2]);
    return out.set(this.tint[p * 3], this.tint[p * 3 + 1], this.tint[p * 3 + 2]);
  }

  /** Splat one soft radial contact pool. Max-combined, so overlapping crowns
   *  deepen the pool instead of summing past 1. */
  addShade(x: number, z: number, radius: number, strength: number): void {
    const s = this.shadeStep;
    const cx = (x + MAP_SIZE / 2) / s;
    const cz = (z + MAP_SIZE / 2) / s;
    const rr = radius / s;
    const i0 = Math.max(0, Math.floor(cx - rr));
    const i1 = Math.min(SHADE_RES - 1, Math.ceil(cx + rr));
    const j0 = Math.max(0, Math.floor(cz - rr));
    const j1 = Math.min(SHADE_RES - 1, Math.ceil(cz + rr));
    const r2 = rr * rr;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - cx;
        const dz = j + 0.5 - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const f = 1 - Math.sqrt(d2 / r2);
        const v = strength * f * f;
        const p = j * SHADE_RES + i;
        if (v > this.shade[p]) this.shade[p] = v;
      }
    }
  }

  /**
   * A raked CAST SHADOW, not just a contact pool: the crown pool is marched
   * along the ground away from the sun, widening and softening as it goes.
   *
   * The build's single 2048 shadow map is fitted to the whole visible frustum,
   * which at vista range is ~0.3-0.5 m/texel with a normal bias saturated at its
   * 0.35 m clamp — a 35 cm lookup offset erases every crown and contact shadow
   * in the frame, which is why full-sun trees drop nothing onto the grass. That
   * map lives in another lane's file. This does not need it: the woody layer
   * rasterises its own shadow into the coverage grid on the CPU, once, and every
   * vegetation layer already reads it through aShade.
   */
  addShadeStreak(
    x: number, z: number, dirX: number, dirZ: number,
    len: number, radius: number, strength: number
  ): void {
    this.addShade(x, z, radius * 0.62, strength);
    const steps = Math.max(1, Math.min(14, Math.ceil(len / Math.max(0.8, radius * 0.55))));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Widen and soften with distance from the caster: a crown shadow has a
      // hard collar at the trunk and a diffuse tail.
      this.addShade(
        x + dirX * len * t, z + dirZ * len * t,
        radius * (0.70 + 0.65 * t), strength * (1 - t * 0.55)
      );
    }
  }

  shadeAt(x: number, z: number): number {
    const fx = ((x + MAP_SIZE / 2) / MAP_SIZE) * SHADE_RES - 0.5;
    const fz = ((z + MAP_SIZE / 2) / MAP_SIZE) * SHADE_RES - 0.5;
    const i0 = Math.max(0, Math.min(SHADE_RES - 2, Math.floor(fx)));
    const j0 = Math.max(0, Math.min(SHADE_RES - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - i0));
    const tz = Math.max(0, Math.min(1, fz - j0));
    const a = this.shade[j0 * SHADE_RES + i0];
    const b = this.shade[j0 * SHADE_RES + i0 + 1];
    const c = this.shade[(j0 + 1) * SHADE_RES + i0];
    const d = this.shade[(j0 + 1) * SHADE_RES + i0 + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }
}

interface CoverTier {
  mesh: THREE.InstancedMesh;
  rand: THREE.InstancedBufferAttribute;
  dry: THREE.InstancedBufferAttribute;
  shade: THREE.InstancedBufferAttribute;
  /** Local sward density, so the shader can shut the sky out of a thick clump. */
  dens: THREE.InstancedBufferAttribute;
  tint: THREE.InstancedBufferAttribute;
  tile?: THREE.InstancedBufferAttribute;
  cap: number;
  n: number;
}

interface PlacedTree {
  x: number; z: number; y: number; h: number;
  yaw: number; leanX: number; leanZ: number; seed: number;
}

export class Vegetation implements System {
  readonly group = new THREE.Group();
  private mask: VegetationMask;
  private materials: THREE.ShaderMaterial[] = [];
  private near: Partial<Record<CoverKind, CoverTier>> = {};
  private mid!: CoverTier;
  private far!: CoverTier;
  private carpet!: THREE.Mesh;
  private carpetPos!: THREE.BufferAttribute;
  private carpetNrm!: THREE.BufferAttribute;
  private carpetCov!: THREE.BufferAttribute;
  private carpetDry!: THREE.BufferAttribute;
  private carpetShade!: THREE.BufferAttribute;
  private carpetTint!: THREE.BufferAttribute;
  private lastNearX = 1e9;
  private lastNearZ = 1e9;
  private lastFarX = 1e9;
  private lastFarZ = 1e9;
  private dummy = new THREE.Object3D();
  private tmpN = new THREE.Vector3();
  private tmpT = new THREE.Vector3();
  private qYaw = new THREE.Quaternion();
  private qTilt = new THREE.Quaternion();
  private light: VegLightParams;

  constructor(
    private hf: Heightfield,
    private camera: THREE.PerspectiveCamera,
    physics: PhysicsWorld,
    seed: number
  ) {
    const rawBoxes =
      (physics as unknown as { boxes?: { min: THREE.Vector3; max: THREE.Vector3; tag: string }[] }).boxes ?? [];
    const buildings: BuildingDisc[] = rawBoxes
      .filter((b) => b.tag === 'building')
      .map((b) => ({
        x: (b.min.x + b.max.x) * 0.5,
        z: (b.min.z + b.max.z) * 0.5,
        r: Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5,
      }));

    this.mask = new VegetationMask(hf, seed, buildings);
    this.light = buildLight();

    const coverAtlas = makeCoverAtlas(seed + 11);
    const leafAtlas = makeLeafAtlas(seed + 29);
    const canopy = makeCanopyTexture(seed + 41);

    this.buildNear(seed);
    this.buildCards(coverAtlas.tex, coverAtlas.mean);
    this.buildCarpet(canopy);
    this.plantWoody(leafAtlas, physics, seed);
  }

  // --- construction --------------------------------------------------------

  private nearCap(): number {
    return Math.round(
      Math.PI * NEAR_PLACE * NEAR_PLACE * NEAR_PER_M2 * NEAR_DENSE_GAIN * 0.62 * quality.grassDensity
    );
  }

  private buildNear(seed: number): void {
    const cap = this.nearCap();
    for (const kind of COVER_KINDS) {
      const geo = coverGeometry(kind, seed + kind.length * 313 + COVER_KINDS.indexOf(kind) * 1777);
      const n = Math.max(64, Math.round(cap * NEAR_SHARE[kind]));
      const mat = bladeMaterial({
        ...this.light,
        // Re-measured in cycle 3 against the Erangel field: the build ran hue
        // 48-60 at saturation 0.63-0.70 where the reference sits at hue 30-34,
        // saturation 0.39-0.50, with blue at two thirds of red rather than one
        // third. Both stops below hold S ~0.44 and B/R >= 0.55, which is what
        // takes the sward off chartreuse and lets the sky ambient reach it.
        // Re-measured a second time inside cycle 3, against the reference field
        // MEAN of RGB(98,82,63): the first pass was correctly desaturated but
        // roughly twice too BRIGHT, which reads as bleached bone rather than
        // straw and drags rendered saturation down to ~0.28. Lowering value
        // while holding chroma puts the lit face near RGB(150,123,88), leaves
        // the sheen room to carry the highlights, and lands rendered saturation
        // in the 0.39-0.50 band the reference occupies.
        lush: SWARD_LUSH.clone(),
        straw: SWARD_STRAW.clone(),
        // Umbels dimmed hard: at 0.33 they cleared luminance 195 in full sun and
        // read as scraps of white paper scattered through the sward. Cycle 4
        // gave them back a little chroma — the flower-field patches are the
        // meadow's only second read and a grey umbel carries none.
        flower: new THREE.Color(0.176, 0.150, 0.128),
        // Collapsed dead grass under the standing blades. Deliberately close to
        // the standing straw in VALUE (~70%): at a quarter of it the litter
        // read as black paper scraps scattered over a bright field.
        thatch: new THREE.Color(0.152, 0.120, 0.078),
        fadeIn: new THREE.Vector2(-2, -1),
        fadeOut: new THREE.Vector2(NEAR_FULL, NEAR_END),
        windAmp: kind === 'dock' || kind === 'fern' ? 0.45 : 1.0,
      });
      this.materials.push(mat);
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.count = 0;
      const tier: CoverTier = {
        mesh,
        rand: attach(geo, 'aRand', n, 1),
        dry: attach(geo, 'aDry', n, 1),
        shade: attach(geo, 'aShade', n, 1),
        dens: attach(geo, 'aDens', n, 1),
        tint: attach(geo, 'aTint', n, 3),
        cap: n,
        n: 0,
      };
      this.near[kind] = tier;
      this.group.add(mesh);
    }
  }

  private buildCards(atlas: THREE.Texture, atlasMean: THREE.Color): void {
    // The caps carry 1.39x the nominal density because the scatter draws 1.85x
    // as many CANDIDATES as it wants instances and the density mask accepts
    // ~55% of them: at 1.0x the tier ran out of instances part-way through the
    // disc and simply stopped placing, which truncates the far corner in cell
    // order and is itself one of the hard cover boundaries the critics read.
    const midCap = Math.round(Math.PI * MID_PLACE * MID_PLACE * MID_PER_M2 * 1.39 * quality.grassDensity);
    const farCap = Math.round(Math.PI * FAR_PLACE * FAR_PLACE * FAR_PER_M2 * 1.39 * quality.grassDensity);

    const make = (
      cap: number, fadeIn: THREE.Vector2, fadeOut: THREE.Vector2,
      wind: number, tint: number, tintAmt: THREE.Vector2
    ): CoverTier => {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.translate(0, 0.5, 0);
      const mat = coverCardMaterial({
        ...this.light, atlas, tiles: COVER_TILES, fadeIn, fadeOut, windAmp: wind, tintGain: tint, tintAmt,
        // The SAME palette pair the near band uses, so the two tiers cannot
        // disagree about what colour the field is.
        lush: SWARD_LUSH.clone(), straw: SWARD_STRAW.clone(), atlasMean,
      });
      this.materials.push(mat);
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.count = 0;
      const tier: CoverTier = {
        mesh,
        rand: attach(geo, 'aRand', cap, 1),
        dry: attach(geo, 'aDry', cap, 1),
        shade: attach(geo, 'aShade', cap, 1),
        dens: attach(geo, 'aDens', cap, 1),
        tint: attach(geo, 'aTint', cap, 3),
        tile: attach(geo, 'aTile', cap, 1),
        cap,
        n: 0,
      };
      this.group.add(mesh);
      return tier;
    };

    this.mid = make(
      midCap, new THREE.Vector2(MID_IN0, MID_IN1), new THREE.Vector2(MID_OUT0, MID_OUT1),
      0.85, 3.0, new THREE.Vector2(0.14, 0.48)
    );
    // The far tier is pulled hard toward the ground colour: past ~80 m a clump
    // reads as a texture on the field, and any hue offset shows up as a band of
    // confetti sitting on differently-coloured earth.
    this.far = make(
      farCap, new THREE.Vector2(FAR_IN0, FAR_IN1), new THREE.Vector2(FAR_OUT0, FAR_OUT1),
      0.5, 3.4, new THREE.Vector2(0.40, 0.66)
    );
  }

  private buildCarpet(canopy: THREE.Texture): void {
    const verts = (CARPET_RINGS + 1) * CARPET_SPOKES;
    const pos = new Float32Array(verts * 3);
    const nrm = new Float32Array(verts * 3);
    const cov = new Float32Array(verts);
    const dry = new Float32Array(verts);
    const shade = new Float32Array(verts);
    const tint = new Float32Array(verts * 3);
    const idx: number[] = [];
    for (let r = 0; r < CARPET_RINGS; r++) {
      for (let s = 0; s < CARPET_SPOKES; s++) {
        const s1 = (s + 1) % CARPET_SPOKES;
        const a = r * CARPET_SPOKES + s;
        const b = r * CARPET_SPOKES + s1;
        const c = (r + 1) * CARPET_SPOKES + s;
        const d = (r + 1) * CARPET_SPOKES + s1;
        // WINDING. This is the cycle-3 blocker: the fan used to be indexed
        // (a, c, b) / (b, c, d). Vertex a is at (cos t0, sin t0) * r0 and b is
        // one step further round in +theta, so cross(c - a, b - a) evaluates to
        // (0, -1, 0) — every triangle's front face pointed at the ground. With
        // side: FrontSide the whole sheet was back-face-culled from any camera
        // above it, which is why a red probe capture found no carpet in the
        // near field and why nothing done to its colour, height, polygon offset
        // or depth bias ever changed a pixel. Culling reads the SCREEN-SPACE
        // winding, not the normal attribute, so supplying an upward normal
        // (which this geometry always did) proves nothing.
        idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    this.carpetPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.carpetNrm = new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage);
    this.carpetCov = new THREE.BufferAttribute(cov, 1).setUsage(THREE.DynamicDrawUsage);
    this.carpetDry = new THREE.BufferAttribute(dry, 1).setUsage(THREE.DynamicDrawUsage);
    this.carpetShade = new THREE.BufferAttribute(shade, 1).setUsage(THREE.DynamicDrawUsage);
    this.carpetTint = new THREE.BufferAttribute(tint, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.carpetPos);
    geo.setAttribute('normal', this.carpetNrm);
    geo.setAttribute('aCov', this.carpetCov);
    geo.setAttribute('aDry', this.carpetDry);
    geo.setAttribute('aShade', this.carpetShade);
    geo.setAttribute('aTint', this.carpetTint);
    geo.setIndex(idx);
    const mat = carpetMaterial({ ...this.light, canopy, radius: CARPET_R });
    this.materials.push(mat);
    this.carpet = new THREE.Mesh(geo, mat);
    this.carpet.frustumCulled = false;
    this.carpet.renderOrder = -1;
    this.group.add(this.carpet);
  }

  // --- placement -----------------------------------------------------------

  /** Density-driven, blue-noise-ish scatter over the cells covering a disc. */
  private scatter(
    cell: number, radius: number, perCell: number, salt: number,
    centreX: number, centreZ: number,
    place: (x: number, z: number, k: number) => boolean
  ): void {
    const ccx = Math.floor(centreX / cell);
    const ccz = Math.floor(centreZ / cell);
    const span = Math.ceil(radius / cell) + 1;
    const r2 = radius * radius;
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        // Skip cells that cannot touch the disc.
        const nx = Math.max(cx * cell, Math.min(centreX, (cx + 1) * cell));
        const nz = Math.max(cz * cell, Math.min(centreZ, (cz + 1) * cell));
        const ddx = nx - centreX, ddz = nz - centreZ;
        if (ddx * ddx + ddz * ddz > r2) continue;
        for (let k = 0; k < perCell; k++) {
          // The multipliers have to exceed the per-cell sample count or the
          // hash arguments COLLIDE between neighbouring cells: cycle 3 used
          // cx * 31 + k with k running to ~1300 in the mid tier, so cell cx and
          // cell cx + 42 drew literally the same offsets. That is the visible
          // ranks-and-files rhythm the critics read straight off the crop, and
          // no amount of density noise on top of it could hide a repeat in the
          // POSITIONS themselves.
          const hx = hash2(cx * 6151 + k * 3, cz * 3079 + salt * 17, 71);
          const hz = hash2(cx * 2749 - k * 5, cz * 8221 + salt * 23, 73);
          const x = cx * cell + hx * cell;
          const z = cz * cell + hz * cell;
          const ex = x - centreX, ez = z - centreZ;
          if (ex * ex + ez * ez > r2) continue;
          if (!place(x, z, k)) continue;
        }
      }
    }
  }

  private refreshNear(): void {
    const ccx = Math.floor(this.camera.position.x / CELL_N);
    const ccz = Math.floor(this.camera.position.z / CELL_N);
    if (ccx === this.lastNearX && ccz === this.lastNearZ) return;
    this.lastNearX = ccx;
    this.lastNearZ = ccz;
    const centreX = (ccx + 0.5) * CELL_N;
    const centreZ = (ccz + 0.5) * CELL_N;

    for (const kind of COVER_KINDS) this.near[kind]!.n = 0;

    // Instances per cell so the disc lands on the target density. The 2-octave
    // density mask below then removes 30-55% of them in clusters, which is what
    // gives real bare voids and real thickets instead of uniform fill.
    // Sized for the CAMERA-LOCAL peak: the roll below thins it out with
    // distance, so the sward closes under the player's own feet without paying
    // for that density across the whole 24.5 m disc.
    const perCell = Math.max(4, Math.round(
      NEAR_PER_M2 * NEAR_DENSE_GAIN * CELL_N * CELL_N * 1.9 * quality.grassDensity
    ));

    this.scatter(CELL_N, NEAR_PLACE, perCell, 0, centreX, centreZ, (x, z, k) => {
      const g = this.mask.sample(this.mask.grass, x, z);
      if (g <= 0.02) return false;
      const vig = this.mask.sample(this.mask.vigor, x, z);
      const forest = this.mask.sample(this.mask.forest, x, z);
      const dry = this.mask.sample(this.mask.dry, x, z);
      // Clustered density: FBM-ish from two hashed lattices, not a flat roll,
      // pushed through a contrast curve so the field gets genuine thick and
      // thin patches and the occasional bare void rather than a uniform wash.
      const cn = smoothstep(0.25, 0.85, clumpNoise(x, z));
      // Distance grading: ~8/m2 under the camera falling to ~3.9 at the ring
      // edge. In the reference wheat field NO ground is visible at all, and at
      // a flat 3.9 clumps/m2 the terrain plate showed through 40-60% of every
      // ground pixel.
      const dNear = Math.hypot(x - centreX, z - centreZ);
      const grade = (1 / NEAR_DENSE_GAIN +
        (1 - 1 / NEAR_DENSE_GAIN) * (1 - smoothstep(NEAR_DENSE_START, NEAR_DENSE_END, dNear)))
        // ...and thinned again across the band where the tier is already
        // shrinking its instances toward zero, which is invisible and free.
        * (1 - 0.55 * smoothstep(NEAR_FULL, NEAR_PLACE, dNear));
      const dens = g * (0.46 + 0.54 * vig) * (0.42 + 0.72 * cn);
      if (hash2(k * 7 + 3, Math.floor(x * 4.1) * 733 + Math.floor(z * 4.1) * 269, 77) > dens * grade) return false;

      const kind = pickKind(x, z, k, dry, vig, forest);
      const tier = this.near[kind]!;
      if (tier.n >= tier.cap) return false;

      // Exact heightfield inside 12 m, where a 10 cm error would expose a root
      // ring; the grid height beyond that, where it is a fraction of a degree.
      const ex = x - centreX, ez = z - centreZ;
      const y = ex * ex + ez * ez < 196
        ? terrainSurfaceY(this.hf, x, z)
        : this.mask.heightAt(x, z);
      const size = COVER_SIZE[kind];
      const r0 = hash2(k, Math.floor(x * 3) ^ Math.floor(z * 5), 79);
      const r1 = hash2(k + 7, Math.floor(x) + Math.floor(z), 83);
      const r2 = hash2(k + 13, Math.floor(x) - Math.floor(z), 89);
      // Height comes off the instance hash AND a low-frequency field, so tall
      // and short PATCHES form instead of a per-instance salt-and-pepper. The
      // ceiling is deliberately far below cycle 2's: at 0.62 + r*1.15 a tussock
      // could reach 1.8 m, which is why the ground poses read as reeds shooting
      // past the top of frame like drinking straws.
      // Scale rides the SAME density field as the placement, so thin ground is
      // short as well as sparse and a thicket is tall as well as dense. A flat
      // per-instance jitter gives one spatial frequency and reads as ornaments.
      const hs = size.h * (0.62 + r0 * 0.62) * (0.74 + 0.34 * vig) * (0.66 + 0.62 * cn);
      const ws = size.w * (0.78 + r1 * 0.70) * (0.80 + 0.32 * cn);

      this.mask.normalAt(x, z, this.tmpN);
      this.qTilt.setFromUnitVectors(UP, this.tmpN.lerp(UP, 0.42).normalize());
      this.qYaw.setFromAxisAngle(UP, r2 * Math.PI * 2);
      this.dummy.position.set(x, y, z);
      this.dummy.quaternion.copy(this.qTilt).multiply(this.qYaw);
      this.dummy.scale.set(ws, hs, ws);
      this.dummy.updateMatrix();
      tier.mesh.setMatrixAt(tier.n, this.dummy.matrix);

      (tier.rand.array as Float32Array)[tier.n] = r2;
      (tier.dry.array as Float32Array)[tier.n] =
        clamp(COVER_DRY[kind] + dry * COVER_DRY_GAIN[kind], 0, 1);
      (tier.shade.array as Float32Array)[tier.n] = this.mask.shadeAt(x, z);
      // The scatter already computed a clustered density value and threw it
      // away after the cull. It is exactly what the shader needs to shut the
      // sky out of a thick clump, so it now rides along.
      (tier.dens.array as Float32Array)[tier.n] = clamp(cn * grade * 1.15, 0, 1);
      this.mask.tintAt(x, z, this.tmpT);
      const ta = tier.tint.array as Float32Array;
      ta[tier.n * 3] = this.tmpT.x;
      ta[tier.n * 3 + 1] = this.tmpT.y;
      ta[tier.n * 3 + 2] = this.tmpT.z;
      tier.n++;
      return true;
    });

    for (const kind of COVER_KINDS) {
      const t = this.near[kind]!;
      t.mesh.count = t.n;
      t.mesh.instanceMatrix.needsUpdate = true;
      t.rand.needsUpdate = true;
      t.dry.needsUpdate = true;
      t.shade.needsUpdate = true;
      t.dens.needsUpdate = true;
      t.tint.needsUpdate = true;
    }
    this.refreshCarpet(centreX, centreZ);
  }

  private refreshCards(): void {
    const ccx = Math.floor(this.camera.position.x / CELL_F);
    const ccz = Math.floor(this.camera.position.z / CELL_F);
    if (ccx === this.lastFarX && ccz === this.lastFarZ) return;
    this.lastFarX = ccx;
    this.lastFarZ = ccz;
    const centreX = (ccx + 0.5) * CELL_F;
    const centreZ = (ccz + 0.5) * CELL_F;

    const fill = (
      tier: CoverTier, cell: number, radius: number, perM2: number,
      tiles: number[], salt: number, wMul: number, hMul: number, maxH: number
    ): void => {
      tier.n = 0;
      const perCell = Math.max(6, Math.round(perM2 * cell * cell * 1.85 * quality.grassDensity));
      this.scatter(cell, radius, perCell, salt, centreX, centreZ, (x, z, k) => {
        const g = this.mask.sample(this.mask.grass, x, z);
        if (g <= 0.02) return false;
        const vig = this.mask.sample(this.mask.vigor, x, z);
        const dry = this.mask.sample(this.mask.dry, x, z);
        // Same contrast-curved density field as the near band, so thick and
        // thin patches carry THROUGH the tier hand-over instead of each band
        // having its own texture. Bare ground is legal here and wanted: paths,
        // worn tracks and grazed hollows are half of what makes the reference
        // field read as a field rather than as a scatter of ornaments.
        const cn = smoothstep(0.25, 0.85, clumpNoise(x, z));
        const dens = g * (0.50 + 0.50 * vig) * (0.34 + 0.86 * cn);
        if (hash2(k * 7 + 3, Math.floor(x * 4.1) * 733 + Math.floor(z * 4.1) * 269, 77 + salt) > dens) return false;
        if (tier.n >= tier.cap) return false;

        const y = this.mask.heightAt(x, z);
        const r0 = hash2(k * 11 + 1, Math.floor(x * 3.7) * 401 + Math.floor(z * 3.7) * 97, 79 + salt);
        const r1 = hash2(k * 13 + 5, Math.floor(x * 2.3) * 613 + Math.floor(z * 2.3) * 151, 83 + salt);
        const s = 0.55 + r0 * 0.80;
        // HARD height ceiling on the card tiers. Without it a far swath could
        // reach 3.5 m, and a 3.5 m grass billboard on a hillside is exactly the
        // "striped barrel / hay bale" the critics read as a broken shrub.
        const hh = Math.min(maxH, s * hMul * (0.66 + 0.62 * vig) * (0.62 + 0.68 * cn));
        // Sunk 12 cm: the tile's bottom rows are transparent margin, and the
        // terrain has to depth-test the root band away.
        this.dummy.position.set(x, y - 0.12, z);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(s * wMul * (0.82 + r1 * 0.46), hh, 1);
        this.dummy.updateMatrix();
        tier.mesh.setMatrixAt(tier.n, this.dummy.matrix);

        (tier.rand.array as Float32Array)[tier.n] = r1;
        (tier.dry.array as Float32Array)[tier.n] = dry;
        (tier.shade.array as Float32Array)[tier.n] = this.mask.shadeAt(x, z);
        (tier.dens.array as Float32Array)[tier.n] = clamp(cn * 1.15, 0, 1);
        // Tile choice follows dryness and vigor, so straw parcels get straw
        // silhouettes rather than the same tile recoloured.
        const roll = hash2(k * 17 + 11, Math.floor(x * 1.7) * 877 + Math.floor(z * 1.7) * 191, 97 + salt);
        (tier.tile!.array as Float32Array)[tier.n] = pickTile(tiles, roll, dry, vig);
        this.mask.tintAt(x, z, this.tmpT);
        const ta = tier.tint.array as Float32Array;
        ta[tier.n * 3] = this.tmpT.x;
        ta[tier.n * 3 + 1] = this.tmpT.y;
        ta[tier.n * 3 + 2] = this.tmpT.z;
        tier.n++;
        return true;
      });
      tier.mesh.count = tier.n;
      tier.mesh.instanceMatrix.needsUpdate = true;
      tier.rand.needsUpdate = true;
      tier.dry.needsUpdate = true;
      tier.shade.needsUpdate = true;
      tier.dens.needsUpdate = true;
      tier.tint.needsUpdate = true;
      tier.tile!.needsUpdate = true;
    };

    fill(this.mid, CELL_F, MID_PLACE, MID_PER_M2, CLUMP_TILES, 3, 1.05, 1.02, 1.15);
    // Swathes are WIDE and LOW. Tall ones stood up as a row of straw fences
    // along the mid-ground instead of reading as more field. They now start at
    // 30 m so this low-frequency mass sits UNDER the clump band rather than
    // beginning where it ends.
    fill(this.far, CELL_F, FAR_PLACE, FAR_PER_M2, SWATH_TILES, 17, 2.8, 1.24, 1.55);
  }

  private refreshCarpet(cx: number, cz: number): void {
    const pos = this.carpetPos.array as Float32Array;
    const nrm = this.carpetNrm.array as Float32Array;
    const cov = this.carpetCov.array as Float32Array;
    const dryA = this.carpetDry.array as Float32Array;
    const shd = this.carpetShade.array as Float32Array;
    const tnt = this.carpetTint.array as Float32Array;
    let p = 0;
    for (let r = 0; r <= CARPET_RINGS; r++) {
      const t = r / CARPET_RINGS;
      const rad = 0.8 + (CARPET_R - 0.8) * t * t;
      for (let s = 0; s < CARPET_SPOKES; s++) {
        const a = (s / CARPET_SPOKES) * Math.PI * 2;
        const x = cx + Math.cos(a) * rad;
        const z = cz + Math.sin(a) * rad;
        // The terrain TRIANGLE plane near the camera, grid height far out. The
        // lift grows with distance so the sheet can never sink under the mesh.
        // The exact band was widened 60 -> 100 m now that polygonOffset is gone
        // and the lift is the only thing holding the sheet above the mesh.
        const y = (rad < CARPET_EXACT_R ? terrainSurfaceY(this.hf, x, z) : this.mask.heightAt(x, z))
          + 0.030 + rad * 0.0026;
        pos[p * 3] = x; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z;
        this.mask.normalAt(x, z, this.tmpN);
        nrm[p * 3] = this.tmpN.x; nrm[p * 3 + 1] = this.tmpN.y; nrm[p * 3 + 2] = this.tmpN.z;
        const g = this.mask.sample(this.mask.grass, x, z);
        const vig = this.mask.sample(this.mask.vigor, x, z);
        cov[p] = clamp(g * (0.55 + 0.55 * vig), 0, 1);
        dryA[p] = this.mask.sample(this.mask.dry, x, z);
        shd[p] = this.mask.shadeAt(x, z);
        this.mask.tintAt(x, z, this.tmpT);
        tnt[p * 3] = this.tmpT.x; tnt[p * 3 + 1] = this.tmpT.y; tnt[p * 3 + 2] = this.tmpT.z;
        p++;
      }
    }
    this.carpetPos.needsUpdate = true;
    this.carpetNrm.needsUpdate = true;
    this.carpetCov.needsUpdate = true;
    this.carpetDry.needsUpdate = true;
    this.carpetShade.needsUpdate = true;
    this.carpetTint.needsUpdate = true;
  }

  // --- woody layer ---------------------------------------------------------

  private plantWoody(leafAtlas: THREE.Texture, physics: PhysicsWorld, seed: number): void {
    const bySpecies: Record<TreeSpecies, PlacedTree[]> = { oak: [], birch: [], pine: [] };
    const dead: PlacedTree[] = [];
    const BASE_H: Record<TreeSpecies, number> = { oak: 9.6, birch: 11.4, pine: 13.2 };
    const TIER = [0.68, 0.96, 1.30];

    // Ground direction and length of a cast shadow, from the SAME sun the
    // shading uses. sunDir points at the sun, so a shadow runs along -sunDir.xz
    // and is (height / tan(elevation)) long.
    const sd = this.light.sunDir;
    const horiz = Math.hypot(sd.x, sd.z) || 1e-3;
    const shX = -sd.x / horiz;
    const shZ = -sd.z / horiz;
    const shLen = clamp(horiz / Math.max(0.18, sd.y), 0.35, 3.2);

    let count = 0;
    const steps = Math.floor(MAP_SIZE / TREE_SPACING);
    for (let gz = 0; gz < steps && count < MAX_TREES; gz++) {
      for (let gx = 0; gx < steps && count < MAX_TREES; gx++) {
        const bx = -MAP_SIZE / 2 + gx * TREE_SPACING;
        const bz = -MAP_SIZE / 2 + gz * TREE_SPACING;
        const f = this.mask.sample(this.mask.forest, bx, bz);
        if (f < 0.06) continue;
        // Clustered stands: density rises steeply inside the mask so stand
        // interiors close their canopy and the edge thins into scrub.
        const want = Math.min(1, Math.pow(f, 0.72) * 0.92);
        if (hash2(gx, gz, seed + 31) > want) continue;
        const x = bx + (hash2(gx, gz, seed + 37) - 0.5) * TREE_SPACING * 0.9;
        const z = bz + (hash2(gx, gz, seed + 41) - 0.5) * TREE_SPACING * 0.9;
        if (this.mask.sample(this.mask.built, x, z) > 0.08) continue;
        const y = this.hf.height(x, z);
        if (y < 2.6) continue;

        const tierRoll = hash2(gx, gz, seed + 53);
        // Edge trees run small: a stand with a scrubby boundary reads as a real
        // treeline instead of a wall of identical trunks.
        const edge = 1 - Math.min(1, f * 1.6);
        const tier = tierRoll < 0.28 + edge * 0.4 ? 0 : tierRoll < 0.82 ? 1 : 2;
        const sp = hash2(gx, gz, seed + 43);
        const species: TreeSpecies = sp < 0.44 ? 'oak' : sp < 0.72 ? 'birch' : 'pine';
        const h = BASE_H[species] * TIER[tier] * (0.90 + hash2(gx, gz, seed + 47) * 0.20);
        const tree: PlacedTree = {
          x, z, y, h,
          yaw: hash2(gx, gz, seed + 59) * Math.PI * 2,
          leanX: (hash2(gx, gz, seed + 83) - 0.5) * 0.09,
          leanZ: (hash2(gx, gz, seed + 89) - 0.5) * 0.09,
          seed: gx * 977 + gz * 13 + seed,
        };
        // 3%, down from 5%: a snag is a bare pale pole, and at 5% the hilltops
        // in forest-edge read as a stand of dead trees planted in a green wood.
        if (hash2(gx, gz, seed + 97) < 0.03) dead.push(tree);
        else bySpecies[species].push(tree);

        // Ground-contact pool under the crown AND the crown's own cast shadow
        // raked away from the sun. The absence of both is the single clearest
        // "pasted on" tell in every wide shot: a full-sun tree that drops
        // nothing onto the grass under a clearly directional key.
        this.mask.addShadeStreak(
          x, z, shX, shZ, h * 0.62 * shLen, Math.max(1.8, h * 0.40), 0.72
        );

        const rad = Math.max(0.2, 0.040 * h);
        physics.addBox(
          new THREE.Vector3(x - rad, y, z - rad),
          new THREE.Vector3(x + rad, y + h * 0.6, z + rad),
          'tree'
        );
        count++;
      }
    }

    // --- bushes: forest edges and hedgerow lines ---
    interface PlacedBush { x: number; z: number; y: number; s: number; yaw: number; v: BushVariant; seed: number }
    const bushes: PlacedBush[] = [];
    const bsteps = Math.floor(MAP_SIZE / BUSH_SPACING);
    for (let gz = 0; gz < bsteps && bushes.length < MAX_BUSHES; gz++) {
      for (let gx = 0; gx < bsteps && bushes.length < MAX_BUSHES; gx++) {
        const bx = -MAP_SIZE / 2 + gx * BUSH_SPACING;
        const bz = -MAP_SIZE / 2 + gz * BUSH_SPACING;
        const g = this.mask.sample(this.mask.grass, bx, bz);
        if (g < 0.2) continue;
        if (this.mask.sample(this.mask.built, bx, bz) > 0.12) continue;
        const f = this.mask.sample(this.mask.forest, bx, bz);
        // The shrub layer is load-bearing: it is the entire mid-height stratum
        // between grass and canopy, and every frame in cycle 3 jumped from
        // ~0.8 m grass straight to 8-15 m trees with nothing in between. It is
        // also cover — a player prone in that field had nothing to break
        // silhouette against.
        //
        // Placement is no longer gated on an EDGE TEST, which left open ground
        // with exactly zero shrubs: it now reads the same clustered density
        // field the grass does, so thickets form in hollows and along slope
        // breaks as well as at the woodland fringe.
        const edge = f > 0.02 && f < 0.46 ? 1 : 0;
        const inner = f >= 0.46 ? 0.30 : 0;
        const v = voronoiCell(bx / 96 + 3.7, bz / 96 - 1.9, seed ^ 0x2f19);
        const hedge = f < 0.1 && v.f2 - v.f1 < 0.060 ? 1 : 0;
        const thicket = smoothstep(0.68, 0.98, clumpNoise(bx * 0.55, bz * 0.55)) * 0.34 * g;
        const want = edge * 0.80 + hedge * 0.86 + inner + thicket;
        if (want <= 0) continue;
        if (hash2(gx * 313 + 7, gz * 971 + seed, 61) > want) continue;
        const x = bx + (hash2(gx, gz, seed + 67) - 0.5) * BUSH_SPACING * 0.9;
        const z = bz + (hash2(gx, gz, seed + 71) - 0.5) * BUSH_SPACING * 0.9;
        const y = this.hf.height(x, z);
        if (y < 2.4) continue;
        const dry = this.mask.sample(this.mask.dry, x, z);
        const vr = hash2(gx, gz, seed + 101);
        // 'tall' fills the 1.8-2.5 m band that had nothing in it at all.
        const variant: BushVariant = vr < 0.18 + dry * 0.26
          ? 'bramble'
          : vr < 0.44 ? 'dense' : vr < 0.66 ? 'open' : vr < 0.84 ? 'sprawl' : 'tall';
        // 0.8-1.6 m for the low variants; the tall shrub carries its own range.
        const s = variant === 'tall'
          ? 1.80 + hash2(gx, gz, seed + 73) * 0.70
          : 0.80 + hash2(gx, gz, seed + 73) * 0.80;
        bushes.push({
          x, z, y, s,
          yaw: hash2(gx, gz, seed + 79) * Math.PI * 2,
          v: variant,
          seed: gx * 641 + gz * 29 + seed,
        });
        this.mask.addShadeStreak(
          x, z, shX, shZ, s * 0.55 * shLen, Math.max(0.9, s * 0.80), 0.40
        );
      }
    }

    // --- trunks (one instanced mesh per species) ---
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const scl = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const rootMatrix = (t: PlacedTree): THREE.Matrix4 => {
      e.set(t.leanX, t.yaw, t.leanZ, 'YXZ');
      q.setFromEuler(e);
      pos.set(t.x, t.y - 0.15, t.z);
      scl.setScalar(t.h);
      return m.compose(pos, q, scl);
    };

    // Bark colour, cycle 3. Cycle 2's trunks sampled at #401808 (S 88%) and
    // #602810 (S 83%) — fantasy redwood, not rural Eastern Europe, where a pine
    // sits around S 10-25% grey-brown and the reference trunk measures S 4%.
    // The tint multipliers below are near-neutral by design; the hue that is
    // left comes from the baked albedo, not from a colour push.
    // Cycle 4 pulled birch off paper-white. 0xe2dfd8 (226,223,216) multiplying a
    // bark albedo already based at 198,194,186 gave an effective ~0.87 x 0.78,
    // making the trunks the brightest object in the treeline frame INCLUDING
    // the sky, where the reference's birches read sRGB ~150-190 lit.
    const BARK_COLOR: Record<TreeSpecies, number> = { oak: 0xb4aca0, birch: 0xb9b2a6, pine: 0xb8ac9c };
    for (const species of ['oak', 'birch', 'pine'] as const) {
      const list = bySpecies[species];
      if (list.length === 0) continue;
      const bark = makeBarkMaps(species, seed + species.length * 401);
      bark.map.repeat.set(1, 2.4);
      bark.normalMap.repeat.set(1, 2.4);
      const trunkMat = new THREE.MeshStandardMaterial({
        map: bark.map,
        normalMap: bark.normalMap,
        normalScale: new THREE.Vector2(0.7, 0.7),
        color: BARK_COLOR[species],
        roughness: 0.92,
        metalness: 0,
      });
      groundTrunk(trunkMat);
      const trunks = new THREE.InstancedMesh(treeSkeleton(species, seed + 77).geo, trunkMat, list.length);
      trunks.castShadow = true;
      trunks.receiveShadow = true;
      list.forEach((t, i) => trunks.setMatrixAt(i, rootMatrix(t)));
      trunks.instanceMatrix.needsUpdate = true;
      trunks.computeBoundingSphere();
      this.group.add(trunks);
    }

    if (dead.length > 0) {
      const bark = makeBarkMaps('dead', seed + 417);
      bark.map.repeat.set(1, 2.2);
      bark.normalMap.repeat.set(1, 2.2);
      const deadMat = new THREE.MeshStandardMaterial({
        map: bark.map,
        normalMap: bark.normalMap,
        normalScale: new THREE.Vector2(0.65, 0.65),
        color: 0x8a8578,
        roughness: 0.96,
        metalness: 0,
      });
      groundTrunk(deadMat);
      const snags = new THREE.InstancedMesh(deadTreeGeometry(seed + 421), deadMat, dead.length);
      snags.castShadow = true;
      snags.receiveShadow = true;
      dead.forEach((t, i) => snags.setMatrixAt(i, rootMatrix(t)));
      snags.instanceMatrix.needsUpdate = true;
      snags.computeBoundingSphere();
      this.group.add(snags);
    }

    // --- ONE instanced draw for every leaf cluster in the world ---
    interface Crown {
      cards: FoliageCard[]; root: THREE.Matrix4; yaw: number; scale: number;
      cx: number; cy: number; cz: number; cr: number;
    }
    const crowns: Crown[] = [];
    let totalCards = 0;
    /** Crown centre + 3D hull radius, so the volume normal and the interior AO
     *  both measure against the real mass instead of a flat xz footprint. */
    const pushCrown = (
      cards: FoliageCard[], root: THREE.Matrix4, yaw: number, scale: number,
      wx: number, wy: number, wz: number, uy: number
    ): void => {
      if (cards.length === 0) return;
      let cr = 0;
      for (const c of cards) {
        const d = Math.sqrt(c.x * c.x + (c.y - uy) * (c.y - uy) + c.z * c.z);
        if (d > cr) cr = d;
      }
      crowns.push({
        cards, root, yaw, scale,
        cx: wx, cy: wy + uy * scale, cz: wz, cr: Math.max(cr * scale, 0.4),
      });
      totalCards += cards.length;
    };

    for (const species of ['oak', 'birch', 'pine'] as const) {
      const skel = treeSkeleton(species, seed + 77);
      for (const t of bySpecies[species]) {
        pushCrown(treeCrown(species, t.seed, skel), rootMatrix(t).clone(), t.yaw, t.h,
          t.x, t.y - 0.15, t.z, skel.cy);
      }
    }
    // A snag with nothing on it is a bare white pole in a green wood — five of
    // them on a hilltop is what made cycle-2's forest-edge read as blight.
    for (const t of dead) {
      pushCrown(snagCrown(t.seed), rootMatrix(t).clone(), t.yaw, t.h,
        t.x, t.y - 0.15, t.z, 0.62);
    }
    for (const b of bushes) {
      e.set(0, b.yaw, 0, 'YXZ');
      q.setFromEuler(e);
      pos.set(b.x, b.y - 0.10, b.z);
      scl.setScalar(b.s);
      pushCrown(bushCrown(b.v, b.seed), new THREE.Matrix4().compose(pos, q, scl), b.yaw, b.s,
        b.x, b.y - 0.10, b.z, 0.52);
    }

    // Woody stems under the shrubs. One shared prototype, one instanced draw:
    // cycle 2 wrote this generator and never called it, which is exactly how
    // the shrub layer ended up being the grass-tuft mesh scaled up.
    if (bushes.length > 0) {
      const stemMat = new THREE.MeshStandardMaterial({
        color: 0x6e675c, roughness: 0.95, metalness: 0,
      });
      groundTrunk(stemMat);
      const stems = new THREE.InstancedMesh(
        bushBranchGeometry(BUSH_VARIANTS[1], seed + 909), stemMat, bushes.length
      );
      stems.castShadow = false;
      stems.receiveShadow = true;
      bushes.forEach((b, i) => {
        e.set(0, b.yaw, 0, 'YXZ');
        q.setFromEuler(e);
        pos.set(b.x, b.y - 0.10, b.z);
        scl.setScalar(b.s);
        stems.setMatrixAt(i, new THREE.Matrix4().compose(pos, q, scl));
      });
      stems.instanceMatrix.needsUpdate = true;
      stems.computeBoundingSphere();
      this.group.add(stems);
    }
    if (totalCards === 0) return;

    const cardGeo = new THREE.PlaneGeometry(1, 1);
    const foliageOpts = {
      ...this.light,
      atlas: leafAtlas,
      tiles: LEAF_TILES,
      windAmp: 0.55,
      aerial: new THREE.Vector2(140, 620),
    };
    const cardMat = foliageCardMaterial(foliageOpts);
    this.materials.push(cardMat);
    const cards = new THREE.InstancedMesh(cardGeo, cardMat, totalCards);
    cards.castShadow = true;
    cards.receiveShadow = true;
    cards.customDepthMaterial = foliageDepthMaterial(foliageOpts, cardMat.uniforms.uTime);
    const aRand = new Float32Array(totalCards);
    const aTile = new Float32Array(totalCards);
    const aCore = new Float32Array(totalCards * 4);
    const cardPos = new THREE.Vector3();
    let ci = 0;
    for (const cr of crowns) {
      for (const c of cr.cards) {
        cardPos.set(c.x, c.y, c.z).applyMatrix4(cr.root);
        this.dummy.position.copy(cardPos);
        this.dummy.rotation.set(c.tilt, cr.yaw + c.yaw, 0, 'YXZ');
        this.dummy.scale.set(c.w * cr.scale, c.h * cr.scale, 1);
        this.dummy.updateMatrix();
        cards.setMatrixAt(ci, this.dummy.matrix);
        aRand[ci] = c.rand;
        aTile[ci] = c.tile;
        aCore[ci * 4] = cr.cx;
        aCore[ci * 4 + 1] = cr.cy;
        aCore[ci * 4 + 2] = cr.cz;
        aCore[ci * 4 + 3] = cr.cr;
        ci++;
      }
    }
    cardGeo.setAttribute('aRand', new THREE.InstancedBufferAttribute(aRand, 1));
    cardGeo.setAttribute('aTile', new THREE.InstancedBufferAttribute(aTile, 1));
    cardGeo.setAttribute('aCore', new THREE.InstancedBufferAttribute(aCore, 4));
    cards.instanceMatrix.needsUpdate = true;
    cards.computeBoundingSphere();
    this.group.add(cards);
  }

  update(dt: number): void {
    for (const m of this.materials) {
      const u = m.uniforms.uTime;
      if (u) u.value += dt;
    }
    this.refreshNear();
    this.refreshCards();
  }
}

// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);

/**
 * ONE palette pair for the whole sward, near band and card tiers alike.
 *
 * Re-measured a third time in cycle 4 against terrain-vista-erangel-fields:
 * Erangel runs a continuous muted khaki ramp, and the build was bimodal —
 * rust-orange tufts on chartreuse green with nothing occupying the olive/wheat
 * middle. The straw stop is rotated off orange (linear hue ~33 -> ~37 deg) and
 * desaturated ~15%, and the lush stop is pulled toward olive rather than the
 * yellow-green it sat at.
 */
const SWARD_LUSH = new THREE.Color(0.132, 0.146, 0.094);
const SWARD_STRAW = new THREE.Color(0.204, 0.162, 0.100);

/**
 * Per-trunk grounding gradient. SHADE_RES cannot resolve the 40 cm ring where a
 * trunk meets the sward no matter how fine it gets — the trunk is thinner than
 * a texel — so contact is done in the trunk's OWN local space instead, where it
 * is exact and free. Unit space: 1.0 is the tree height, so 0.085 is ~85 cm on
 * a 10 m tree.
 */
function groundTrunk(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vTrunkY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTrunkY = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTrunkY;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n  diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(-0.04, 0.085, vTrunkY));'
      );
  };
  mat.customProgramCacheKey = () => 'vegTrunkGround1';
}

function attach(geo: THREE.BufferGeometry, name: string, count: number, size: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
  a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute(name, a);
  return a;
}

/** Two hashed lattices at different scales — clusters and voids, not a wash. */
function clumpNoise(x: number, z: number): number {
  const n = (px: number, pz: number, s: number): number => {
    const fx = px * s, fz = pz * s;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    let tx = fx - ix, tz = fz - iz;
    tx = tx * tx * (3 - 2 * tx);
    tz = tz * tz * (3 - 2 * tz);
    const a = hash2(ix, iz, 401), b = hash2(ix + 1, iz, 401);
    const c = hash2(ix, iz + 1, 401), d = hash2(ix + 1, iz + 1, 401);
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
  return n(x, z, 0.09) * 0.62 + n(x + 91.3, z - 17.7, 0.026) * 0.55;
}

/**
 * Flower fields. A meadow with no flowering layer has no second read at any
 * distance, and the reference woodland gets a large part of its impact from
 * exactly this. Rather than sprinkling umbels everywhere (which reads as
 * confetti), the herb archetype is concentrated into a handful of 40 m patches
 * per square kilometre, where its share goes to ~1 and the rest of the field
 * keeps none at all.
 */
function flowerPatch(x: number, z: number): number {
  const v = voronoiCell(x / 190 + 11.3, z / 190 - 5.1, 0x5eed);
  // Only a fifth of cells bloom, and only their cores: ~5 patches of ~45 m
  // radius per square kilometre.
  if (hash2(v.id & 0xffff, (v.id >>> 16) & 0xffff, 313) > 0.20) return 0;
  return clamp(1 - v.f1 / 0.24, 0, 1);
}

/** Weighted archetype table driven by the terrain material mask. */
function pickKind(x: number, z: number, k: number, dry: number, vig: number, forest: number): CoverKind {
  const bloom = flowerPatch(x, z) * (1 - dry * 0.5) * (1 - forest);
  const w: number[] = [
    (0.38 * (1 - dry) + 0.12) * (1 - bloom * 0.7),   // tussock
    (0.05 + 0.52 * dry) * (1 - bloom * 0.7),         // dry
    (0.15 + 0.26 * (1 - vig)) * (1 - bloom * 0.7),   // mat
    0.11 * (1 - dry) * (1 - forest),                 // dock
    0.02 + 0.44 * forest,                            // fern
    0.03 + 0.05 * (1 - dry) + bloom * 1.9,           // herb — rare, except in bloom patches
  ];
  let total = 0;
  for (const v of w) total += v;
  let r = hash2(k + 3, Math.floor(x * 2) ^ Math.floor(z * 2), 131) * total;
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r <= 0) return COVER_KINDS[i];
  }
  return COVER_KINDS[0];
}

/** Bias tile choice by dryness/vigor so straw parcels get straw silhouettes. */
function pickTile(tiles: number[], roll: number, dry: number, vig: number): number {
  // CLUMP_TILES order: 0 tall green, 1 tall dry, 2 short mat, 3 dock, 4 fern, 7 herb
  // SWATH_TILES order: 0 green, 1 straw, 2 mixed-tall, 3 mixed-low
  const w = tiles.length === 4
    ? [0.34 * (1 - dry) + 0.10, 0.08 + 0.46 * dry, 0.22 + 0.14 * vig, 0.20 + 0.10 * (1 - vig)]
    : [
      0.40 * (1 - dry) + 0.10,
      0.05 + 0.56 * dry,
      0.18 + 0.30 * (1 - vig),
      0.10 * (1 - dry),
      0.06,
      0.04,
    ];
  const n = Math.min(w.length, tiles.length);
  let total = 0;
  for (let i = 0; i < n; i++) total += w[i];
  let r = roll * total;
  for (let i = 0; i < n; i++) {
    r -= w[i];
    if (r <= 0) return tiles[i];
  }
  return tiles[0];
}

/**
 * Sun / sky terms matched to sky.ts so vegetation lands in the same exposure as
 * the terrain: three's MeshStandardMaterial outputs albedo * irradiance / PI,
 * so the sun uniform is lightColor * intensity / PI.
 */
function buildLight(): VegLightParams {
  const tod = parseBootParams().timeOfDay;
  const elev = sunElevationFor(tod);
  const highT = clamp((elev - 12) / 45, 0, 1);
  const sunLin = new THREE.Color(1.0, 0.78 + 0.17 * highT, 0.55 + 0.35 * highT);
  return {
    sunDir: sunDirectionFor(tod).clone().normalize(),
    sunCol: sunLin.multiplyScalar(6.0 / Math.PI),
    // Cycle 2's fill was 0.118/0.138/0.180 against a sun of ~1.9 — a token 6%
    // of key, which measured as canopy p5 = 0.0 and 15% of canopy pixels below
    // luminance 12. This is ~2.3x that, landing the shadow side at 14-22% of
    // key, and the sky stop carries blue at 1.6x its red because SKYLIGHT is
    // what fills the shadow side of a real field: the reference runs blue at
    // two thirds of red where the build ran it at one third.
    skyCol: new THREE.Color(0.262, 0.310, 0.428),
    gndCol: new THREE.Color(0.168, 0.140, 0.100),
    // Warm ochre back-scatter, not the acid green of cycle 2 — the field this
    // has to sell is dry straw with the sun behind it.
    transCol: new THREE.Color(0.80, 0.66, 0.34),
    // Kajiya-Kay sheen along the blade axis. Without any specular lobe the
    // sward physically could not pass p99 = 158 where the reference hits 206.
    spec: new THREE.Vector2(0.13, 40.0),
    // A cast shadow multiplies the SUN only, and keeps 30% of it. At 0.12 the
    // now-visible ground carpet turned every prop shadow into a hard near-black
    // slash with jagged edges: the sun's single whole-frustum 2048 map is
    // ~0.3-0.5 m/texel out here, so its silhouettes are blocky, and a shadow
    // that resolves to a tenth of lit reads as a hole punched in the field
    // rather than as shade. A real cast shadow on grass sits near a third.
    // 0.22 of the sun plus a full ambient lands a cast shadow at ~0.35 of the
    // lit value, which is the band the reference sits in and where the terrain
    // lane independently targets its own shadows.
    shadowFloor: 0.22,
  };
}
