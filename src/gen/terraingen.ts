import { NoiseField, WORLD_SEED, clamp, lerp, smoothstep, hash2, voronoiCell } from './noise';

// The island slice: 1200x1200m, sea along the south/east edges, rolling
// farmland core, a rocky hill mass in the north-west, roads linking the
// village plateau to the coast. All queries are deterministic in WORLD_SEED.
//
// Erangel's visual identity is FARM PARCELS: irregular crop/meadow cells with
// their own hue, their own furrow direction and a scrubby margin between them.
// `parcel()` lays those out with a domain-warped voronoi; `surface()` bakes
// both the splat weights and the parcel data in one pass so the map build only
// pays for the expensive height/slope queries once per texel.

export const MAP_SIZE = 1200;
export const HALF = MAP_SIZE / 2;
export const SEA_LEVEL = 0;

export interface SplatWeights {
  grass: number;
  dirt: number;
  rock: number;
  /**
   * Road TENT profile, not a coverage mask: 1.0 on the centreline falling
   * linearly to 0 at ROAD_FALLOFF. The shader thresholds it (with noise) to get
   * a ragged edge, and reads the ramp itself to place wheel tracks.
   */
  road: number;
}

export interface FieldInfo {
  /** Parcel palette coordinate 0..1 — picks the crop family in the shader. */
  tone: number;
  /** Furrow/plough direction as a unit vector in world XZ. */
  dirX: number;
  dirZ: number;
  /** How strongly this point reads as cultivated land (flat, low, off-road). */
  farm: number;
}

export interface Surface {
  splat: SplatWeights;
  field: FieldInfo;
}

interface RoadSegment {
  ax: number; az: number; bx: number; bz: number;
}

/** Metres from centreline to the edge of the metalled surface. */
const ROAD_HALF = 3.4;
/** Where the road tent profile reaches zero (verge included). */
const ROAD_FALLOFF = 9.0;
/** Radius over which terrain height is smoothed toward the road. */
const ROAD_SHOULDER = 10;

/** Parcel cell size in metres, and the warp that stops it looking like a grid. */
const PARCEL_CELL = 88;
const PARCEL_WARP = 76;

/** Polyline control points for the road network (x, z pairs). */
const ROAD_PATHS: number[][][] = [
  // Coastal road, west to east with a bend through the village flat.
  [[-560, 180], [-380, 150], [-180, 120], [0, 90], [180, 110], [380, 170], [560, 230]],
  // North spur climbing toward the hills.
  [[0, 90], [-60, -80], [-140, -260], [-260, -420]],
  // East farm track.
  [[180, 110], [340, -40], [480, -160]],
];

export class Heightfield {
  private base: NoiseField;
  private hills: NoiseField;
  private detail: NoiseField;
  private splatNoise: NoiseField;
  private parcelNoise: NoiseField;
  private segments: RoadSegment[] = [];
  private seed: number;

  constructor(seed = WORLD_SEED) {
    this.seed = seed | 0;
    this.base = new NoiseField(seed);
    this.hills = new NoiseField(seed + 101);
    this.detail = new NoiseField(seed + 202);
    this.splatNoise = new NoiseField(seed + 303);
    this.parcelNoise = new NoiseField(seed + 404);
    for (const path of ROAD_PATHS) {
      for (let i = 0; i < path.length - 1; i++) {
        this.segments.push({ ax: path[i][0], az: path[i][1], bx: path[i + 1][0], bz: path[i + 1][1] });
      }
    }
  }

