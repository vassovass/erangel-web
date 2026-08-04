import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  generateBuilding, emptyBag, PIECE_CATS,
  type BuildingKind, type GeoBag, type PieceCat,
} from '../gen/buildinggen';
import {
  emptyProps, fenceLine, yardWall, powerPole, stringWires, villageWell,
  haystack, crate, barrel, woodPile, type PoleTop, type PropSink,
} from '../gen/bld-props';
import { hash2, smoothstep } from '../gen/noise';
import type { Heightfield } from '../gen/terraingen';
import type { TextureFactory } from '../gen/texgen';
import type { PhysicsWorld } from '../player/physics';
import { plasterRecipe, roofMetalRecipe, woodPlankRecipe, brickRecipe, strawRecipe } from '../materials/buildings';
import { buildContactDecals, installSunShadowFit, type ShadowCaster } from './bld-shadow';
import { sunDirectionFor, useSkyEnv } from './sky';
import { parseBootParams } from '../core/settings';

// Village + farm placement. Every building and prop merges into one mesh per
// material category — 8 merged meshes plus one LineSegments for the power
// lines, whatever the settlement count. 90-degree rotations only for
// buildings, so their colliders stay AABBs; props are placed once in world
// space and register their rotated bounds.

interface Placement {
  kind: BuildingKind;
  x: number;
  z: number;
  /** Quarter-turns (0-3). */
  rot: number;
  seed: number;
}

export interface BuiltWorld {
  group: THREE.Group;
  lootSpots: THREE.Vector3[];
}

// The coastal road polyline, mirrored from terraingen's ROAD_PATHS[0]. Keeping
// a copy here is deliberate: the settlement layer needs the centreline to lay
// out lanes, verges, poles and fences, and terraingen only exposes a distance
// field.
const COAST: [number, number][] = [
  [-560, 180], [-380, 150], [-180, 120], [0, 90], [180, 110], [380, 170], [560, 230],
];

function roadZ(x: number): number {
  for (let i = 0; i < COAST.length - 1; i++) {
    const [ax, az] = COAST[i];
    const [bx, bz] = COAST[i + 1];
    if (x >= ax && x <= bx) return az + ((bz - az) * (x - ax)) / (bx - ax);
  }
  return x < COAST[0][0] ? COAST[0][1] : COAST[COAST.length - 1][1];
}

function roadGrad(x: number): number {
  for (let i = 0; i < COAST.length - 1; i++) {
    const [ax, az] = COAST[i];
    const [bx, bz] = COAST[i + 1];
    if (x >= ax && x <= bx) return (bz - az) / (bx - ax);
  }
  return 0;
}

// ------------------------------------------------------------- tinting -----

/**
 * Per-building albedo multiplier. Plaster carries the widest spread (Erangel's
 * houses run cream through ochre with the odd pale green), roofs a narrower
 * red-brown-to-slate band. Returned colours average around 1.0 so they modulate
 * the baked texture instead of replacing it.
 */
function paletteTint(seed: number, k: number, cool: number, spread: number, valLo: number, valHi: number): THREE.Color {
  const a = hash2(seed, k);
  const b = hash2(seed, k + 1);
  const c = hash2(seed, k + 2);
  const hue = a > 1 - cool ? 0.40 + b * 0.18 : 0.025 + a * spread;
  const sat = 0.045 + c * 0.17;
  const col = new THREE.Color().setHSL(hue, sat, 0.5);
  const mean = (col.r + col.g + col.b) / 3 || 1;
  col.multiplyScalar((valLo + b * (valHi - valLo)) / mean);
  return col;
}

/**
 * Writes the vertex colour attribute. `eaveY` drives the soot/AO band that
 * gathers under the roof overhang, plus a contact-darkening band at the base —
 * both are wall-scale effects that must not live in the tiling texture.
 */
