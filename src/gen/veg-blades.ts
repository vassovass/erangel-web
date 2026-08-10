import * as THREE from 'three';
import { hash2 } from './noise';

// REAL ground-cover geometry for the near band — no texture, no alpha test.
//
// Cycle 1 drew every clump as one camera-facing textured quad. Three separate
// failures came out of that single decision and all three are fixed by using
// actual geometry instead:
//
//   * the quad's mip-averaged bottom band went opaque and wrote depth, so every
//     clump sat in a hard rectangular pedestal;
//   * the whole meadow swivelled with the camera and had no inter-blade
//     parallax;
//   * a cutout needs alpha testing, which aliases, shimmers and dissolves.
//
// Cycle 3 fixed what cycle 2's ribbons still got wrong:
//
//   * WIDTH CONVERGES TO ZERO. The old profile stopped at 5% width on the last
//     of three segments, which reads as a chisel-cut straw. Five segments and
//     w(t) = w0 * (1 - t^1.45) draw the blade to an actual point.
//   * EVERY BLADE CARRIES A TANGENT. Grass is bright in a still frame because
//     the sun throws a grazing anisotropic sheen along the blade axis; without
//     a tangent the material simply cannot produce that highlight, which is why
//     the whole field sat in a flat 100-158 luminance band.
//   * THE CROSS-SECTION IS CURVED. Edge vertices carry normals rolled about the
//     blade axis, so a blade shades as a folded channel with a bright side and
//     a shaded side rather than as one flat value.
//   * THERE IS A LITTER STRATUM. Flat, dead, ground-hugging cards under the
//     standing blades. PUBG's dry field has a whole layer of collapsed dead
//     grass; it is where its sub-luminance-25 fraction comes from, and it is
//     also the only honest way to darken the contact without a decal pass.
//
// Unit space: y = 1.0 is the nominal clump height and xz is in the same units,
// so one instance scale (w, h, w) carries the whole size. Roots run DOWN to
// y = -0.13 and splay outward, so once an instance is planted at the sampled
// terrain height the root ring is buried 5-10 cm and the terrain depth-tests
// the intersection away — there is no straight cut line to see.

export type CoverKind = 'tussock' | 'dry' | 'mat' | 'dock' | 'fern' | 'herb';

export const COVER_KINDS: CoverKind[] = ['tussock', 'dry', 'mat', 'dock', 'fern', 'herb'];

/** aBlade.w kinds, read by the blade fragment shader. */
export const KIND_LEAF = 0;
export const KIND_FLOWER = 1;
export const KIND_LITTER = 2;
export const KIND_SEED = 3;

/** Root burial depth in unit space. */
const ROOT_SINK = 0.13;

function stream(seed: number): () => number {
  let i = 1;
  return () => hash2(seed, i++);
}

interface Build {
  pos: number[];
  nrm: number[];
  tan: number[];   // vec3: blade long axis, for the anisotropic sheen
  bld: number[];   // vec4: h(0..1), side(-1..1), bladeRand(0..1), kind
  idx: number[];
}

/**
 * The REAL grass profile: width holds through most of the blade and then
 * collapses over the last third to a hair-thin tip.
 *
 * Cycle 3 held 60-100% width across the whole lower 18% and then fell off on a
 * smooth 1.45 power, which over 4 segments lathe-turns a spindle — a bare
 * tapered rod, which is precisely what the near band read as. A fescue blade is
 * a strap: near-parallel-sided to past half height, then drawn to a point.
 */
function widthAt(t: number): number {
  if (t < 0.06) return 0.74 + 0.26 * (t / 0.06);
  const u = Math.min(1, Math.max(0, (t - 0.06) / 0.94));
  return Math.max(0, 1 - Math.pow(u, 1.9));
}

/**
 * One tapered, curved ribbon. `bend` is the tip lean as a fraction of height,
 * applied on a quadratic so the root stays vertical and only the upper blade
 * arches — grass droops under its own weight and never stands in lockstep.
 *
 * `twist` rolls the whole cross-section about the blade axis by a per-blade
 * amount, so a clump catches the anisotropic sheen at a spread of angles
 * instead of every blade winking on together.
 */
