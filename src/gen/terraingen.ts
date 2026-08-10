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

/**
 * The lattice the terrain mesh is actually built on: MAP_SIZE / CHUNKS /
 * CHUNK_QUADS = 1200 / 4 / 128. Kept here, next to the heightfield, because it
 * is a property of the RENDERED surface that several systems must agree on.
 */
export const TERRAIN_STEP = MAP_SIZE / 4 / 128;

/**
 * Height of the terrain surface AS DRAWN, not as evaluated.
 *
 * The mesh samples hf.height on the fixed lattice above and splits every cell
 * along its b-c anti-diagonal, so between samples the visible surface is a FLAT
 * TRIANGLE. Across a hollow that triangle sits above the analytic curve by
 * several centimetres — more than any polygon offset can hide. Anything that has
 * to lie ON the ground (contact decals, ground carpets, footprint shadows) must
 * reconstruct this plane; planting it at hf.height + epsilon buries it and only
 * fragments poke through, which reads as hard-edged dark shards scattered over
 * the field.
 */
export function terrainSurfaceY(hf: Heightfield, x: number, z: number): number {
  const gx = (x + HALF) / TERRAIN_STEP;
  const gz = (z + HALF) / TERRAIN_STEP;
  const i = Math.floor(gx);
  const j = Math.floor(gz);
  const u = gx - i;
  const v = gz - j;
  const x0 = -HALF + i * TERRAIN_STEP;
  const z0 = -HALF + j * TERRAIN_STEP;
  const a = hf.height(x0, z0);
  const b = hf.height(x0 + TERRAIN_STEP, z0);
  const c = hf.height(x0, z0 + TERRAIN_STEP);
  if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
  const d = hf.height(x0 + TERRAIN_STEP, z0 + TERRAIN_STEP);
  return d + (b - d) * (1 - v) + (c - d) * (1 - u);
}

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
  /**
   * Furrow/plough direction packed as an angle in 0..1 (atan2 / TAU + 0.5).
   * Two channels used to carry dirX/dirZ; the freed channel now carries `edge`,
   * without which the parcels have no boundaries and the plains read as noise.
   */
  angle: number;
  /** Distance to the parcel boundary, 0 on the margin -> 1 at ~6m inside. */
  edge: number;
  /** How strongly this point reads as cultivated land (flat, low, off-road). */
  farm: number;
}

