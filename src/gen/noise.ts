// Deterministic noise toolkit (CPU side). Everything seeds from WORLD_SEED so the
// map, splat, buildings and loot are identical on every boot and every capture.

export const WORLD_SEED = 1187;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const GRAD2: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

export class Simplex2 {
  private perm: Uint8Array;

  constructor(seed: number) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Returns noise in [-1, 1]. */
  noise(xin: number, yin: number): number {
    const perm = this.perm;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      t0 *= t0;
      const g = GRAD2[perm[ii + perm[jj]] & 7];
      n += t0 * t0 * (g[0] * x0 + g[1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      t1 *= t1;
      const g = GRAD2[perm[ii + i1 + perm[jj + j1]] & 7];
      n += t1 * t1 * (g[0] * x1 + g[1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      t2 *= t2;
      const g = GRAD2[perm[ii + 1 + perm[jj + 1]] & 7];
      n += t2 * t2 * (g[0] * x2 + g[1] * y2);
    }
    return 70 * n;
  }
}

export interface FbmOptions {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  frequency?: number;
  amplitude?: number;
}

export class NoiseField {
  private simplex: Simplex2;

  constructor(seed: number) {
    this.simplex = new Simplex2(seed);
  }

  noise(x: number, y: number): number {
    return this.simplex.noise(x, y);
  }

  /** Standard fractal Brownian motion, output roughly [-1, 1]. */
  fbm(x: number, y: number, o: FbmOptions = {}): number {
    const { octaves = 5, lacunarity = 2, gain = 0.5, frequency = 1, amplitude = 1 } = o;
    let f = frequency, a = amplitude, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += a * this.simplex.noise(x * f, y * f);
      norm += a;
      f *= lacunarity;
      a *= gain;
    }
    return sum / norm;
  }

  /** Ridged multifractal, output [0, 1] — sharp mountain ridges. */
  ridged(x: number, y: number, o: FbmOptions = {}): number {
    const { octaves = 5, lacunarity = 2.1, gain = 0.55, frequency = 1 } = o;
    let f = frequency, a = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.simplex.noise(x * f, y * f));
      sum += a * n * n;
      norm += a;
      f *= lacunarity;
      a *= gain;
    }
    return sum / norm;
  }

  /** Domain-warped fbm — organic patchiness for splat masks and macro variation. */
  warped(x: number, y: number, warp: number, o: FbmOptions = {}): number {
    const wx = this.fbm(x + 13.7, y + 71.3, { octaves: 3, frequency: (o.frequency ?? 1) * 0.7 });
    const wy = this.fbm(x - 41.1, y + 5.9, { octaves: 3, frequency: (o.frequency ?? 1) * 0.7 });
    return this.fbm(x + wx * warp, y + wy * warp, o);
  }
}

/** Voronoi F1 distance + cell id on a jittered grid. */
export function voronoi2(x: number, y: number, seed = 0): { f1: number; id: number } {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 8, id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const jx = cx + hash2(cx, cy, seed);
      const jy = cy + hash2(cx, cy, seed + 1);
      const d = (x - jx) * (x - jx) + (y - jy) * (y - jy);
      if (d < f1) { f1 = d; id = (cx * 73856093) ^ (cy * 19349663) ^ seed; }
    }
  }
  return { f1: Math.sqrt(f1), id };
}

/**
 * Voronoi returning F1, F2 and the winning cell id. `f2 - f1` is the classic
 * cell-boundary distance — used to draw field margins between farm parcels.
 */
export function voronoiCell(x: number, y: number, seed = 0): { f1: number; f2: number; id: number } {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 8, f2 = 8, id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const jx = cx + hash2(cx, cy, seed);
      const jy = cy + hash2(cx, cy, seed + 1);
      const d = (x - jx) * (x - jx) + (y - jy) * (y - jy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ seed) | 0;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1: Math.sqrt(f1), f2: Math.sqrt(f2), id };
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function remap(v: number, inA: number, inB: number, outA: number, outB: number): number {
  return outA + ((v - inA) / (inB - inA)) * (outB - outA);
}