function ribbon(
  b: Build,
  rx: number, rz: number, azim: number,
  H: number, W: number, bend: number, segs: number,
  bladeRand: number, pinnate: boolean, kind: number, twist: number
): void {
  const dx = Math.cos(azim);
  const dz = Math.sin(azim);
  const sx = -Math.sin(azim);
  const sz = Math.cos(azim);
  const base = b.pos.length / 3;
  // Cross-section roll. At 0.55 a 3 cm strap shaded as a glossy round dowel;
  // a 5 mm blade has no visible tube shading at all, so this is now a hint of
  // channel curvature and nothing more.
  const roll = 0.22;

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const bt = t * t;
    const reach = bend * H * bt;
    let y = H * t - H * bend * bend * bt * 0.30;
    // Bury the root ring and splay it outward.
    const sink = Math.max(0, 1 - t / 0.18);
    y -= ROOT_SINK * sink;
    const cx = rx + dx * (reach + 0.05 * sink);
    const cz = rz + dz * (reach + 0.05 * sink);

    let hw = W * widthAt(t);
    // Pinnate fronds: the width oscillates so the outline reads as leaflets.
    if (pinnate) hw *= 0.42 + 0.58 * Math.abs(Math.sin(t * Math.PI * 4.5));

    // Tangent along the blade: d/dt of the centreline, normalised.
    let tx = dx * bend * H * 2 * t;
    const ty = H * (1 - bend * bend * t * 0.6);
    let tz = dz * bend * H * 2 * t;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; tz /= tl;
    const tyn = ty / tl;

    // Face normal = cross(tangent, side), biased skyward. Foliage lit off its
    // true (near-horizontal) face reads as cardboard; a skyward-biased normal
    // makes a clump shade as a volume and keeps the shadow side off zero.
    let nx = tyn * sz - tz * 0;
    let ny = tz * sx - tx * sz;
    let nz = tx * 0 - tyn * sx;
    const gl = Math.hypot(nx, ny, nz) || 1;
    nx /= gl; ny /= gl; nz /= gl;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    nx = nx * 0.42 + dx * 0.26;
    ny = ny * 0.42 + 0.82;
    nz = nz * 0.42 + dz * 0.26;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;

    for (const side of [-1, 1] as const) {
      // Roll the edge normal about the blade axis so the ribbon shades as a
      // folded channel. Rodrigues about the (unit) tangent, small-angle exact.
      const a = side * roll + twist;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dot = nx * tx + ny * tyn + nz * tz;
      const crx = tyn * nz - tz * ny;
      const cry = tz * nx - tx * nz;
      const crz = tx * ny - tyn * nx;
      const ex = nx * ca + crx * sa + tx * dot * (1 - ca);
      const ey = ny * ca + cry * sa + tyn * dot * (1 - ca);
      const ez = nz * ca + crz * sa + tz * dot * (1 - ca);
      const el = Math.hypot(ex, ey, ez) || 1;
      b.pos.push(cx + sx * hw * side, y, cz + sz * hw * side);
      b.nrm.push(ex / el, ey / el, ez / el);
      b.tan.push(tx, tyn, tz);
      b.bld.push(t, side, bladeRand, kind);
    }
  }
  for (let i = 0; i < segs; i++) {
    const a = base + i * 2;
    b.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

/**
 * A seed umbel: several TINY facing quads scattered around a point. One or two
 * big cross-quads here render as cream paper squares floating over the meadow,
 * which is exactly what the first attempt produced.
 */
function flowerHead(b: Build, x: number, y: number, z: number, r: number, rand: number): void {
  for (let q = 0; q < 4; q++) {
    const a = q * 1.9 + rand * 5.0;
    const spread = r * 1.7;
    const px = x + Math.cos(a) * spread * (0.3 + (q % 2) * 0.7);
    const py = y + (q * 0.31 - 0.46) * r;
    const pz = z + Math.sin(a) * spread * (0.3 + (q % 2) * 0.7);
    const ux = Math.cos(a + 1.2) * r, uz = Math.sin(a + 1.2) * r;
    const base = b.pos.length / 3;
    const pts: [number, number, number][] = [
      [px - ux, py - r * 0.7, pz - uz], [px + ux, py - r * 0.7, pz + uz],
      [px - ux, py + r * 0.7, pz - uz], [px + ux, py + r * 0.7, pz + uz],
    ];
    // Petal normals fan outward so a head is not one flat facing value — that
    // is what turned the old umbels into white paper squares.
    const nx = Math.cos(a) * 0.55, nz = Math.sin(a) * 0.55;
    const nl = Math.hypot(nx, 0.83, nz);
    for (let k = 0; k < 4; k++) {
      b.pos.push(pts[k][0], pts[k][1], pts[k][2]);
      b.nrm.push(nx / nl, 0.83 / nl, nz / nl);
      b.tan.push(-Math.sin(a), 0.2, Math.cos(a));
      b.bld.push(1, k % 2 === 0 ? -1 : 1, rand, KIND_FLOWER);
    }
    b.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
}

/**
 * MATTED thatch: a few broad, low, ground-hugging cards that overlap into a
 * combed layer under the standing blades.
 *
 * Cycle 3 emitted 8-12 long thin trapezoids per clump at random azimuths and
 * shaded them darker than anything else in the frame, which is the exact
 * "black asterisk stamped on the ground" failure its own comment claimed to
 * have fixed — they read as burnt twigs scattered over a lawn and they were
 * the single loudest artifact in the near field.
 *
 * Two rules now hold. (1) Every card shares ONE per-clump lay direction within
 * +/- 0.35 rad, so they comb together instead of crossing as a star. (2) They
 * are broad and short, not slivers: a mat, not sticks. The value fix is in the
 * shader — thatch is a soft drop UNDER the sward, never a graphic mark on it.
 *
 * Sparse on purpose. Since the ground carpet's winding bug was fixed it is the
 * carpet, not this, that carries the continuous thatch stratum; these few cards
 * only supply the per-clump contact that a camera-following sheet cannot.
 */
function litter(b: Build, r: () => number, count: number, spread: number): void {
  const lay = r() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const a = lay + (r() - 0.5) * 2.6;
    const d = spread * (0.10 + r() * 0.62);
    const cx = Math.cos(a) * d;
    const cz = Math.sin(a) * d;
    // Combed to the clump's own lay direction, not radial.
    const dir = lay + (r() - 0.5) * 0.7;
    const len = spread * (0.90 + r() * 0.85);
    const wid = spread * (0.30 + r() * 0.30);
    const dxu = Math.cos(dir), dzu = Math.sin(dir);
    const sxu = -dzu, szu = dxu;
    // Clear of the ground carpet (which sits ~3 cm proud of the terrain plane)
    // but still visually lying on the soil.
    const y0 = 0.100 + r() * 0.022;
    const y1 = y0 + (r() - 0.45) * 0.018;
    const rand = r();
    const base = b.pos.length / 3;
    const pts: [number, number, number][] = [
      [cx - dxu * len * 0.5 - sxu * wid, y0, cz - dzu * len * 0.5 - szu * wid],
      [cx - dxu * len * 0.5 + sxu * wid, y0, cz - dzu * len * 0.5 + szu * wid],
      [cx + dxu * len * 0.5 - sxu * wid * 0.55, y1, cz + dzu * len * 0.5 - szu * wid * 0.55],
      [cx + dxu * len * 0.5 + sxu * wid * 0.55, y1, cz + dzu * len * 0.5 + szu * wid * 0.55],
    ];
    for (let k = 0; k < 4; k++) {
      b.pos.push(pts[k][0], pts[k][1], pts[k][2]);
      b.nrm.push(0, 1, 0);
      b.tan.push(dxu, 0.04, dzu);
      b.bld.push(0.0, k % 2 === 0 ? -1 : 1, rand, KIND_LITTER);
    }
    b.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
}

interface CoverSpec {
  count: number;
  segs: number;
  hMin: number; hMax: number;
  wMin: number; wMax: number;
  bendMin: number; bendMax: number;
  rootR: number;
  /** Sub-tufts the blades are shared between (1 = a single rosette). */
  tufts: number;
  pinnate: boolean;
  flowers: number;
  /** Fraction of blades tagged as bleached seed stalks. */
  seed: number;
  litter: number;
  litterR: number;
}

// Blade widths are in UNIT-HEIGHT space and are HALF-widths, so the full blade
// is 2 * w * instanceWidth.
//
// Cycle 3 ran tussock at wMax 0.017 against an instance width of 0.86, i.e. a
// 3 cm strap on an 0.82 m blade — a 27:1 aspect where real fescue is 100-200:1.
// That single number is why the foreground read as a bundle of bare tapered
// rods rather than as grass, and no amount of shading could have saved it.
// These stops put a tussock blade at 4.5-9 mm full width: ~120:1.
//
// The counts went up with them. Thirteen blades on a jittered golden angle is
// the most evenly-splayed distribution possible and it guarantees an agave
// rosette with visible ground between the ribbons of ONE clump; the mass has to
// read as strands. `tufts` splits each clump into 3-4 sub-crowns so it is a
// cluster of tufts rather than a single fan.
const SPECS: Record<CoverKind, CoverSpec> = {
  // Tall arching meadow tussock — the workhorse.
  tussock: { count: 26, segs: 5, hMin: 0.70, hMax: 1.04, wMin: 0.0026, wMax: 0.0052, bendMin: 0.38, bendMax: 0.86, rootR: 0.070, tufts: 3, pinnate: false, flowers: 0, seed: 0.16, litter: 0, litterR: 0.42 },
  // Dry straw: taller, but never dead straight — cycle 2's 0.08 minimum bend is
  // exactly why the foreground read as drinking straws.
  dry: { count: 24, segs: 4, hMin: 0.76, hMax: 1.06, wMin: 0.0024, wMax: 0.0046, bendMin: 0.24, bendMax: 0.66, rootR: 0.062, tufts: 3, pinnate: false, flowers: 0, seed: 0.30, litter: 0, litterR: 0.42 },
  // Short ground-hugging cushion for verges, yards and mown ground.
  mat: { count: 20, segs: 4, hMin: 0.52, hMax: 0.90, wMin: 0.0030, wMax: 0.0058, bendMin: 0.70, bendMax: 1.25, rootR: 0.095, tufts: 4, pinnate: false, flowers: 0, seed: 0.05, litter: 0, litterR: 0.40 },
  // Broadleaf dock rosette — a real broadleaf, so it keeps a strap width.
  dock: { count: 9, segs: 4, hMin: 0.54, hMax: 0.82, wMin: 0.0080, wMax: 0.0140, bendMin: 0.60, bendMax: 1.05, rootR: 0.050, tufts: 2, pinnate: false, flowers: 1, seed: 0, litter: 0, litterR: 0.38 },
  // Fern: pinnate fronds, deep green, woodland edges.
  fern: { count: 7, segs: 4, hMin: 0.66, hMax: 0.94, wMin: 0.0090, wMax: 0.0150, bendMin: 0.55, bendMax: 1.00, rootR: 0.045, tufts: 2, pinnate: true, flowers: 0, seed: 0, litter: 0, litterR: 0.38 },
  // Flowering herb: thin stems with small umbels. This is the archetype the
  // flower-field patches concentrate, so it carries a real head count.
  herb: { count: 14, segs: 4, hMin: 0.72, hMax: 1.00, wMin: 0.0022, wMax: 0.0042, bendMin: 0.22, bendMax: 0.58, rootR: 0.048, tufts: 3, pinnate: false, flowers: 3, seed: 0.10, litter: 0, litterR: 0.36 },
};

/** Per-archetype ground-cover clump in unit space. */
export function coverGeometry(kind: CoverKind, seed: number): THREE.BufferGeometry {
  const s = SPECS[kind];
  const r = stream(seed + 7717);
  const b: Build = { pos: [], nrm: [], tan: [], bld: [], idx: [] };

  // Litter first: it lies under everything and never occludes a standing blade.
  litter(b, r, s.litter, s.litterR);

  // Sub-tuft centres. A clump is a small colony, not one crown: without this
  // every clump is a symmetric ring of ribbons fanning from a single point,
  // with clear ground visible between the ribbons of the SAME clump.
  const tufts: { x: number; z: number; a: number }[] = [];
  for (let t = 0; t < s.tufts; t++) {
    const ta = t * 2.3999632 + r() * 1.4;
    const td = s.rootR * (t === 0 ? 0.15 : 0.65 + r() * 0.75);
    tufts.push({ x: Math.cos(ta) * td, z: Math.sin(ta) * td, a: ta });
  }

  for (let i = 0; i < s.count; i++) {
    const tf = tufts[i % tufts.length];
    // Golden-angle azimuths jittered, offset per sub-tuft so the tufts do not
    // all present the same fan, and biased outward from the clump centre.
    const azim = (i * 2.3999632) + tf.a * 0.6 + (r() - 0.5) * 1.1;
    const rr = s.rootR * 0.42 * Math.sqrt(r());
    const rx = tf.x + Math.cos(azim) * rr;
    const rz = tf.z + Math.sin(azim) * rr;
    const H = s.hMin + r() * (s.hMax - s.hMin);
    const W = s.wMin + r() * (s.wMax - s.wMin);
    const bend = s.bendMin + r() * (s.bendMax - s.bendMin);
    const isSeed = r() < s.seed;
    ribbon(b, rx, rz, azim, H * (isSeed ? 1.14 : 1), W * (isSeed ? 0.7 : 1), bend, s.segs, r(),
      s.pinnate, isSeed ? KIND_SEED : KIND_LEAF, (r() - 0.5) * 1.2);
  }
  for (let i = 0; i < s.flowers; i++) {
    const azim = r() * Math.PI * 2;
    const H = (s.hMin + r() * (s.hMax - s.hMin)) * 1.06;
    const bend = s.bendMin + r() * (s.bendMax - s.bendMin);
    flowerHead(b, Math.cos(azim) * bend * H * 0.9, H, Math.sin(azim) * bend * H * 0.9, 0.007 + r() * 0.006, r());
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('aTan', new THREE.Float32BufferAttribute(b.tan, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(b.bld, 4));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Nominal clump height in metres before per-instance jitter. Cycle 3 first cut
 * these ~20% to kill the "drinking straws past the top of frame" read in the
 * ground pose, over-shot, and put half of it back: at 0.72 the near band no
 * longer covered the terrain plate and the field read as sparse stalks on a
 * painted lawn. These land a typical tussock near 0.80 m and cap it at ~1.45 m.
 */
export const COVER_SIZE: Record<CoverKind, { h: number; w: number }> = {
  tussock: { h: 0.82, w: 0.86 },
  dry: { h: 0.90, w: 0.72 },
  mat: { h: 0.32, w: 0.96 },
  dock: { h: 0.42, w: 0.84 },
  fern: { h: 0.62, w: 1.00 },
  herb: { h: 0.74, w: 0.62 },
};

/** Base dryness bias per archetype (0 lush, 1 straw). */
export const COVER_DRY: Record<CoverKind, number> = {
  tussock: 0.14, dry: 0.86, mat: 0.12, dock: 0.04, fern: 0.02, herb: 0.22,
};

/**
 * How much of the terrain dryness mask each archetype picks up. A dock or a
 * fern is a lush plant wherever it grows; without this the whole biome went
 * straw the moment the mask did, and the meadow lost every green note.
 */
export const COVER_DRY_GAIN: Record<CoverKind, number> = {
  tussock: 0.50, dry: 0.14, mat: 0.44, dock: 0.10, fern: 0.05, herb: 0.40,
};
