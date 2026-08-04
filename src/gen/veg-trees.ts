import * as THREE from 'three';
import { hash2 } from './noise';
import { LEAF_BIRCH, LEAF_BRAMBLE, LEAF_OAK, LEAF_PINE, LEAF_SHRUB } from './veg-atlas';

// Tree and bush structure. Everything is UNIT SPACE (1.0 == plant height), so a
// single prototype mesh plus an instance scale carries every size tier.
//
// Cycle 3 rewrote this around one rule the cycle-2 crowns broke: NO LEAF MASS
// MAY FLOAT AND NO BRANCH MAY END BARE. Cycle 2 built a trunk with five
// near-horizontal constant-width planks and then hung a cloud of leaf cards in
// a separate dome above it, so every crown read as a blob balanced on a pole
// with brown ribbons poking out of it.
//
// Now the trunk, the primaries and the twigs come out of ONE recursive skeleton
// (3 levels, radius tapering r_child = 0.62 * r_parent, length capped at 0.55 of
// the parent), that skeleton is cached per species, and treeCrown() reads its
// TWIG TIPS: every twig ends inside a leaf cluster, and the volumetric fill
// cards are sampled in a squashed ellipsoid with a hollowed core so the canopy
// has interior depth instead of being a shell.

export type TreeSpecies = 'oak' | 'birch' | 'pine';
export type BushVariant = 'dense' | 'open' | 'sprawl' | 'bramble' | 'tall';

function stream(seed: number): () => number {
  let i = 1;
  return () => hash2(seed, i++);
}

export interface FoliageCard {
  x: number; y: number; z: number;
  yaw: number;
  tilt: number;
  w: number; h: number;
  tile: number;
  rand: number;
}

// ---------------------------------------------------------------------------
// Tapered limb builder
// ---------------------------------------------------------------------------

interface Build { pos: number[]; nrm: number[]; uv: number[]; idx: number[] }

const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();

/**
 * One tapered, gently drooping limb. Rings are placed at arbitrary t values so
 * the base of a trunk can carry a ROOT FLARE without paying for extra rings up
 * the whole length. Normals are radial (smooth around the circumference), which
 * is what stops a low-poly cylinder reading as flat vertical facets.
 */