function tintLocal(geo: THREE.BufferGeometry, col: THREE.Color, eaveY: number, shade: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let r = col.r;
    let g = col.g;
    let b = col.b;
    if (shade > 0) {
      const y = pos.getY(i);
      // Tight band under the overhang. Walls are now tessellated every ~30 cm
      // (buildinggen.box), so these smoothsteps are actually sampled instead of
      // being linearly interpolated between the top and bottom corners of a
      // single-segment box — which is what flattened every facade last cycle.
      const eave = 1 - shade * 0.60 * smoothstep(eaveY - 1.15, eaveY - 0.04, y);
      // Contact band: the bottom 40 cm carries most of it, trailing off by 1.1 m.
      const contact = shade * 0.45 * (1 - smoothstep(0.0, 1.05, y));
      const f = eave * (1 - contact);
      r = col.r * f;
      g = col.g * f;
      b = col.b * f;
      // Damp course: the base band is dirt, not neutral shade, so it warms and
      // desaturates rather than just going grey.
      const damp = shade * 0.30 * (1 - smoothstep(-0.1, 0.75, y));
      r += damp * 0.055;
      g += damp * 0.042;
      b += damp * 0.020;
    }
    arr[i * 3] = r;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/**
 * Props live in world space, so their contact AO is measured off their own
 * base, and their tint is hashed from where they stand — otherwise a hundred
 * merged fence posts share one colour and the run reads stamped.
 */
function tintProp(geo: THREE.BufferGeometry): void {
  // Anything that authored its own vertex colour (the creosoted power pole)
  // keeps it: hashing a tint off world position would undo the point.
  if (geo.getAttribute('color')) return;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  let minY = Infinity;
  let maxY = -Infinity;
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    sx += pos.getX(i);
    sz += pos.getZ(i);
  }
  // Hashed on a COARSE cell (~1.4 m), not on the piece's own centroid: at the
  // old 7x quantisation the two rails and the post of one fence bay each landed
  // in a different bucket, so a single run stepped through a 22% value range and
  // adjacent members disagreed about what timber they were. One bay now shares
  // one tone, and the spread across the run is halved.
  const hx = Math.round(sx / n / 1.4);
  const hz = Math.round(sz / n / 1.4);
  const v = 0.92 + hash2(hx, hz, 91) * 0.10;
  const warm = 0.98 + hash2(hx, hz, 137) * 0.04;
  const col = new THREE.Color(v * warm, v, v * (1.98 - warm));
  const arr = new Float32Array(n * 3);
  // Contact AO measured over a span PROPORTIONAL to the prop's own height. The
  // old clamp to 0.55 m put a hard horizontal tone step across the middle of a
  // 2.5 m haystack instead of a falloff at its base.
  const span = Math.max(0.26, (maxY - minY) * 0.30);
  for (let i = 0; i < n; i++) {
    const t = (pos.getY(i) - minY) / span;
    const f = 1 - 0.46 * (1 - smoothstep(0, 1, t));
    arr[i * 3] = col.r * f;
    arr[i * 3 + 1] = col.g * f;
    arr[i * 3 + 2] = col.b * f;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

function rotate90(v: THREE.Vector3, quarter: number): THREE.Vector3 {
  const q = ((quarter % 4) + 4) % 4;
  let { x, z } = v;
  for (let i = 0; i < q; i++) {
    const nx = -z;
    z = x;
    x = nx;
  }
  return new THREE.Vector3(x, v.y, z);
}

// ------------------------------------------------------------ placement ----

/** House lane x positions, chosen so the shot poses stand in the gaps. */
const NORTH_X = [-56, -24, 12, 46, 80, 114, 148];
const SOUTH_X = [-40, -14, 22, 56, 90, 124, 158];
const LANE = 19;

function villagePlacements(): Placement[] {
  const out: Placement[] = [];
  let salt = 400;
  // North lane: doors face +Z, toward the road.
  for (let i = 0; i < NORTH_X.length; i++) {
    salt += 3;
    const x = NORTH_X[i];
    const z = roadZ(x) - LANE - hash2(salt, 1) * 3.5;
    const kind: BuildingKind = hash2(salt, 4) > 0.7 ? 'house2' : 'house';
    out.push({ kind, x, z, rot: 0, seed: salt * 101 });
    if (i % 2 === 0) {
      out.push({
        kind: 'shed',
        x: x + 6.5 + hash2(salt, 6) * 3,
        z: z - 8.5 - hash2(salt, 7) * 3,
        rot: Math.floor(hash2(salt, 8) * 4),
        seed: salt * 313,
      });
    }
  }
  // South lane: doors face -Z, toward the road. Yards face the north lane.
  for (let i = 0; i < SOUTH_X.length; i++) {
    salt += 3;
    const x = SOUTH_X[i];
    const z = roadZ(x) + LANE + hash2(salt, 1) * 3.5;
    const kind: BuildingKind = hash2(salt, 4) > 0.74 ? 'house2' : 'house';
    out.push({ kind, x, z, rot: 2, seed: salt * 101 });
    if (i % 3 === 1) {
      out.push({
        kind: 'shed',
        x: x - 7 - hash2(salt, 6) * 3,
        z: z + 8 + hash2(salt, 7) * 3,
        rot: Math.floor(hash2(salt, 8) * 4),
        seed: salt * 313,
      });
    }
  }
  // Village centre: the barn that anchors the south side of the street.
  out.push({ kind: 'barn', x: 40, z: roadZ(40) + 27, rot: 2, seed: 7717 });
  out.push({ kind: 'shed', x: 27, z: roadZ(27) + 24, rot: 1, seed: 8123 });
  return out;
}

const FARM_ANCHORS: [number, number][] = [
  [-70, -120], [-150, -290], [300, -20], [440, -130], [-320, 40],
];

function farmPlacements(): Placement[] {
  const out: Placement[] = [];
  let salt = 900;
  for (const [ax, az] of FARM_ANCHORS) {
    salt += 7;
    out.push({ kind: 'barn', x: ax, z: az, rot: Math.floor(hash2(salt, 1) * 4), seed: salt * 71 });
    out.push({
      kind: hash2(salt, 2) > 0.5 ? 'house' : 'shed',
      x: ax + 15 + hash2(salt, 3) * 8,
      z: az + (hash2(salt, 4) - 0.5) * 22,
      rot: Math.floor(hash2(salt, 5) * 4),
      seed: salt * 37,
    });
    out.push({
      kind: 'shed',
      x: ax - 12 - hash2(salt, 6) * 6,
      z: az + 10 + hash2(salt, 7) * 8,
      rot: Math.floor(hash2(salt, 8) * 4),
      seed: salt * 53,
    });
  }
  return out;
}

/** Fence run following the road at a constant perpendicular offset. */
function roadSideFence(sink: PropSink, hf: Heightfield, x0: number, x1: number, side: number, off: number, seed: number): void {
  const steps = Math.max(1, Math.round(Math.abs(x1 - x0) / 18));
  for (let i = 0; i < steps; i++) {
    const ax = x0 + ((x1 - x0) * i) / steps;
    const bx = x0 + ((x1 - x0) * (i + 1)) / steps;
    fenceLine(sink, hf, ax, roadZ(ax) + side * off, bx, roadZ(bx) + side * off, seed + i * 13);
  }
}

/**
 * Ground positions of the review-capture eyepoints. Loose clutter is kept out
 * of a short radius around each: a barrel two metres off the lens reads as a
 * bug, not as set dressing. Buildings and fences are unaffected — they are
 * placed deliberately and are what the poses are pointed at.
 */
const EYEPOINTS: [number, number][] = [
  [-20, 82], [40, 60], [18, 78], [-50, -100], [-90, 108],
  [0, 95], [10, 95], [30, 120], [120, 200], [160, 300],
];

function clearOfEye(x: number, z: number, r = 5): boolean {
  for (const [cx, cz] of EYEPOINTS) {
    if ((x - cx) * (x - cx) + (z - cz) * (z - cz) < r * r) return false;
  }
  return true;
}

function buildProps(hf: Heightfield): PropSink {
  const p = emptyProps();
  const putCrate = (x: number, z: number, s: number, stack = false) => {
    if (clearOfEye(x, z)) crate(p, hf, x, z, s, stack);
  };
  const putBarrel = (x: number, z: number, s: number) => {
    if (clearOfEye(x, z)) barrel(p, hf, x, z, s);
  };
  const putStack = (x: number, z: number, s: number) => {
    if (clearOfEye(x, z, 6.5)) haystack(p, hf, x, z, s);
  };
  const putLogs = (x: number, z: number, s: number) => {
    if (clearOfEye(x, z)) woodPile(p, hf, x, z, s);
  };

  // --- Power line down the coastal road -----------------------------------
  let prev: PoleTop | null = null;
  for (let x = -260; x <= 400; x += 40) {
    const g = roadGrad(x);
    const norm = Math.hypot(1, g);
    // Perpendicular pointing to the north (smaller z) side of the carriageway.
    const ox = (g / norm) * 8.6;
    const oz = (-1 / norm) * 8.6;
    const px = x + ox;
    const pz = roadZ(x) + oz;
    if (!hf.walkable(px, pz) || hf.slope(px, pz) > 0.28) { prev = null; continue; }
    // Crossarm sits across the road.
    const top = powerPole(p, hf, px, pz, g / norm, -1 / norm, 5000 + Math.round(x));
    if (prev) stringWires(p, prev, top);
    prev = top;
  }

  // --- Roadside fencing ----------------------------------------------------
  roadSideFence(p, hf, -130, 34, 1, 10.5, 2100);
  roadSideFence(p, hf, 62, 156, -1, 10.5, 2300);
  roadSideFence(p, hf, 172, 250, 1, 11.0, 2500);

  // --- Village back-yard enclosures (the "village-yard" foreground) --------
  fenceLine(p, hf, 0, 67, 48, 67, 3101);
  fenceLine(p, hf, 48, 67, 48, 74, 3117);
  fenceLine(p, hf, -30, 64, 0, 67, 3131);
  fenceLine(p, hf, 66, 62, 104, 62, 3149);

  // --- Yard walls: a few street-facing plots on each lane ------------------
  for (const x of [46, 114]) {
    const rz = roadZ(x);
    yardWall(p, hf, x, rz - 10.9, 5.6, 4.2, 4000 + x, 0);
  }
  for (const x of [-40, 22, 90]) {
    const rz = roadZ(x);
    yardWall(p, hf, x, rz + 10.9, 5.6, 4.2, 4100 + x, 1);
  }

  // --- The well: village centre, on the north verge ------------------------
  villageWell(p, hf, 30, roadZ(30) - 10.5, 6001);

  // --- Near-field yard dressing keyed to the building poses ----------------
  putStack(2.5, 78.2, 6100);
  putLogs(14.0, 84.4, 6110);
  putCrate(6.0, 81.6, 6120, true);
  putBarrel(7.4, 82.4, 6130);
  putBarrel(8.1, 81.5, 6131);

  putStack(30, 70, 6200);
  putStack(16.5, 64.5, 6210);
  putStack(-12, 71, 6220);
  putLogs(36, 71, 6230);
  putCrate(22, 71.5, 6240, false);
  putCrate(23.4, 72.6, 6241, true);
  putBarrel(44, 69.5, 6250);
  putBarrel(44.7, 70.3, 6251);

  // --- Systematic yard clutter through both lanes --------------------------
  for (let i = 0; i < NORTH_X.length; i++) {
    const x = NORTH_X[i];
    const rz = roadZ(x);
    const s = 6300 + i * 17;
    if (hash2(s, 1) > 0.35) putCrate(x - 4.4, rz - 13.0, s, hash2(s, 2) > 0.55);
    if (hash2(s, 3) > 0.45) putBarrel(x + 3.9, rz - 12.6, s + 1);
    if (hash2(s, 4) > 0.6) putStack(x + 9.5, rz - 25, s + 2);
    if (hash2(s, 5) > 0.55) putLogs(x - 5.5, rz - 24, s + 3);
  }
  for (let i = 0; i < SOUTH_X.length; i++) {
    const x = SOUTH_X[i];
    const rz = roadZ(x);
    const s = 6400 + i * 17;
    if (hash2(s, 1) > 0.3) putCrate(x + 4.2, rz + 13.0, s, hash2(s, 2) > 0.5);
    if (hash2(s, 3) > 0.4) putBarrel(x - 3.6, rz + 12.8, s + 1);
    if (hash2(s, 4) > 0.55) putStack(x - 9.5, rz + 25, s + 2);
  }

  // --- Farm compounds: fenced enclosures, stacks and clutter ---------------
  for (let f = 0; f < FARM_ANCHORS.length; f++) {
    const [ax, az] = FARM_ANCHORS[f];
    if (!hf.walkable(ax, az)) continue;
    const s = 7000 + f * 31;
    const hw = 26 + hash2(s, 1) * 8;
    const hd = 20 + hash2(s, 2) * 8;
    // Perimeter fence with a gap on the south run for the track in.
    fenceLine(p, hf, ax - hw, az - hd, ax + hw, az - hd, s + 3);
    fenceLine(p, hf, ax - hw, az + hd, ax - 6, az + hd, s + 5);
    fenceLine(p, hf, ax + 8, az + hd, ax + hw, az + hd, s + 7);
    fenceLine(p, hf, ax - hw, az - hd, ax - hw, az + hd, s + 9);
    fenceLine(p, hf, ax + hw, az - hd, ax + hw, az + hd, s + 11);
    putStack(ax - 14, az - 9, s + 13);
    putStack(ax - 15.6, az - 12.4, s + 15);
    putStack(ax + 6, az + 13, s + 17);
    putLogs(ax + 12, az - 12, s + 19);
    putCrate(ax + 4.5, az + 6, s + 21, true);
    putCrate(ax + 5.8, az + 7.4, s + 23, false);
    putBarrel(ax - 5, az + 7, s + 25);
    putBarrel(ax - 5.8, az + 7.9, s + 27);
    if (f === 0) villageWell(p, hf, ax + 9, az + 9, s + 29);
  }

  return p;
}

// -------------------------------------------------------------- assembly ----

export function buildSettlements(
  hf: Heightfield,
  factory: TextureFactory,
  physics: PhysicsWorld
): BuiltWorld {
  const placements = [...villagePlacements(), ...farmPlacements()];
  const world: GeoBag = emptyBag();
  const lootSpots: THREE.Vector3[] = [];
  const casters: ShadowCaster[] = [];

  for (const p of placements) {
    // Skip slopes, wet ground and anything that would sit in the carriageway.
    if (!hf.walkable(p.x, p.z) || hf.slope(p.x, p.z) > 0.12) continue;
    if (hf.roadDistance(p.x, p.z) < 11) continue;
    const pieces = generateBuilding(p.kind, p.seed);
    const rotY = (p.rot * Math.PI) / 2;

    // Seat on the LOWEST of the four rotated footprint corners rather than on a
    // single centre sample. A centre sample on a 12 m footprint permits ~0.8 m
    // of corner error, which is why sheds and barns showed daylight and grass
    // under an entire wall run. The surplus is buried by the foundation skirt.
    // Seating footprint is the CORE mass only. Taking the union of every
    // collider let a 2 m lean-to or an external stair reach further onto the
    // slope than the building did, so the corner-spread gate below started
    // rejecting houses that seat perfectly — which emptied two hero poses the
    // moment those secondary volumes were added.
    const fMinX = -pieces.coreHalf.x, fMaxX = pieces.coreHalf.x;
    const fMinZ = -pieces.coreHalf.z, fMaxZ = pieces.coreHalf.z;
    let fMaxY = -Infinity;
    for (const col of pieces.colliders) fMaxY = Math.max(fMaxY, col.max.y);
    if (!isFinite(fMaxY)) { for (const cat of PIECE_CATS) for (const g of pieces[cat]) g.dispose(); continue; }
    const fc = [
      rotate90(new THREE.Vector3(fMinX, 0, fMinZ), p.rot),
      rotate90(new THREE.Vector3(fMaxX, 0, fMinZ), p.rot),
      rotate90(new THREE.Vector3(fMinX, 0, fMaxZ), p.rot),
      rotate90(new THREE.Vector3(fMaxX, 0, fMaxZ), p.rot),
    ];
    let cLo = Infinity;
    let cHi = -Infinity;
    for (const c of fc) {
      const gh = hf.height(p.x + c.x, p.z + c.z);
      cLo = Math.min(cLo, gh);
      cHi = Math.max(cHi, gh);
    }
    // Wide footprints get a tighter slope gate: the skirt can bury 2.6 m, but a
    // building tilted into a bank stops reading as a building.
    if (cHi - cLo > 1.25) {
      for (const cat of PIECE_CATS) for (const g of pieces[cat]) g.dispose();
      continue;
    }
    const y = cLo + 0.02;

    // Ground-shadow caster: world footprint AABB plus the roof height above it.
    {
      let wMinX = Infinity, wMaxX = -Infinity, wMinZ = Infinity, wMaxZ = -Infinity;
      for (const c of fc) {
        wMinX = Math.min(wMinX, c.x); wMaxX = Math.max(wMaxX, c.x);
        wMinZ = Math.min(wMinZ, c.z); wMaxZ = Math.max(wMaxZ, c.z);
      }
      casters.push({
        x: p.x + (wMinX + wMaxX) / 2,
        z: p.z + (wMinZ + wMaxZ) / 2,
        hx: (wMaxX - wMinX) / 2,
        hz: (wMaxZ - wMinZ) / 2,
        h: Math.max(1.5, fMaxY + 0.6),
        k: 0.70,
      });
    }

    const wallCol = paletteTint(p.seed, 41, 0.24, 0.14, 0.80, 1.02);
    const roofCol = paletteTint(p.seed, 61, 0.18, 0.10, 0.82, 1.10);
    const woodCol = paletteTint(p.seed, 81, 0.05, 0.06, 0.82, 0.98);
    const brickCol = paletteTint(p.seed, 91, 0.0, 0.05, 0.74, 0.94);
    const neutral = new THREE.Color(1, 1, 1);
    const catCol: Record<PieceCat, THREE.Color> = {
      plaster: wallCol,
      roof: roofCol,
      wood: woodCol,
      brick: brickCol,
      straw: woodCol,
      glass: neutral,
      intWall: neutral,
      intWood: neutral,
    };
    const catShade: Record<PieceCat, number> = {
      // Glazing takes a shade band too: it grimes at the cill and darkens under
      // the eave, which is what stops a run of panes reading as one repeated
      // decal, and it is the per-instance dirt mask the sheen term multiplies by.
      plaster: 1, roof: 0, wood: 0.7, brick: 0.8, straw: 0.4,
      glass: 0.5, intWall: 0, intWood: 0,
    };

    for (const cat of PIECE_CATS) {
      for (const g of pieces[cat]) {
        const c = g.clone();
        c.rotateY(rotY);
        tintLocal(c, catCol[cat], pieces.eaveY, catShade[cat]);
        c.translate(p.x, y, p.z);
        world[cat].push(c);
      }
      for (const g of pieces[cat]) g.dispose();
    }

    for (const col of pieces.colliders) {
      // Rotate the 4 footprint corners, take min/max (safe for quarter turns).
      const corners = [
        new THREE.Vector3(col.min.x, col.min.y, col.min.z),
        new THREE.Vector3(col.max.x, col.min.y, col.min.z),
        new THREE.Vector3(col.min.x, col.min.y, col.max.z),
        new THREE.Vector3(col.max.x, col.min.y, col.max.z),
      ].map((v) => rotate90(v, p.rot));
      const min = new THREE.Vector3(Infinity, col.min.y, Infinity);
      const max = new THREE.Vector3(-Infinity, col.max.y, -Infinity);
      for (const v of corners) {
        min.x = Math.min(min.x, v.x);
        min.z = Math.min(min.z, v.z);
        max.x = Math.max(max.x, v.x);
        max.z = Math.max(max.z, v.z);
      }
      min.add(new THREE.Vector3(p.x, y, p.z));
      max.add(new THREE.Vector3(p.x, y, p.z));
      physics.addBox(min, max, 'building');
    }
    for (const spot of pieces.lootSpots) {
      lootSpots.push(rotate90(spot, p.rot).add(new THREE.Vector3(p.x, y, p.z)));
    }
  }

  // Props, already in world space, fold into the same merged batches.
  const props = buildProps(hf);
  for (const cat of PIECE_CATS) {
    for (const g of props[cat]) {
      tintProp(g);
      world[cat].push(g);
    }
  }
  for (const c of props.colliders) physics.addBox(c.min, c.max, 'building');
  for (const s of props.shadows) casters.push(s);

  const group = new THREE.Group();
  const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material, shadow: boolean) => {
    if (geos.length === 0) return;
    // Mixed indexed (Box/Cylinder) and non-indexed (Extrude) sources: unify first.
    const prepared = geos.map((g) => (g.index ? g.toNonIndexed() : g));
    const merged = mergeGeometries(prepared, false);
    for (const g of geos) g.dispose();
    for (const g of prepared) g.dispose();
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  const sunL = sunDirectionFor(parseBootParams().timeOfDay);
  const plasterMat = factory.standard(plasterRecipe, { envMapIntensity: 0.72, vertexColors: true });
  const roofMat = factory.standard(roofMetalRecipe, { envMapIntensity: 1.05, vertexColors: true });
  const woodMat = factory.standard(woodPlankRecipe, { envMapIntensity: 0.62, vertexColors: true });
  const brickMat = factory.standard(brickRecipe, { envMapIntensity: 0.58, vertexColors: true });
  const strawMat = factory.standard(strawRecipe, { envMapIntensity: 0.72, vertexColors: true });
  for (const m of [plasterMat, roofMat, woodMat, brickMat, strawMat]) {
    // Metal keeps a little more of its sheen at range than the dielectrics; it
    // is the one surface in the kit whose whole identity is the highlight.
    addShadeFill(m, sunL, m === roofMat ? 0.62 : 0.74);
    // Without this the authored envMapIntensity above is inert: three overwrites
    // it with scene.environmentIntensity for any standard material that has no
    // envMap of its own, so the roof's sheen dial and the glass's sky gradient
    // were both silently pinned at the scene default (see sky.ts skyEnv).
    useSkyEnv(m);
  }

  // Interior shells. UNLIT on purpose: a BackSide plaster shell lit by a 6.0
  // directional key measures the same value as the exterior wall, which is why
  // every aperture read as a rectangle painted on a flat. A basic material
  // cannot brighten, so the opening is always the darkest thing on the facade.
  //
  // The VALUE matters as much as the ordering. The composer runs ACES and then
  // BrightnessContrast at +0.05, i.e. (c - 0.5) * 1.05 + 0.5 on the display
  // value, which clips anything under ~0.024 display to pure black. Scene-linear
  // 0.017 lands at ~0.008 display and was therefore crushed to #000 — which is
  // why every shed doorway and half the barn windows read as cut-out voids with
  // no floor and no falloff rather than as dark rooms. 0.052 clears the clip and
  // measures around 30-40/255 against plaster running 90-200.
  const intWallMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.052, 0.047, 0.040),
    side: THREE.BackSide,
    fog: true,
  });
  // Lighter again: this carries boarded-up panes, reveal liners and interior
  // massing, which have to be legible as objects, not just as void.
  const intWoodMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.098, 0.084, 0.066),
    fog: true,
  });
  // Glazing: a low-roughness dielectric pane. three's PBR already gives the
  // Schlick fresnel ramp at F0 = 0.04, so what this needs is an env map to ramp
  // TO (useSkyEnv) and enough roughness that the ramp is a gradient rather than
  // a mirror — 0.05 made every pane in the village a hard sky-coloured chip.
  const glassMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.034, 0.046, 0.058),
    roughness: 0.11,
    metalness: 0.0,
    // Cranked, because a pane's whole read is the sky it reflects. At 0.58
    // opacity the near-black interior shell behind the glass dominated the
    // blend and every window came out as a flat #000 rectangle with a painted
    // white cross. At 0.80 the pane's own specular carries it and the interior
    // shows through as the darker bottom of the gradient.
    envMapIntensity: 2.4,
    transparent: true,
    opacity: 0.80,
    depthWrite: false,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  useSkyEnv(glassMat);
  addGlassSheen(glassMat);

  const mats: Record<PieceCat, THREE.Material> = {
    plaster: plasterMat, roof: roofMat, wood: woodMat, brick: brickMat,
    straw: strawMat, glass: glassMat, intWall: intWallMat, intWood: intWoodMat,
  };
  // Interior shells and glazing never cast: they live inside a volume the
  // exterior already shadows, and shadow-casting glass would go opaque.
  const casts: Record<PieceCat, boolean> = {
    plaster: true, roof: true, wood: true, brick: true,
    straw: true, glass: false, intWall: false, intWood: false,
  };
  for (const cat of PIECE_CATS) addMerged(world[cat], mats[cat], casts[cat]);

  if (props.wires.length > 0) {
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(props.wires, 3));
    // A 1 px hard-black line stays 1 px wide from 20 m to 400 m, so the distant
    // village used to be overlaid with high-contrast scribble. Fogged and lifted
    // to a mid grey-blue, a far span washes into the haze like everything else,
    // and a near one still reads as a wire against the sky.
    const wires = new THREE.LineSegments(
      wireGeo,
      new THREE.LineBasicMaterial({
        color: new THREE.Color(0.115, 0.125, 0.145),
        transparent: true,
        opacity: 0.62,
        fog: true,
        depthWrite: false,
      })
    );
    wires.frustumCulled = false;
    wires.renderOrder = 3;
    group.add(wires);
  }

  // Ground contact skirts. One merged mesh, one draw call.
  if (!new URLSearchParams(location.search).has('nodecal')) {
    const decals = buildContactDecals(casters, hf);
    if (decals) group.add(decals);
  }
  installSunShadowFit(group);

  return { group, lootSpots };
}