export interface Surface {
  splat: SplatWeights;
  field: FieldInfo;
  /** Terrain height at this point — the map bake needs it for the sea-depth channel. */
  height: number;
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
      // A light gamma on the ridge firms up the crests without turning them
      // into alpine spires — Erangel's hills are rounded, with rock breaking
      // out of the steep faces rather than a bare summit.
      hills = Math.pow(ridge, 1.12) * 90 * hillMask;
      // Secondary crest relief that only bites right at the tops.
      const crestMask = hillMask * smoothstep(0.55, 0.95, ridge);
      if (crestMask > 0.01) {
        hills += this.hills.ridged(nx * 8.6 + 4.1, nz * 8.6 - 2.7, { octaves: 3 }) * 7 * crestMask;
        // SADDLES AND NOTCHES. Without this the ridgeline is a straight-edged
        // pyramid with a single sharp apex — the capture reads as three clean
        // cones and there is nothing in the silhouette to give the massif a
        // scale. A second ridged field subtracted along the crest at ~230m
        // wavelength cuts cols between summits and breaks every straight edge,
        // which is the cheap stand-in for a drainage-network solve.
        const notch = clamp(this.hills.ridged(nx * 5.2 - 15.9, nz * 5.2 + 8.4, { octaves: 2 }), 0, 1);
        hills -= Math.pow(notch, 1.6) * 15 * crestMask;
      }
      // Drainage. A raw fBm dome has no gullies, which is what makes a
      // procedural mountain read as a clay blob: subtracting a ridged field
      // incises narrow channels along its crest lines, so the face gets
      // spurs and re-entrants instead of one smooth shoulder. Strongest on the
      // flanks, tapering out at the summit where there is no catchment yet.
      const flank = hillMask * (1 - smoothstep(0.62, 0.96, ridge));
      if (flank > 0.01) {
        const gully = clamp(this.hills.ridged(nx * 9.5 - 7.3, nz * 9.5 + 3.9, { octaves: 3 }), 0, 1);
        hills -= Math.pow(gully, 2.4) * 9.5 * flank;
        const fine = clamp(this.hills.ridged(nx * 21.0 + 12.7, nz * 21.0 - 5.1, { octaves: 2 }), 0, 1);
        hills -= Math.pow(fine, 3.0) * 2.6 * flank;
      }
    }

    // Fine relief so plains never read flat.
    const detail = this.detail.fbm(nx * 22, nz * 22, { octaves: 3 }) * 1.5;

    // Coast falloff: island edge drops below sea toward south and east rims.
    // The old `max(|x|,|z|)` is a square with a hard crease at the diagonal and
    // a ruled shoreline; a p-norm rounds it off, and a low-frequency wobble
    // stops the waterline being a drawn straight line. Both ramps read the SAME
    // edge value so they cannot leave a terrace step between them.
    const ex = Math.abs(x) / HALF;
    const ez = Math.abs(z) / HALF;
    const edge = Math.pow(Math.pow(ex, 8) + Math.pow(ez, 8), 0.125);
    const wob = this.base.fbm(nx * 6.5 + 9.1, nz * 6.5 - 4.4, { octaves: 3 }) * 0.055;
    const edgeW = edge + wob;
    const coast = smoothstep(0.78, 1.0, edgeW) * 26;
    const shoreBias = smoothstep(0.55, 1.0, Math.max(z / HALF, x / HALF) * 0.5 + edgeW * 0.5) * 10;

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
    // Carve the metalled strip INTO the ground. A road that sits on top of the
    // heightfield reads as a decal painted over the field; 15cm of cut plus the
    // shoulder blend is enough for the verge to catch its own shadow.
    return lerp(h, coarse - 0.15, t * 0.88);
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
  private parcel(
    x: number,
    z: number
  ): { tone: number; angle: number; margin: number; edge: number } {
    const wx = this.parcelNoise.fbm(x / 520, z / 520, { octaves: 2 }) * PARCEL_WARP;
    const wz = this.parcelNoise.fbm(x / 520 + 21.7, z / 520 - 9.3, { octaves: 2 }) * PARCEL_WARP;
    const v = voronoiCell((x + wx) / PARCEL_CELL, (z + wz) / PARCEL_CELL, this.seed ^ 0x5f3a);
    const tone = hash2(v.id, 17, this.seed + 7);
    const ang = hash2(v.id, 43, this.seed + 23) * Math.PI;
    // f2 - f1 is 0 exactly on the cell boundary; ~0.06 cells is a 5m margin.
    const margin = smoothstep(0.075, 0.012, v.f2 - v.f1);
    // Same quantity in metres, normalised over ~7m, kept for the shader so it
    // can draw an actual unploughed strip between neighbouring crops.
    const edge = clamp(((v.f2 - v.f1) * PARCEL_CELL) / 7.0, 0, 1);
    return { tone, angle: ang / Math.PI, margin, edge };
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
    // Slow band that shifts the rock threshold, so exposure comes in OUTCROPS
    // along the faces instead of coating every steep surface evenly.
    const outcrop = this.splatNoise.fbm(x / 145 + 51.3, z / 145 - 22.7, { octaves: 2 });

    // Rock: STEEP FACES, with noisy edges so the boundary never reads as a
    // contour line. An altitude term used to live here and it painted every
    // summit — which looked like snow, not Erangel. The old 0.30..0.52 band on
    // (1 - n.y) meant 46-61 degrees, which nothing on this map ever reaches, so
    // the rock category never surfaced and the hill faces stayed grass-green.
    // 0.21..0.46 is roughly 37-56 degrees: the actual steep faces.
    //
    // CYCLE 5: the jitter was both TINY and BIASED. `rockNoise * 0.05 +
    // outcrop * 0.075` is uncentred fBm, so it contributed a constant +0.0625
    // offset plus at most +/-0.062 of actual variation against a transition band
    // 0.25 wide — i.e. under a quarter of a band width. On a cone, slope is a
    // monotonic function of altitude, so a threshold that tight traces a
    // CONTOUR LINE, which is exactly what the capture shows: rock -> tan ->
    // lime -> rock as perfectly parallel constant-width stripes wrapping every
    // peak, with roughly 2px transitions.
    //
    // Now centred (so the mean coverage is unchanged), widened to +/-0.23 —
    // just under a full band width — and GATED by `faceted` so the jitter can
    // only fire where a face actually exists. Without that gate a +0.23 excursion
    // paints rock onto flat farmland.
    const rn = rockNoise - 0.5;
    const on = outcrop - 0.5;
    const faceted = smoothstep(0.06, 0.30, slope);
    let rock = smoothstep(0.21, 0.46, slope + 0.0625 + (rn * 0.20 + on * 0.26) * faceted);
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

    // Dirt: scree/talus apron under the rock line, field margins, ploughed
    // cells, verges, beach. The scree band is deliberately wider than the rock
    // band underneath it so grass never butts straight onto stone.
    // Same treatment: the scree apron's own threshold traced a second contour
    // just below the rock line, which is what produced the tan stripe.
    let dirt =
      smoothstep(0.075, 0.20, slope + 0.025 + (rn * 0.090 + on * 0.075) * smoothstep(0.02, 0.16, slope)) * 0.85;
    dirt = Math.max(dirt, ploughed * 0.82);
    dirt = Math.max(dirt, par.margin * farmBase * 0.55);
    dirt = Math.max(dirt, smoothstep(ROAD_FALLOFF, ROAD_HALF, rd) * 0.6);
    dirt = Math.max(dirt, smoothstep(4.2, 1.0, h)); // beach
    dirt = clamp(dirt, 0, 1);

    const rockW = rock;
    const dirtW = clamp(dirt, 0, 1) * (1 - rockW);

    return {
      // grass is 1 - dirt - rock by construction, so the splat map does not
      // need to store it — the freed red channel carries sea depth for the
      // water shader instead (see Terrain.buildMaps).
      height: h,
      splat: { grass: Math.max(0, 1 - rockW - dirtW), dirt: dirtW, rock: rockW, road: roadT },
      field: {
        tone: par.tone,
        angle: par.angle,
        edge: par.edge,
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
