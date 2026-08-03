import { NoiseField, WORLD_SEED, clamp, lerp, smoothstep } from './noise';

// The island slice: 1200x1200m, sea along the south/east edges, rolling
// farmland core, a rocky hill mass in the north-west, roads linking the
// village plateau to the coast. All queries are deterministic in WORLD_SEED.

export const MAP_SIZE = 1200;
export const HALF = MAP_SIZE / 2;
export const SEA_LEVEL = 0;

export interface SplatWeights {
  grass: number;
  dirt: number;
  rock: number;
  road: number;
}

interface RoadSegment {
  ax: number; az: number; bx: number; bz: number;
}

const ROAD_WIDTH = 4.5;
const ROAD_SHOULDER = 9;

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
  private segments: RoadSegment[] = [];

  constructor(seed = WORLD_SEED) {
    this.base = new NoiseField(seed);
    this.hills = new NoiseField(seed + 101);
    this.detail = new NoiseField(seed + 202);
    this.splatNoise = new NoiseField(seed + 303);
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

    // Rolling farmland: gentle low-frequency swells.
    const rolling = this.base.fbm(nx * 3.2, nz * 3.2, { octaves: 4, gain: 0.5 }) * 7 + 8;

    // Hill mass in the NW quadrant: ridged, masked by a warped blob.
    const hillMaskRaw = this.hills.warped(nx * 1.4 + 0.55, nz * 1.4 + 0.55, 0.7, { octaves: 3 });
    const hillCentreDist = Math.hypot(x + 320, z + 380) / 420;
    const hillMask = smoothstep(0.75, 0.2, hillCentreDist) * smoothstep(-0.25, 0.35, hillMaskRaw);
    const hills = this.hills.ridged(nx * 3.6, nz * 3.6, { octaves: 5 }) * 85 * hillMask;

    // Fine relief so plains never read flat.
    const detail = this.detail.fbm(nx * 22, nz * 22, { octaves: 3 }) * 1.6;

    // Coast falloff: island edge drops below sea toward south and east rims.
    const edge = Math.max(Math.abs(x), Math.abs(z)) / HALF;
    const coast = smoothstep(0.78, 1.0, edge) * 26;
    const shoreBias = smoothstep(0.55, 1.0, Math.max(z / HALF, x / HALF) * 0.5 + Math.max(Math.abs(x), Math.abs(z)) / HALF * 0.5) * 10;

    return rolling + hills + detail - coast - shoreBias;
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
    const t = smoothstep(ROAD_SHOULDER, ROAD_WIDTH * 0.55, rd);
    return lerp(h, coarse + 0.15, t * 0.85);
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

  splat(x: number, z: number): SplatWeights {
    const rd = this.roadDistance(x, z);
    const road = smoothstep(ROAD_WIDTH, ROAD_WIDTH * 0.6, rd);
    const slope = this.slope(x, z);
    const h = this.height(x, z);

    // Rock on steep slopes and high altitude, with noisy edges.
    const rockNoise = this.splatNoise.fbm(x / 90, z / 90, { octaves: 3 });
    let rock = smoothstep(0.16, 0.3, slope + rockNoise * 0.06) + smoothstep(38, 62, h + rockNoise * 10);
    rock = clamp(rock, 0, 1);

    // Dirt: patches in the fields, verges along roads, beach near sea level.
    const patch = this.splatNoise.warped(x / 150 + 9.1, z / 150 - 4.2, 0.9, { octaves: 4 });
    let dirt = smoothstep(0.32, 0.55, patch) * 0.8;
    dirt = Math.max(dirt, smoothstep(ROAD_SHOULDER + 4, ROAD_WIDTH, rd) * 0.7);
    dirt = Math.max(dirt, smoothstep(3.5, 1.2, h)); // beach
    dirt = clamp(dirt * (1 - rock), 0, 1);

    const roadW = road;
    const rockW = rock * (1 - roadW);
    const dirtW = dirt * (1 - roadW) * (1 - rockW);
    const grassW = Math.max(0, 1 - roadW - rockW - dirtW);
    return { grass: grassW, dirt: dirtW, rock: rockW, road: roadW };
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