/**
 * Three corrections to the standard shading path, all in one compile hook so the
 * five building materials share a single program.
 *
 * 1. SKY IRRADIANCE, not a grey constant. The previous hemisphere weight was
 *    `fn.y * 0.5 + 0.5`, which is exactly 0.5 for EVERY vertical wall, so the
 *    fill collapsed to mix(gnd, sky, 0.5) = (0.183, 0.183, 0.178): a dead
 *    neutral. Measured consequence on the two-storey house in village-street —
 *    lit plaster 192/255, shaded plaster on the SAME building (64,60,51), i.e.
 *    warm-biased when a white wall in shade under a blue sky has to be blue.
 *    A vertical surface sees a bit over half the sky hemisphere and the sky is
 *    far brighter than dry grass, so the weight is radiance-weighted rather than
 *    geometric: 62% sky at fn.y = 0, ramping to 100% on a horizontal top face.
 *
 * 2. AERIAL PERSPECTIVE. Buildings were on the stock FogExp2 path while the
 *    terrain and the vegetation each add a distance in-scatter on top of it, so
 *    a treeline at 220 m sat fully hazed at (143,141,140) while house walls at
 *    the same depth still carried (165,142,126) and their roofs stayed a
 *    saturated red — chroma spread INCREASING with distance, which reads as a
 *    decal layer floating in front of the island. Same fogColor, same quadratic
 *    extinction form, so land, trees and village now converge on one value.
 *
 * 3. SPECULAR ALIASING. Baked normals mip toward flat while roughness mips
 *    independently, so sub-pixel geometry (fence rails, eave trim, well courses,
 *    crate battens) fringes with single-pixel white specular dots. Widening
 *    roughness toward a floor with distance is the cheap stand-in for Toksvig.
 */