  /** Distance to the nearest road centreline. */
  roadDistance(x: number, z: number): number {
    let best = 1e9;
    for (const s of this.segments) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const len2 = dx * dx + dz * dz;
      let t = ((x - s.ax) * dx + (z - s.az) * dz) / len2;
      t = clamp(t, 0, 1);
      const px = s.ax + t * dx, pz = s.az + t * dz;
      const d = Math.hypot(x - px, z - pz);
      if (d < best) best = d;
    }
    return best;
  }

  /** Raw terrain height before road flattening. */
  private rawHeight(x: number, z: number): number {
    const nx = x / MAP_SIZE, nz = z / MAP_SIZE;

    // Rolling farmland: gentle low-frequency swells plus a mid swell so the
    // plains have readable shoulders instead of one uniform dome.
    const rolling = this.base.fbm(nx * 3.0, nz * 3.0, { octaves: 4, gain: 0.5 }) * 8.5 + 8;
    const swell = this.base.fbm(nx * 7.5 + 3.3, nz * 7.5 - 1.7, { octaves: 3 }) * 2.8;

    // Hill mass in the NW quadrant: ridged, masked by a warped blob. The mask
    // gates the expensive octaves so the other 3/4 of the map skips them.
    const hillMaskRaw = this.hills.warped(nx * 1.4 + 0.55, nz * 1.4 + 0.55, 0.7, { octaves: 3 });
    const hillCentreDist = Math.hypot(x + 320, z + 380) / 430;
    const hillMask = smoothstep(0.78, 0.18, hillCentreDist) * smoothstep(-0.25, 0.35, hillMaskRaw);

    let hills = 0;
    if (hillMask > 0.002) {
      const ridge = clamp(this.hills.ridged(nx * 3.4, nz * 3.4, { octaves: 5 }), 0, 1);
      // Gamma on the ridge sharpens crests and flattens the saddles between
      // them — the silhouette reads as ridgelines rather than lumps.
      hills = Math.pow(ridge, 1.4) * 106 * hillMask;
      // Secondary crest relief that only bites near the tops.
      const crestMask = hillMask * smoothstep(0.42, 0.86, ridge);
      if (crestMask > 0.01) {
        hills += this.hills.ridged(nx * 8.6 + 4.1, nz * 8.6 - 2.7, { octaves: 3 }) * 14 * crestMask;
      }
    }

    // Fine relief so plains never read flat.
    const detail = this.detail.fbm(nx * 22, nz * 22, { octaves: 3 }) * 1.5;

    // Coast falloff: island edge drops below sea toward south and east rims.
    const edge = Math.max(Math.abs(x), Math.abs(z)) / HALF;
    const coast = smoothstep(0.78, 1.0, edge) * 26;
    const shoreBias = smoothstep(0.55, 1.0, Math.max(z / HALF, x / HALF) * 0.5 + Math.max(Math.abs(x), Math.abs(z)) / HALF * 0.5) * 10;

    return rolling + swell + hills + detail - coast - shoreBias;
  }

  /** Final height including road flattening. */
  height(x: number, z: number): number {
    const h = this.rawHeight(x, z);
    const rd = this.roadDistance(x, z);
    if (rd > ROAD_SHOULDER) return h;
    // Roads sit on slightly smoothed terrain: sample coarse height around the
    // road point and pull toward it.
    const coarse =
      (this.rawHeight(x + 14, z) + this.rawHeight(x - 14, z) + this.rawHeight(x, z + 14) + this.rawHeight(x, z - 14)) * 0.25;
    const t = smoothstep(ROAD_SHOULDER, ROAD_HALF * 0.7, rd);
    return lerp(h, coarse + 0.15, t * 0.88);
  }

  /** Analytic-ish normal from central differences. */
  normal(x: number, z: number, eps = 1.5): [number, number, number] {
    const hL = this.height(x - eps, z);
    const hR = this.height(x + eps, z);
    const hD = this.height(x, z - eps);
    const hU = this.height(x, z + eps);
    const nx = (hL - hR) / (2 * eps);
    const nz = (hD - hU) / (2 * eps);
    const len = Math.hypot(nx, 1, nz);
    return [nx / len, 1 / len, nz / len];
  }

  slope(x: number, z: number): number {
    return 1 - this.normal(x, z)[1];
  }

  /**
   * Farm parcel lookup: which cultivated cell this point falls in, how close it
   * is to the margin between cells, and that cell's crop tone / plough angle.
   */
  private parcel(x: number, z: number): { tone: number; dirX: number; dirZ: number; margin: number } {
    const wx = this.parcelNoise.fbm(x / 520, z / 520, { octaves: 2 }) * PARCEL_WARP;
    const wz = this.parcelNoise.fbm(x / 520 + 21.7, z / 520 - 9.3, { octaves: 2 }) * PARCEL_WARP;
    const v = voronoiCell((x + wx) / PARCEL_CELL, (z + wz) / PARCEL_CELL, this.seed ^ 0x5f3a);
    const tone = hash2(v.id, 17, this.seed + 7);
    const ang = hash2(v.id, 43, this.seed + 23) * Math.PI;
    // f2 - f1 is 0 exactly on the cell boundary; ~0.06 cells is a 5m margin.
    const margin = smoothstep(0.075, 0.012, v.f2 - v.f1);
    return { tone, dirX: Math.cos(ang), dirZ: Math.sin(ang), margin };
  }

  /**
   * Splat weights + parcel data for one point, sharing the height/slope work.
   * grass/dirt/rock are normalised among themselves; road rides on top as a
   * separate profile (see SplatWeights.road).
   */
  surface(x: number, z: number): Surface {
    const rd = this.roadDistance(x, z);
    const roadT = clamp(1 - rd / ROAD_FALLOFF, 0, 1);
    const n = this.normal(x, z, 2.0);
    const slope = 1 - n[1];
    const h = this.height(x, z);
    const par = this.parcel(x, z);

    const rockNoise = this.splatNoise.fbm(x / 70, z / 70, { octaves: 3 });

    // Rock: steep faces and high ground only, with noisy edges so the boundary
    // never reads as a contour line.
    let rock = smoothstep(0.215, 0.40, slope + rockNoise * 0.055);
    rock = Math.max(rock, smoothstep(48, 76, h + rockNoise * 12));
    rock = clamp(rock, 0, 1);

    // Cultivated-land mask: flat, low, not rock, not road.
    const farmBase =
      smoothstep(0.16, 0.045, slope) *
      smoothstep(56, 26, h) *
      smoothstep(2.2, 6.5, h) *
      (1 - rock) *
      (1 - smoothstep(ROAD_FALLOFF + 3, ROAD_HALF, rd));

    // Ploughed parcels turn to bare earth; the top slice of the tone range is
    // the "worked field" family and matches parcelTint() in the terrain shader.
    const ploughed = smoothstep(0.80, 0.90, par.tone) * farmBase;

    // Dirt: scree under the rock line, field margins, ploughed cells, verges,
    // beach.
    let dirt = smoothstep(0.125, 0.27, slope + rockNoise * 0.05) * 0.85;
    dirt = Math.max(dirt, ploughed * 0.82);
    dirt = Math.max(dirt, par.margin * farmBase * 0.55);
    dirt = Math.max(dirt, smoothstep(ROAD_FALLOFF, ROAD_HALF, rd) * 0.6);
    dirt = Math.max(dirt, smoothstep(4.2, 1.0, h)); // beach
    dirt = clamp(dirt, 0, 1);

    const rockW = rock;
    const dirtW = clamp(dirt, 0, 1) * (1 - rockW);
    const grassW = Math.max(0, 1 - rockW - dirtW);

    return {
      splat: { grass: grassW, dirt: dirtW, rock: rockW, road: roadT },
      field: {
        tone: par.tone,
        dirX: par.dirX,
        dirZ: par.dirZ,
        // Margins keep their tint (the crop stops at the hedge, it does not
        // fade), but ploughed cells drop the tint since they are bare dirt.
        farm: clamp(farmBase * (1 - ploughed * 0.55), 0, 1),
      },
    };
  }

  /** Back-compat splat query (see surface() for the cheaper combined path). */
  splat(x: number, z: number): SplatWeights {
    return this.surface(x, z).splat;
  }

  /** Is this point reasonable to walk/spawn on. */
  walkable(x: number, z: number): boolean {
    return (
      Math.abs(x) < HALF - 30 &&
      Math.abs(z) < HALF - 30 &&
      this.height(x, z) > SEA_LEVEL + 1 &&
      this.slope(x, z) < 0.35
    );
  }
}