function limb(
  b: Build,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  droop: THREE.Vector3,
  len: number,
  ringT: number[],
  radiusAt: (t: number) => number,
  radial: number,
  vSpan: number
): { tip: THREE.Vector3; tipDir: THREE.Vector3 } {
  const side = TMP_A.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.97) side.set(1, 0, 0);
  side.cross(dir).normalize();
  const up = TMP_B.copy(dir).cross(side).normalize();
  const sx = side.x, sy = side.y, sz = side.z;
  const ux = up.x, uy = up.y, uz = up.z;

  const base = b.pos.length / 3;
  for (let k = 0; k < ringT.length; k++) {
    const t = ringT[k];
    const cx = origin.x + dir.x * len * t + droop.x * t * t;
    const cy = origin.y + dir.y * len * t + droop.y * t * t;
    const cz = origin.z + dir.z * len * t + droop.z * t * t;
    const r = radiusAt(t);
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = sx * ca + ux * sa;
      const ny = sy * ca + uy * sa;
      const nz = sz * ca + uz * sa;
      b.pos.push(cx + nx * r, cy + ny * r, cz + nz * r);
      b.nrm.push(nx, ny, nz);
      b.uv.push(i / radial, t * vSpan);
    }
  }
  const stride = radial + 1;
  for (let k = 0; k < ringT.length - 1; k++) {
    for (let i = 0; i < radial; i++) {
      const a = base + k * stride + i;
      const c = a + stride;
      b.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  const tip = new THREE.Vector3(
    origin.x + dir.x * len + droop.x,
    origin.y + dir.y * len + droop.y,
    origin.z + dir.z * len + droop.z
  );
  const tipDir = new THREE.Vector3(
    dir.x * len + droop.x * 2,
    dir.y * len + droop.y * 2,
    dir.z * len + droop.z * 2
  ).normalize();
  return { tip, tipDir };
}

// ---------------------------------------------------------------------------
// Species skeletons
// ---------------------------------------------------------------------------

export interface BranchTip {
  x: number; y: number; z: number;
  /** Unit direction the twig is pointing when it ends. */
  dx: number; dy: number; dz: number;
  /** Twig radius at the tip — drives how big a cluster it can carry. */
  r: number;
}

export interface TreeSkeleton {
  geo: THREE.BufferGeometry;
  tips: BranchTip[];
  /** Crown centre height and radii in unit space. */
  cy: number; rx: number; ry: number;
}

interface TrunkSpec {
  h: number;
  rBot: number; rTop: number;
  radial: number;
  primaries: number;
  pMinY: number; pMaxY: number;
  pLen: number;
  /** Pitch from VERTICAL, radians. 35-55 deg, never the near-90 of cycle 2. */
  pitchMin: number; pitchMax: number;
  twigs: number;
  cy: number; rx: number; ry: number;
}

const TRUNKS: Record<TreeSpecies, TrunkSpec> = {
  oak: {
    h: 0.48, rBot: 0.050, rTop: 0.020, radial: 8,
    primaries: 4, pMinY: 0.26, pMaxY: 0.47, pLen: 0.30,
    pitchMin: 0.62, pitchMax: 0.98, twigs: 7,
    cy: 0.68, rx: 0.40, ry: 0.29,
  },
  birch: {
    h: 0.64, rBot: 0.028, rTop: 0.010, radial: 7,
    primaries: 4, pMinY: 0.34, pMaxY: 0.63, pLen: 0.24,
    pitchMin: 0.50, pitchMax: 0.86, twigs: 7,
    cy: 0.74, rx: 0.25, ry: 0.28,
  },
  pine: {
    h: 0.70, rBot: 0.040, rTop: 0.014, radial: 7,
    primaries: 4, pMinY: 0.48, pMaxY: 0.70, pLen: 0.26,
    pitchMin: 0.70, pitchMax: 1.02, twigs: 6,
    cy: 0.82, rx: 0.33, ry: 0.21,
  },
};

/** r_child = 0.62 * r_parent at every split, per the branching finding. */
const CHILD_R = 0.62;
/** A child limb never exceeds 55% of its parent's length. */
const CHILD_LEN = 0.55;

const SKELETONS = new Map<string, TreeSkeleton>();

/**
 * Trunk + primaries + twigs as ONE merged mesh, plus the world-space twig tips
 * the crown hangs off. Cached per (species, seed) — every instance of a species
 * shares the prototype, so the cost of the extra recursion level is paid once.
 */
export function treeSkeleton(species: TreeSpecies, seed: number): TreeSkeleton {
  const key = `${species}:${seed}`;
  const hit = SKELETONS.get(key);
  if (hit) return hit;

  const s = TRUNKS[species];
  const r = stream(seed + 313);
  const b: Build = { pos: [], nrm: [], uv: [], idx: [] };
  const tips: BranchTip[] = [];

  // --- level 0: trunk. Extra rings crowded at the base carry the root flare,
  // which is what stops a trunk entering the ground as a sliced cylinder.
  const flareT = [0, 0.018, 0.055, 0.16, 0.5, 1.0];
  const trunkR = (t: number): number => {
    const taper = s.rBot + (s.rTop - s.rBot) * Math.pow(t, 0.62);
    // 1 + 0.9 * exp(-h / 0.4 m); a 10 m tree makes 0.4 m ~ 0.04 unit.
    return taper * (1 + 0.95 * Math.exp(-(t * s.h) / 0.042));
  };
  limb(
    b, new THREE.Vector3(0, -0.04, 0), new THREE.Vector3(0, 1, 0),
    new THREE.Vector3((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.03),
    s.h + 0.04, flareT, trunkR, s.radial, 1.0
  );

  // --- level 1: primaries. Pitched 35-55 deg off vertical, tapered, drooping.
  const primaryTips: { p: THREE.Vector3; d: THREE.Vector3; r: number; len: number }[] = [];
  for (let i = 0; i < s.primaries; i++) {
    const yaw = (i / s.primaries) * Math.PI * 2 + r() * 0.9;
    const pitch = s.pitchMin + r() * (s.pitchMax - s.pitchMin);
    const y0 = s.pMinY + ((i + r() * 0.6) / s.primaries) * (s.pMaxY - s.pMinY);
    const len = s.pLen * (0.72 + r() * 0.62);
    const dir = new THREE.Vector3(
      Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch), Math.sin(pitch) * Math.sin(yaw)
    ).normalize();
    const r0 = trunkR(Math.min(0.95, y0 / s.h)) * 0.55;
    const r1 = r0 * CHILD_R;
    const res = limb(
      b, new THREE.Vector3(0, y0, 0), dir,
      new THREE.Vector3(0, -len * (0.16 + r() * 0.16), 0),
      len, [0, 0.42, 1.0],
      (t) => r0 + (r1 - r0) * Math.pow(t, 0.55),
      4, 0.5
    );
    primaryTips.push({ p: res.tip, d: res.tipDir, r: r1, len });
  }

  // --- level 2: twigs off the primaries. Every twig END becomes a leaf anchor,
  // so no stick can terminate in open air.
  for (let i = 0; i < s.twigs; i++) {
    const par = primaryTips[i % primaryTips.length];
    const yaw = r() * Math.PI * 2;
    const spread = 0.45 + r() * 0.55;
    const dir = new THREE.Vector3(
      par.d.x + Math.cos(yaw) * spread,
      par.d.y + 0.30 + r() * 0.35,
      par.d.z + Math.sin(yaw) * spread
    ).normalize();
    const len = par.len * CHILD_LEN * (0.6 + r() * 0.7);
    const back = 0.15 + r() * 0.35;
    const org = new THREE.Vector3(
      par.p.x - par.d.x * par.len * back,
      par.p.y - par.d.y * par.len * back,
      par.p.z - par.d.z * par.len * back
    );
    const r0 = par.r * 0.9;
    // Taper the last segment to a POINT, not to a flat 0.62 cap. Cycle 3's
    // twigs ended in square-cut discs of untextured brown, which is what read
    // as scaffolding nailed through the crown near the trunk fork.
    const res = limb(
      b, org, dir, new THREE.Vector3(0, -len * 0.14, 0), len, [0, 1.0],
      (t) => r0 * Math.max(0.05, 1 - Math.pow(t, 0.75)), 3, 0.3
    );
    tips.push({
      x: res.tip.x, y: res.tip.y, z: res.tip.z,
      dx: res.tipDir.x, dy: res.tipDir.y, dz: res.tipDir.z,
      r: r0 * CHILD_R,
    });
  }
  // Primary tips are anchors too — a bare primary is exactly the "plank that
  // just stops" the critics called out.
  for (const p of primaryTips) {
    tips.push({ x: p.p.x, y: p.p.y, z: p.p.z, dx: p.d.x, dy: p.d.y, dz: p.d.z, r: p.r });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  geo.setIndex(b.idx);
  geo.computeBoundingSphere();

  const skel: TreeSkeleton = { geo, tips, cy: s.cy, rx: s.rx, ry: s.ry };
  SKELETONS.set(key, skel);
  return skel;
}

/** Back-compat entry point for the trunk mesh alone. */
export function treeTrunkGeometry(species: TreeSpecies, seed: number): THREE.BufferGeometry {
  return treeSkeleton(species, seed).geo;
}

const LEAF_TILE_FOR: Record<TreeSpecies, number> = {
  oak: LEAF_OAK, birch: LEAF_BIRCH, pine: LEAF_PINE,
};

/**
 * Per-tree crown layout. Two populations:
 *
 *   * ANCHOR clusters, one per twig tip, small, sitting just beyond the tip so
 *     the twig is buried in its own leaf mass;
 *   * VOLUME clusters, sampled in a squashed ellipsoid with density falling as
 *     (1 - r^2) and an inner core of 0.25 left hollow, at three size classes so
 *     the silhouette carries more than one spatial frequency.
 *
 * The per-tree seed jitters both, so no two crowns share an outline even though
 * every tree of a species shares one trunk mesh.
 */
export function treeCrown(species: TreeSpecies, seed: number, skel: TreeSkeleton): FoliageCard[] {
  const r = stream(seed);
  const cards: FoliageCard[] = [];
  const tile = LEAF_TILE_FOR[species];
  const wBase = species === 'oak' ? 0.40 : species === 'birch' ? 0.30 : 0.36;

  for (const t of skel.tips) {
    // Slightly past the tip, so the last twig segment sits INSIDE the cluster.
    const push = 0.05 + r() * 0.05;
    const x = t.x + t.dx * push + (r() - 0.5) * 0.05;
    const y = t.y + t.dy * push + (r() - 0.5) * 0.05;
    const z = t.z + t.dz * push + (r() - 0.5) * 0.05;
    const sc = 0.44 + r() * 0.34;
    cards.push({
      x, y, z,
      yaw: Math.atan2(z, x) + r() * 1.6,
      tilt: (r() - 0.5) * 1.1,
      w: wBase * sc,
      h: wBase * sc * (0.82 + r() * 0.32),
      tile,
      rand: r(),
    });
  }

  // Volume fill. Rejection-sampled so the (1 - r^2) profile is honest and the
  // hollow core actually stays hollow.
  const fill = species === 'pine' ? 11 : 13;
  let placed = 0;
  for (let guard = 0; guard < 200 && placed < fill; guard++) {
    const u = r() * 2 - 1;
    const v = r() * 2 - 1;
    const w = r() * 2 - 1;
    const rr = Math.sqrt(u * u + v * v + w * w);
    if (rr > 1 || rr < 0.25) continue;
    if (r() > 1 - rr * rr * 0.72) continue;
    placed++;
    const x = u * skel.rx;
    const y = skel.cy + v * skel.ry;
    const z = w * skel.rx;
    // Three size classes: the small ones ride the outside and break the outline.
    const cls = r();
    const sc = cls < 0.42 ? 0.95 + r() * 0.35 : cls < 0.78 ? 0.55 + r() * 0.25 : 0.30 + r() * 0.18;
    cards.push({
      x, y, z,
      yaw: Math.atan2(z, x) + r() * 1.7,
      tilt: (r() - 0.5) * 1.3,
      w: wBase * sc,
      h: wBase * sc * (0.80 + r() * 0.34),
      tile,
      rand: r(),
    });
  }
  return cards;
}

/** Sparse dry crown for a dead snag, so a bare pole never stands in a wood. */
export function snagCrown(seed: number): FoliageCard[] {
  const r = stream(seed + 4409);
  const cards: FoliageCard[] = [];
  for (let i = 0; i < 5; i++) {
    const a = i * 2.3999632 + r() * 0.8;
    const rad = 0.10 + r() * 0.16;
    cards.push({
      x: Math.cos(a) * rad,
      y: 0.44 + r() * 0.40,
      z: Math.sin(a) * rad,
      yaw: a + r() * 1.4,
      tilt: (r() - 0.5) * 1.2,
      w: 0.20 * (0.7 + r() * 0.6),
      h: 0.17 * (0.7 + r() * 0.6),
      tile: LEAF_BRAMBLE,
      rand: r(),
    });
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Shrubs
// ---------------------------------------------------------------------------

export const BUSH_VARIANTS: BushVariant[] = ['dense', 'open', 'sprawl', 'bramble', 'tall'];

interface BushSpec {
  stems: number;
  stemH: number;
  spread: number;
  /** Crown ellipsoid, unit space. */
  cy: number; rx: number; ry: number;
  cards: number;
  cardW: number;
  tile: number;
}

// Stem counts came down in cycle 4 because the shrub layer more than doubled:
// the woody stems ride one instanced draw but their triangles are paid for on
// every frame, and the stems are almost entirely buried inside their own crown.
const BUSHES: Record<BushVariant, BushSpec> = {
  dense: { stems: 5, stemH: 0.34, spread: 0.30, cy: 0.55, rx: 0.44, ry: 0.34, cards: 14, cardW: 0.38, tile: LEAF_SHRUB },
  open: { stems: 4, stemH: 0.44, spread: 0.36, cy: 0.60, rx: 0.46, ry: 0.36, cards: 11, cardW: 0.34, tile: LEAF_SHRUB },
  sprawl: { stems: 5, stemH: 0.22, spread: 0.46, cy: 0.40, rx: 0.56, ry: 0.26, cards: 13, cardW: 0.36, tile: LEAF_OAK },
  bramble: { stems: 4, stemH: 0.30, spread: 0.40, cy: 0.48, rx: 0.50, ry: 0.30, cards: 11, cardW: 0.34, tile: LEAF_BRAMBLE },
  // The missing 1.8-2.5 m stratum: a narrow upright shrub, taller than it is
  // wide, that fills the gap between the sward and the canopy.
  tall: { stems: 5, stemH: 0.62, spread: 0.22, cy: 0.62, rx: 0.30, ry: 0.34, cards: 15, cardW: 0.30, tile: LEAF_SHRUB },
};

const BUSH_GEO = new Map<string, THREE.BufferGeometry>();

/**
 * Short woody stem set for a shrub — 6-9 tapered stems on a hemispherical
 * spread, with a root flare, in unit space. Cycle 2 had this function written
 * and never called it, which is how the shrub layer ended up being the grass
 * tuft mesh scaled up.
 */
export function bushBranchGeometry(variant: BushVariant, seed: number): THREE.BufferGeometry {
  const key = `${variant}:${seed}`;
  const hit = BUSH_GEO.get(key);
  if (hit) return hit;
  const s = BUSHES[variant];
  const r = stream(seed + 881);
  const b: Build = { pos: [], nrm: [], uv: [], idx: [] };
  for (let i = 0; i < s.stems; i++) {
    const yaw = (i / s.stems) * Math.PI * 2 + r() * 1.0;
    const pitch = 0.24 + r() * 0.62;
    const len = s.stemH * (0.62 + r() * 0.9);
    const dir = new THREE.Vector3(
      Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch), Math.sin(pitch) * Math.sin(yaw)
    ).normalize();
    const r0 = 0.016 * (0.7 + r() * 0.6);
    limb(
      b, new THREE.Vector3(0, -0.05, 0), dir,
      new THREE.Vector3(Math.cos(yaw) * len * 0.12, -len * 0.10, Math.sin(yaw) * len * 0.12),
      len + 0.05, [0, 0.08, 1.0],
      (t) => (r0 + (r0 * 0.30 - r0) * t) * (1 + 0.9 * Math.exp(-t * 14)),
      3, 0.5
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  geo.setIndex(b.idx);
  geo.computeBoundingSphere();
  BUSH_GEO.set(key, geo);
  return geo;
}

/**
 * Per-bush leaf layout. Volumetric, like the tree crown: cards sampled through
 * a squashed ellipsoid with a hollow core, at randomised yaw AND pitch, so the
 * mass occupies real depth instead of presenting one horizontal pancake to the
 * camera the way cycle 2's tilt-capped ring did.
 */
export function bushCrown(variant: BushVariant, seed: number): FoliageCard[] {
  const s = BUSHES[variant];
  const r = stream(seed);
  const cards: FoliageCard[] = [];
  let placed = 0;
  for (let guard = 0; guard < 260 && placed < s.cards; guard++) {
    const u = r() * 2 - 1;
    const v = r() * 2 - 1;
    const w = r() * 2 - 1;
    const rr = Math.sqrt(u * u + v * v + w * w);
    if (rr > 1 || rr < 0.22) continue;
    if (r() > 1 - rr * rr * 0.62) continue;
    placed++;
    const x = u * s.rx;
    const y = Math.max(0.10, s.cy + v * s.ry);
    const z = w * s.rx;
    const cls = r();
    const sc = cls < 0.55 ? 0.9 + r() * 0.4 : cls < 0.85 ? 0.55 + r() * 0.28 : 0.32 + r() * 0.18;
    cards.push({
      x, y, z,
      yaw: Math.atan2(z, x) + r() * 1.8,
      // Full pitch range: a shrub seen edge-on has to show leaf faces at every
      // angle, which is exactly what the capped tilt prevented.
      tilt: (r() - 0.5) * 1.5,
      w: s.cardW * sc,
      h: s.cardW * sc * (0.78 + r() * 0.36),
      tile: s.tile,
      rand: r(),
    });
  }
  return cards;
}