/**
 * Schlick rim on the glazing. three's PBR already gives a dielectric fresnel,
 * but at F0 = 0.04 against a PMREM the head-on reflection of a bright sky is
 * ~4% of a dim environment — well under the level that survives the grade — so
 * every pane in the village came out as a flat near-black rectangle with a
 * hand-painted white muntin cross over it. This adds an explicit horizon-sky
 * term that ramps hard toward grazing incidence, multiplied down by the pane's
 * own vertex-colour dirt mask so the cill end stays grimy.
 */
function addGlassSheen(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPaneSky = { value: new THREE.Color(0.175, 0.225, 0.315) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaneN;\nvarying vec3 vPaneW;')
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nvPaneN = normalize(mat3(modelMatrix) * objectNormal);'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvPaneW = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vPaneN;\nvarying vec3 vPaneW;\nuniform vec3 uPaneSky;'
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        {
          vec3 pv = normalize(cameraPosition - vPaneW);
          float ndv = abs(dot(normalize(vPaneN), pv));
          float fres = pow(1.0 - clamp(ndv, 0.0, 1.0), 4.0);
          float dirt = clamp(vColor.g, 0.35, 1.0);
          gl_FragColor.rgb += uPaneSky * (0.24 + 1.25 * fres) * dirt;
          gl_FragColor.a = clamp(gl_FragColor.a + fres * 0.18, 0.0, 1.0);
        }`
      );
  };
  mat.customProgramCacheKey = () => 'bld-glasssheen-1';
}

function addShadeFill(mat: THREE.MeshStandardMaterial, sunL: THREE.Vector3, roughFar: number): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFillSky = { value: new THREE.Color(0.260, 0.310, 0.440) };
    shader.uniforms.uFillGnd = { value: new THREE.Color(0.135, 0.115, 0.068) };
    shader.uniforms.uSunL = { value: sunL.clone() };
    // Extinction coefficient for the extra in-scatter, quadratic like the
    // terrain's: 1 - exp(-(d*k)^2). At k = 0.0031 a 250 m wall sits ~46% blended
    // before the stock fog adds its own ~16%, and a 450 m one is gone.
    shader.uniforms.uAerial = { value: 0.0031 };
    shader.uniforms.uRoughFar = { value: roughFar };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFillN;\nvarying vec3 vFillW;')
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nvFillN = normalize(mat3(modelMatrix) * objectNormal);'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvFillW = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vFillN;
        varying vec3 vFillW;
        uniform vec3 uFillSky;
        uniform vec3 uFillGnd;
        uniform vec3 uSunL;
        uniform float uAerial;
        uniform float uRoughFar;`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        {
          float dCam = length(vFillW - cameraPosition);
          roughnessFactor = mix(roughnessFactor, max(roughnessFactor, uRoughFar),
                                clamp((dCam - 16.0) / 85.0, 0.0, 1.0));
        }`
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        {
          vec3 fn = normalize(vFillN);
          float up = clamp(0.62 + 0.38 * fn.y, 0.0, 1.0);
          float away = 1.0 - clamp(dot(fn, uSunL), 0.0, 1.0);
          vec3 fill = mix(uFillGnd, uFillSky, up) * (0.38 + 0.62 * away);
          // The floor term matters more than the albedo term: scaling purely by
          // diffuseColor leaves dark materials (weathered plank, rusted drum)
          // below the level where anything survives the grade, which is why a
          // log pile and a barrel measured 2/255 while the plaster beside them
          // read fine. Part albedo-proportional, part flat, so a shaded surface
          // keeps its material identity and still exists.
          gl_FragColor.rgb += (diffuseColor.rgb * 0.58 + 0.145) * fill;
        }`
      )
      .replace(
        '#include <fog_fragment>',
        `#include <fog_fragment>
        #ifdef USE_FOG
        {
          float dAp = length(vFillW - cameraPosition) * uAerial;
          float ap = 1.0 - exp(-dAp * dAp);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(ap, 0.0, 0.88));
        }
        #endif`
      );
  };
  mat.customProgramCacheKey = () => 'bld-shadefill-3';
}
