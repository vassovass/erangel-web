import * as THREE from 'three';
import { hash2 } from './noise';
import type { Heightfield } from './terraingen';
import {
  BRICK_TILE, ROOF_TILE, STRAW_TILE, WOOD_TILE, PLASTER_TILE,
  addCollider, box, emptyBag, heightSegments, mapBoxUVs, offsetUVs,
  type Collider, type GeoBag, type PieceCat,
} from './buildinggen';
import type { ShadowCaster } from '../world/bld-shadow';

/**
 * Timber tile for SMALL members. The 2.2 m plank tile puts a whole plank-grid
 * row across a 1.2 m fence post, which reads as courses of masonry rather than
 * one piece of wood; a long tile keeps a post inside a single plank.
 */
const TIMBER_TILE = 5.5;

// Yard and roadside dressing — the props that turn a row of shells into a
// village: stone yard walls, post-and-rail fences, power poles with sagging
// wire, the village well, haystacks, crates and barrels.
//
// Everything here is authored in WORLD space (buildings are authored in local
// space and rotated in 90-degree steps; props are placed once and never
// re-oriented). Every collider is registered as an AABB, so a prop that blocks
// movement is either axis-aligned or has its rotated bounds taken.

export interface PropSink extends GeoBag {
  colliders: Collider[];
  /** Flat xyz pairs for the power-line LineSegments — one shared draw call. */
  wires: number[];
  /** Footprints for the projected ground-shadow pass (world/bld-shadow.ts). */
  shadows: ShadowCaster[];
}

export function emptyProps(): PropSink {
  return { ...emptyBag(), colliders: [], wires: [], shadows: [] };
}

function scaleUVsXY(geo: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

function cylinder(rTop: number, rBot: number, h: number, radial: number, tile: number, openEnded = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, radial, 1, openEnded);
  scaleUVsXY(g, (Math.PI * (rTop + rBot)) / tile, h / tile);
  return g;
}

function cone(r: number, h: number, radial: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, radial, 1, false);
  scaleUVsXY(g, (2 * Math.PI * r) / tile, h / tile);
  return g;
}

/**
 * Paints a vertex colour directly, bypassing world/buildings.ts tintProp (which
 * skips any geometry that already carries one). Used where a prop needs a
 * specific material identity rather than a hashed variation — the creosoted
 * power pole being the whole reason this exists.
 */
function paintGeo(g: THREE.BufferGeometry, r: number, gg: number, b: number, baseY: number, fade: number): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Creosote soaks the bottom of a pole and weathers off up the shaft.
    const t = Math.min(1, Math.max(0, (pos.getY(i) - baseY) / fade));
    const f = 0.72 + 0.28 * t * t;
    arr[i * 3] = r * f;
    arr[i * 3 + 1] = gg * f;
    arr[i * 3 + 2] = b * f;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/**
 * Continuous solid of revolution from a [y, radius] profile, with per-ring
 * radial jitter. Built by hand instead of stacking a CylinderGeometry under a
 * ConeGeometry because that pair leaves a hard tone seam at the shoulder and two
 * independent UV runs — the "faceted plasticine cone" read. Jittering every ring
 * vertex means no ring is a true circle, so the silhouette is irregular the way
 * a real rick is.
 */
function lathe(profile: [number, number][], segs: number, seed: number, tile: number, jitter: number): THREE.BufferGeometry {
  const rings = profile.length;
  const verts: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  // U comes off the WIDEST ring, not each ring's own circumference: derived
  // per-ring it collapses to nothing at the apex and smears the strand texture
  // into a starburst over the whole cap.
  let rMax = 0;
  for (const [, rad] of profile) rMax = Math.max(rMax, rad);
  for (let ri = 0; ri < rings; ri++) {
    const [y, rad] = profile[ri];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const j = 1 + (hash2(seed + ri * 37, i % segs) - 0.5) * jitter;
      const rr = rad * j;
      verts.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
      uvs.push(((i / segs) * 2 * Math.PI * rMax) / tile, y / tile);
    }
  }
  const row = segs + 1;
  for (let ri = 0; ri < rings - 1; ri++) {
    for (let i = 0; i < segs; i++) {
      const a0 = ri * row + i;
      const b0 = a0 + 1;
      const c0 = a0 + row;
      const d0 = c0 + 1;
      idx.push(a0, c0, b0, b0, c0, d0);
    }
  }
  // Bottom fan so the base is closed on a slope.
  const cen = verts.length / 3;
  verts.push(0, profile[0][0], 0);
  uvs.push(0, profile[0][0] / tile);
  for (let i = 0; i < segs; i++) idx.push(cen, i + 1, i);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Box rotated about Y then placed; the caller decides whether it collides. */
function rotBox(
  sink: PropSink, cat: PieceCat,
  sx: number, sy: number, sz: number,
  x: number, y: number, z: number,
  rotY: number, tile: number, jitter = 0
): void {
  const g = new THREE.BoxGeometry(sx, sy, sz, 1, heightSegments(sy), 1);
  mapBoxUVs(g, sx, sy, sz, tile);
  if (jitter !== 0) offsetUVs(g, hash2(jitter, 1), hash2(jitter, 2));
  if (rotY !== 0) g.rotateY(rotY);
  g.translate(x, y, z);
  sink[cat].push(g);
}

// ---------------------------------------------------------------- fences ----

/**
 * Post-and-rail fence between two world points. Posts follow the ground; rails
 * span post to post. Colliders are batched (one AABB per ~4 bays) so a long
 * fence costs the physics loop almost nothing.
 */
export function fenceLine(
  sink: PropSink, hf: Heightfield,
  x0: number, z0: number, x1: number, z1: number,
  seed: number, postH = 1.22
): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 1.5) return;
  const bays = Math.max(1, Math.round(len / 2.45));
  const dirX = (x1 - x0) / len;
  const dirZ = (z1 - z0) / len;
  const rot = Math.atan2(dirX, dirZ);

  const px: number[] = [];
  const pz: number[] = [];
  const py: number[] = [];
  for (let i = 0; i <= bays; i++) {
    const t = i / bays;
    const x = x0 + (x1 - x0) * t;
    const z = z0 + (z1 - z0) * t;
    px.push(x); pz.push(z); py.push(hf.height(x, z));
  }

  for (let i = 0; i <= bays; i++) {
    const roll = hash2(seed, i * 3 + 71);
    if (roll > 0.955) continue;                        // 1 post in ~22 is gone
    // A dead-vertical run of identical posts is the loudest "instanced" tell in
    // the set: height, lean and yaw all move per post, and the odd one leans
    // hard enough to read at 40 m.
    const drunk = roll > 0.88;
    const lean = (hash2(seed, i * 3 + 1) - 0.5) * (drunk ? 0.34 : 0.11);
    const yaw = (hash2(seed, i * 3 + 5) - 0.5) * 0.14;
    const h = postH * (0.88 + hash2(seed, i * 3 + 2) * 0.26);
    const g = new THREE.BoxGeometry(0.14, h + 0.4, 0.14, 1, heightSegments(h + 0.4), 1);
    mapBoxUVs(g, 0.14, h + 0.4, 0.14, TIMBER_TILE);
    offsetUVs(g, hash2(seed, i * 3 + 41), hash2(seed, i * 3 + 42));
    g.rotateZ(lean);
    g.rotateX((hash2(seed, i * 3 + 6) - 0.5) * (drunk ? 0.26 : 0.08));
    g.rotateY(rot + yaw);
    g.translate(px[i], py[i] + h / 2 - 0.2, pz[i]);
    sink.wood.push(g);
    // Chamfered cap so posts do not read as bare sticks.
    rotBox(sink, 'wood', 0.19, 0.06, 0.19, px[i], py[i] + h + 0.02, pz[i], rot + yaw, TIMBER_TILE, seed + i);
    sink.shadows.push({ x: px[i], z: pz[i], hx: 0.10, hz: 0.10, h, round: true, k: 0.58 });
  }

  for (let i = 0; i < bays; i++) {
    if (hash2(seed, i * 5 + 7) > 0.93) continue;   // a bay of rails is down
    const mx = (px[i] + px[i + 1]) / 2;
    const mz = (pz[i] + pz[i + 1]) / 2;
    const my = (py[i] + py[i + 1]) / 2;
    const bay = Math.hypot(px[i + 1] - px[i], pz[i + 1] - pz[i]) + 0.06;
    for (const [rh, sag] of [[0.92, 0.0], [0.5, 0.02]] as [number, number][]) {
      const g = new THREE.BoxGeometry(0.06, 0.12, bay);
      mapBoxUVs(g, 0.06, 0.12, bay, TIMBER_TILE);
      offsetUVs(g, hash2(seed, i * 7 + 61 + rh * 10), hash2(seed, i * 7 + 62));
      g.rotateY(rot);
      g.translate(mx, my + rh - sag, mz);
      sink.wood.push(g);
    }
  }

  // Batched colliders: one AABB per 4 bays.
  for (let i = 0; i < bays; i += 4) {
    const j = Math.min(bays, i + 4);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (let k = i; k <= j; k++) {
      minX = Math.min(minX, px[k]); maxX = Math.max(maxX, px[k]);
      minZ = Math.min(minZ, pz[k]); maxZ = Math.max(maxZ, pz[k]);
      minY = Math.min(minY, py[k]); maxY = Math.max(maxY, py[k]);
    }
    sink.colliders.push({
      min: new THREE.Vector3(minX - 0.14, minY - 0.2, minZ - 0.14),
      max: new THREE.Vector3(maxX + 0.14, maxY + postH, maxZ + 0.14),
    });
  }
  void dirX; void dirZ;
}

// ------------------------------------------------------------ yard walls ----

/**
 * Low brick/stone yard wall around a rectangle, with a gate gap on one side.
 * Axis-aligned by construction, so the four runs are exact AABBs.
 * `gateSide`: 0 = +Z, 1 = -Z, 2 = +X, 3 = -X.
 */
export function yardWall(
  sink: PropSink, hf: Heightfield,
  cx: number, cz: number, halfW: number, halfD: number,
  seed: number, gateSide = 0, height = 0.92
): void {
  const T = 0.34;
  const runs: [number, number, number, number, number][] = [
    // cx, cz, sx, sz, sideId
    [cx, cz + halfD, halfW * 2, T, 0],
    [cx, cz - halfD, halfW * 2, T, 1],
    [cx + halfW, cz, T, halfD * 2, 2],
    [cx - halfW, cz, T, halfD * 2, 3],
  ];
  for (const [rx, rz, sx, sz, side] of runs) {
    const pieces: [number, number, number, number][] = [];
    if (side === gateSide) {
      // Split for a 1.5 m gate, offset a little so it is not dead centre.
      const gap = 1.5;
      const off = (hash2(seed, side + 11) - 0.5) * (sx > sz ? sx : sz) * 0.3;
      if (sx > sz) {
        const half = sx / 2;
        pieces.push([rx - half / 2 - gap / 4 + off / 2, rz, half - gap / 2 + off, sz]);
        pieces.push([rx + half / 2 + gap / 4 + off / 2, rz, half - gap / 2 - off, sz]);
      } else {
        const half = sz / 2;
        pieces.push([rx, rz - half / 2 - gap / 4 + off / 2, sx, half - gap / 2 + off]);
        pieces.push([rx, rz + half / 2 + gap / 4 + off / 2, sx, half - gap / 2 - off]);
      }
    } else {
      pieces.push([rx, rz, sx, sz]);
    }
    for (const [wx, wz, wsx, wsz] of pieces) {
      if (wsx < 0.4 || wsz < 0.4) continue;
      const gy = hf.height(wx, wz);
      const h = height * (0.9 + hash2(seed, Math.round(wx + wz) & 1023) * 0.24);
      // Buried skirt so undulating ground never shows daylight under the wall.
      sink.brick.push(box(wsx, h + 0.7, wsz, wx, gy + h / 2 - 0.35, wz, BRICK_TILE));
      // Rendered coping course.
      sink.plaster.push(box(wsx + 0.1, 0.11, wsz + 0.1, wx, gy + h + 0.055, wz, PLASTER_TILE));
      addCollider(sink, wx, gy + h / 2, wz, wsx, h, wsz);
      sink.shadows.push({ x: wx, z: wz, hx: wsx / 2, hz: wsz / 2, h: h + 0.1, k: 0.66 });
    }
  }
}

// ----------------------------------------------------------- power poles ----

export interface PoleTop {
  x: number;
  y: number;
  z: number;
  /** Crossarm direction (unit, XZ) — wire attach points sit at +/- 0.85 along it. */
  ax: number;
  az: number;
}

export function powerPole(
  sink: PropSink, hf: Heightfield,
  x: number, z: number, armX: number, armZ: number, seed: number
): PoleTop {
  const gy = hf.height(x, z);
  const h = 8.0 + hash2(seed, 1) * 0.7;
  const rot = Math.atan2(armX, armZ);
  // A creosoted pole is nearly black at the butt and weathers to grey up the
  // shaft. Painted directly rather than left to the hashed prop tint, which put
  // it at bone-white — the loudest untextured-primitive tell in the yard set.
  const CREO = [0.30, 0.25, 0.20] as const;
  // Real poles are not plumb. A few degrees of lean, shared by every member so
  // the crossarm goes with it.
  const lean = (hash2(seed, 11) - 0.5) * 0.12;
  const leanAx = hash2(seed, 12) * Math.PI * 2;
  const leanM = new THREE.Matrix4().makeRotationAxis(
    new THREE.Vector3(Math.cos(leanAx), 0, Math.sin(leanAx)), lean
  );
  const put = (sx: number, sy: number, sz: number, dy: number, ox = 0, oz = 0, cat: PieceCat = 'wood') => {
    const g = new THREE.BoxGeometry(sx, sy, sz, 1, heightSegments(sy), 1);
    mapBoxUVs(g, sx, sy, sz, cat === 'wood' ? WOOD_TILE : ROOF_TILE);
    offsetUVs(g, hash2(seed, dy * 13 + 3), hash2(seed, dy * 13 + 4));
    g.rotateY(rot);
    g.translate(ox, dy, oz);
    // Lean about the base.
    g.applyMatrix4(leanM);
    g.translate(x, gy, z);
    if (cat === 'wood') paintGeo(g, CREO[0], CREO[1], CREO[2], gy, h * 0.55);
    sink[cat].push(g);
  };
  // Tapered trunk in three stages so the silhouette narrows and there is no
  // single hard segment ring across it.
  put(0.30, h * 0.38, 0.30, h * 0.19);
  put(0.25, h * 0.34, 0.25, h * 0.38 + h * 0.17);
  put(0.20, h * 0.30, 0.20, h * 0.72 + h * 0.15);
  const armY = h - 0.55;
  put(0.12, 0.14, 1.95, armY);
  put(0.10, 0.12, 1.25, armY - 0.85);
  // Crossarm bolt row + gain plate.
  for (const t of [-0.62, -0.2, 0.2, 0.62]) {
    put(0.055, 0.055, 0.055, armY + 0.09, armX * t * 1.4, armZ * t * 1.4, 'roof');
  }
  put(0.16, 0.20, 0.16, armY + 0.02, 0, 0, 'roof');
  // Diagonal brace.
  const bg = new THREE.BoxGeometry(0.08, 0.08, 1.05);
  mapBoxUVs(bg, 0.08, 0.08, 1.05, WOOD_TILE);
  bg.rotateX(0.72);
  bg.rotateY(rot);
  bg.translate(0, armY - 0.36, 0);
  bg.applyMatrix4(leanM);
  bg.translate(x, gy, z);
  paintGeo(bg, CREO[0], CREO[1], CREO[2], gy, h * 0.55);
  sink.wood.push(bg);
  // Insulators on their pins.
  for (const s of [-1, 1]) {
    put(0.13, 0.17, 0.13, armY + 0.16, armX * 0.85 * s, armZ * 0.85 * s, 'roof');
    put(0.05, 0.10, 0.05, armY + 0.04, armX * 0.85 * s, armZ * 0.85 * s, 'roof');
  }
  // Guy wire down to a stake, on the poles that carry a direction change.
  if (hash2(seed, 21) > 0.55) {
    const ga = hash2(seed, 22) * Math.PI * 2;
    const gx = x + Math.cos(ga) * 2.6;
    const gz = z + Math.sin(ga) * 2.6;
    sink.wires.push(x, gy + h - 1.1, z, gx, hf.height(gx, gz) + 0.1, gz);
    rotBox(sink, 'wood', 0.09, 0.5, 0.09, gx, hf.height(gx, gz) + 0.18, gz, ga, TIMBER_TILE, seed + 33);
  }
  // Mound of turned soil at the butt.
  rotBox(sink, 'brick', 0.72, 0.16, 0.72, x, gy + 0.05, z, hash2(seed, 24) * 1.5, BRICK_TILE, seed + 34);
  addCollider(sink, x, gy + h / 2, z, 0.42, h, 0.42);
  sink.shadows.push({ x, z, hx: 0.30, hz: 0.30, h, round: true, k: 0.55 });
  return { x, y: gy + armY + 0.24, z, ax: armX, az: armZ };
}

/** Catenary spans between consecutive poles, appended to the shared line buffer. */
export function stringWires(sink: PropSink, a: PoleTop, b: PoleTop): void {
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  if (span < 4 || span > 70) return;
  const sag = 0.035 * span + 0.4;
  // 7 segments faceted the catenary into four visible straight runs.
  const STEPS = 14;
  for (const off of [-0.85, 0, 0.85]) {
    const ax = a.x + a.ax * off, az = a.z + a.az * off;
    const bx = b.x + b.ax * off, bz = b.z + b.az * off;
    const ay = off === 0 ? a.y - 0.85 : a.y;
    const by = off === 0 ? b.y - 0.85 : b.y;
    let px = ax, py = ay, pz = az;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const nx = ax + (bx - ax) * t;
      const nz = az + (bz - az) * t;
      const ny = ay + (by - ay) * t - sag * 4 * t * (1 - t);
      sink.wires.push(px, py, pz, nx, ny, nz);
      px = nx; py = ny; pz = nz;
    }
  }
}

// ------------------------------------------------------------------ well ----

/**
 * The well is the closest-read object in the set, so it is built as masonry
 * rather than as a cylinder with a brick sticker UV-wrapped round it: the
 * wrapped version skewed its courses diagonally and changed brick size across
 * the curve. Every height here derives from the one below it, so the posts land
 * on the coping and the windlass hangs under the crossbar instead of floating.
 */
export function villageWell(sink: PropSink, hf: Heightfield, x: number, z: number, seed: number): void {
  const gy = hf.height(x, z);
  const R = 1.04;
  const COURSES = 6;
  const SEGS = 14;
  const courseH = 0.155;
  const ringH = COURSES * courseH;
  const arc = (2 * Math.PI * R) / SEGS;

  // TEXEL DENSITY. Each block is one stone, so the brick tile has to be scaled
  // such that ONE brick cell fills one block: at BRICK_TILE * 9 = 16.2 m a
  // 0.49 x 0.14 m block sampled a quarter of a brick, so half the ring came out
  // solid red and half solid mortar and the well read as an oversized black-and-
  // red chequerboard. The 8 x 28 cell grid over a 0.225 x 0.064 m brick puts one
  // cell on this block at 3.95 m, and offsetUVs picks a different brick per
  // stone so the ring is not one colour either.
  const WELL_TILE = 3.95;
  for (let c = 0; c < COURSES; c++) {
    const half = c % 2 === 0 ? 0 : Math.PI / SEGS;   // alternate-course stagger
    const cy = gy + courseH * (c + 0.5);
    for (let i = 0; i < SEGS; i++) {
      const a = (i / SEGS) * Math.PI * 2 + half;
      const proud = hash2(seed + c * 17, i) * 0.014;    // 0-14 mm per stone
      const wide = 0.94 + hash2(seed + c * 23, i) * 0.12;
      rotBox(sink, 'brick', (arc + 0.016) * wide, courseH - 0.014, 0.20 + proud,
        x + Math.cos(a) * R, cy, z + Math.sin(a) * R, -a, WELL_TILE, seed + c * 31 + i);
    }
  }
  // Dark shaft inside the ring — a well without a black hole is a planter.
  const shaft = cylinder(R - 0.11, R - 0.11, 2.2, SEGS, BRICK_TILE, false);
  shaft.translate(x, gy + ringH - 1.2, z);
  sink.intWall.push(shaft);

  // Coping: even angular steps on the ring, not random offsets.
  const capT = 0.10;
  const capY = gy + ringH + capT / 2;
  for (let i = 0; i < SEGS; i++) {
    const a = (i / SEGS) * Math.PI * 2;
    rotBox(sink, 'brick', arc + 0.04, capT, 0.30, x + Math.cos(a) * R, capY, z + Math.sin(a) * R, -a, WELL_TILE, seed + 400 + i);
  }
  const copingTop = gy + ringH + capT;

  // Frame: posts start ON the coping.
  const rot = hash2(seed, 2) > 0.5 ? Math.PI / 2 : 0;
  const dx = Math.cos(rot), dz = Math.sin(rot);
  const postH = 1.85;
  const postR = R - 0.06;
  for (const s of [-1, 1]) {
    rotBox(sink, 'wood', 0.16, postH, 0.16, x + dx * postR * s, copingTop + postH / 2, z + dz * postR * s, rot, WOOD_TILE, seed + 9 + s);
  }
  const beamY = copingTop + postH;
  const beam = new THREE.BoxGeometry(0.14, 0.14, postR * 2 + 0.34);
  mapBoxUVs(beam, 0.14, 0.14, postR * 2 + 0.34, WOOD_TILE);
  beam.rotateY(rot + Math.PI / 2);
  beam.translate(x, beamY + 0.07, z);
  sink.wood.push(beam);

  // Windlass: fixed 0.34 m BELOW the crossbar, with axle stubs into the posts.
  const drumY = beamY - 0.34;
  const drum = cylinder(0.145, 0.145, postR * 2 - 0.30, 10, WOOD_TILE);
  drum.rotateZ(Math.PI / 2);
  drum.rotateY(rot + Math.PI / 2);
  drum.translate(x, drumY, z);
  sink.wood.push(drum);
  for (const s of [-1, 1]) {
    const stub = cylinder(0.05, 0.05, 0.26, 6, WOOD_TILE);
    stub.rotateZ(Math.PI / 2);
    stub.rotateY(rot + Math.PI / 2);
    stub.translate(x + dx * (postR - 0.09) * s, drumY, z + dz * (postR - 0.09) * s);
    sink.wood.push(stub);
  }
  rotBox(sink, 'wood', 0.06, 0.30, 0.06, x + dx * (postR - 0.02), drumY - 0.15, z + dz * (postR - 0.02), rot, WOOD_TILE, seed + 71);
  // Pitched cap: two slabs built about a ridge at the local origin, then swung
  // into the frame's direction. ROOF_TILE is authored for a 12 m house roof; a
  // 1.5 m canopy on that density resolves as three enormous tiles, so texel
  // density here is driven by the canopy's own footprint.
  const CANOPY_TILE = 0.6;
  const capBase = beamY + 0.20;
  for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(1.05, 0.07, 1.7);
    mapBoxUVs(g, 1.05, 0.07, 1.7, CANOPY_TILE);
    g.rotateZ(-s * 0.62);
    g.translate(s * 0.43, -0.31, 0);
    g.rotateY(rot + Math.PI / 2);
    g.translate(x, capBase + 0.31, z);
    sink.roof.push(g);
  }
  rotBox(sink, 'roof', 0.2, 0.09, 1.75, x, capBase + 0.33, z, rot + Math.PI / 2, CANOPY_TILE);
  // Bucket on the rim.
  rotBox(sink, 'wood', 0.32, 0.34, 0.32, x + dx * 0.70, copingTop + 0.19, z + dz * 0.70, rot + 0.4, WOOD_TILE, seed + 88);
  addCollider(sink, x, gy + ringH / 2, z, 2.3, ringH + 0.3, 2.3);
  sink.shadows.push({ x, z, hx: R + 0.14, hz: R + 0.14, h: capBase + 0.7 - gy, round: true, k: 0.68 });
}

// ------------------------------------------------------------- haystacks ----

/**
 * Three rick profiles, not one cone at three scales. Radial segment count, spin
 * and shoulder ratio all move with the seed so no two stacks in a yard share a
 * silhouette or a texture orientation.
 */
export function haystack(sink: PropSink, hf: Heightfield, x: number, z: number, seed: number): void {
  const gy = hf.height(x, z);
  const variant = Math.floor(hash2(seed, 7) * 3);
  const r = 1.2 + hash2(seed, 1) * 0.55;
  const lean = (hash2(seed, 4) - 0.5) * 0.09;
  const spin = hash2(seed, 5) * Math.PI * 2;
  // 9-12 radial segments on a 1.2-1.75 m solid is where the countable flat
  // facets came from. These merge into the single straw batch, so 22 segments
  // on ~250 triangles is free.
  const segs = 20 + Math.floor(hash2(seed, 8) * 5);

  let profile: [number, number][];
  let bodyTop: number;
  if (variant === 0) {
    // Classic drum under a conical thatch, as ONE continuous profile.
    const bodyH = 1.15 + hash2(seed, 2) * 0.4;
    const capH = 1.1 + hash2(seed, 3) * 0.5;
    bodyTop = bodyH;
    profile = [
      [0, r * 0.97], [bodyH * 0.45, r * 1.02], [bodyH, r * 0.99],
      [bodyH + capH * 0.30, r * 0.80], [bodyH + capH * 0.62, r * 0.52],
      [bodyH + capH * 0.86, r * 0.26], [bodyH + capH, 0.045],
    ];
  } else if (variant === 1) {
    // Squat shouldered dome.
    const h = 2.0 + hash2(seed, 2) * 0.55;
    bodyTop = h * 0.5;
    profile = [
      [0, r * 1.00], [h * 0.22, r * 1.07], [h * 0.46, r * 1.01],
      [h * 0.66, r * 0.83], [h * 0.82, r * 0.57], [h * 0.93, r * 0.30], [h, 0.045],
    ];
  } else {
    // Tall narrow rick under a steep thatch.
    const rr = r * 0.84;
    const h = 2.7 + hash2(seed, 2) * 0.7;
    bodyTop = h * 0.55;
    profile = [
      [0, rr * 0.96], [h * 0.26, rr * 1.02], [h * 0.52, rr * 0.99],
      [h * 0.68, rr * 0.86], [h * 0.82, rr * 0.60], [h * 0.93, rr * 0.31], [h, 0.045],
    ];
  }
  const top = profile[profile.length - 1][0];
  sink.shadows.push({ x, z, hx: r * 0.98, hz: r * 0.98, h: top, round: true, k: 0.68 });

  const body = lathe(profile, segs, seed, STRAW_TILE, 0.16);
  body.rotateY(spin);
  body.rotateZ(lean);
  body.translate(x, gy, z);
  sink.straw.push(body);

  // Centre pole poking out of the crown.
  rotBox(sink, 'wood', 0.09, 0.42, 0.09, x, gy + top + 0.14, z, spin, TIMBER_TILE, seed);

  // Straw wisps at the shoulder and the base. A perfect solid of revolution has
  // a mathematically clean outline, which is the last thing a rick has: these
  // slivers break it and give the base something to sit in.
  for (let i = 0; i < 11; i++) {
    const a = spin + (i / 11) * Math.PI * 2 + hash2(seed, i + 141) * 0.5;
    const atBase = i % 3 !== 0;
    const ry = atBase ? 0.05 + hash2(seed, i + 142) * 0.12 : bodyTop + hash2(seed, i + 143) * 0.35;
    const rad = atBase ? r * (1.0 + hash2(seed, i + 144) * 0.32) : r * (0.90 + hash2(seed, i + 145) * 0.2);
    const len = 0.26 + hash2(seed, i + 146) * 0.30;
    const g = new THREE.BoxGeometry(len, 0.022, 0.055);
    mapBoxUVs(g, len, 0.022, 0.055, STRAW_TILE);
    offsetUVs(g, hash2(seed, i + 147), hash2(seed, i + 148));
    g.rotateZ((hash2(seed, i + 149) - 0.5) * (atBase ? 0.5 : 1.4));
    g.rotateY(-a);
    g.translate(x + Math.cos(a) * rad, gy + ry, z + Math.sin(a) * rad);
    sink.straw.push(g);
  }
  addCollider(sink, x, gy + top * 0.4, z, r * 2, top * 0.85, r * 2);
}

// -------------------------------------------------------- crates, barrels ----

export function crate(sink: PropSink, hf: Heightfield, x: number, z: number, seed: number, stacked = false): void {
  const gy = hf.height(x, z);
  sink.shadows.push({ x, z, hx: 0.46, hz: 0.46, h: stacked ? 1.25 : 0.72, k: 0.62 });
  const s = 0.58 + hash2(seed, 1) * 0.34;
  const rot = hash2(seed, 2) * Math.PI * 2;
  // 3.2 m tile puts roughly five plank widths across a crate face.
  const CT = 3.2;
  if (hash2(seed, 9) > 0.72) {
    // Long chest on a pallet — a second silhouette in the crate family.
    const L = s * 1.9;
    rotBox(sink, 'wood', L, s * 0.62, s * 0.8, x, gy + 0.10 + s * 0.31, z, rot, CT, seed + 201);
    rotBox(sink, 'wood', L + 0.06, 0.07, s * 0.86, x, gy + 0.06, z, rot, TIMBER_TILE, seed + 202);
    rotBox(sink, 'wood', L + 0.06, 0.06, s * 0.86, x, gy + 0.10 + s * 0.62, z, rot, TIMBER_TILE, seed + 203);
    for (const sx of [-1, 1]) {
      rotBox(sink, 'wood', 0.07, s * 0.66, s * 0.85, x + Math.cos(rot) * (L / 2) * sx, gy + 0.10 + s * 0.31, z - Math.sin(rot) * (L / 2) * sx, rot, TIMBER_TILE, seed + 204 + sx);
    }
    addCollider(sink, x, gy + s * 0.35, z, L, s * 0.75, L);
    return;
  }
  rotBox(sink, 'wood', s, s * 0.88, s, x, gy + s * 0.44, z, rot, CT, seed + 91);
  // Corner battens plus top and bottom rails, so a crate does not read as a
  // plain grey cube at 10 m.
  for (const sx of [-1, 1]) {
    rotBox(sink, 'wood', 0.07, s * 0.9, s + 0.05, x + Math.cos(rot) * (s / 2) * sx, gy + s * 0.44, z - Math.sin(rot) * (s / 2) * sx, rot, TIMBER_TILE, seed + sx + 5);
    rotBox(sink, 'wood', s + 0.05, s * 0.9, 0.07, x + Math.sin(rot) * (s / 2) * sx, gy + s * 0.44, z + Math.cos(rot) * (s / 2) * sx, rot, TIMBER_TILE, seed + sx + 15);
  }
  for (const ry of [0.12, 0.74]) {
    rotBox(sink, 'wood', s + 0.06, 0.08, s + 0.06, x, gy + s * 0.88 * ry, z, rot, TIMBER_TILE, seed + Math.round(ry * 100));
  }
  if (stacked) {
    const s2 = s * 0.82;
    const rot2 = rot + (hash2(seed, 4) - 0.5) * 0.8;
    rotBox(sink, 'wood', s2, s2 * 0.88, s2, x + 0.05, gy + s * 0.88 + s2 * 0.44, z - 0.04, rot2, CT, seed + 137);
  }
}

export function barrel(sink: PropSink, hf: Heightfield, x: number, z: number, seed: number): void {
  const gy = hf.height(x, z);
  const h = 0.86 + hash2(seed, 1) * 0.1;
  const r = 0.28;
  const yaw = hash2(seed, 4) * Math.PI * 2;
  sink.shadows.push({ x, z, hx: r, hz: r, h: hash2(seed, 5) > 0.78 ? r * 1.9 : h, round: true, k: 0.60 });
  // 10 radial segments on a 0.28 m drum reads as a decagonal prism at 6 m. 18 is
  // 32 extra triangles into an already-merged batch.
  const SEG = 18;
  if (hash2(seed, 5) > 0.78) {
    // Tipped over: a drum lying on its side reads as clutter, not as inventory.
    const body = cylinder(r * 0.94, r * 0.94, h, SEG, ROOF_TILE);
    body.rotateZ(Math.PI / 2);
    body.rotateY(yaw);
    body.translate(x, gy + r * 0.95, z);
    sink.roof.push(body);
    for (const t of [-0.28, -0.1, 0.12, 0.3]) {
      const hoop = cylinder(r, r, 0.055, SEG, ROOF_TILE, true);
      hoop.rotateZ(Math.PI / 2);
      hoop.rotateY(yaw);
      hoop.translate(x + Math.cos(yaw) * h * t, gy + r * 0.95, z - Math.sin(yaw) * h * t);
      sink.roof.push(hoop);
    }
    return;
  }
  const body = cylinder(r * 0.94, r * 0.94, h, SEG, ROOF_TILE);
  body.rotateY(yaw);
  body.translate(x, gy + h / 2, z);
  sink.roof.push(body);
  // Rolling hoops: three, plus rim beads at both ends, which is what stops a
  // barrel reading as a flat-coloured tube.
  for (const t of [0.16, 0.44, 0.72]) {
    const hoop = cylinder(r, r, 0.065, SEG, ROOF_TILE, true);
    hoop.translate(x, gy + h * t, z);
    sink.roof.push(hoop);
  }
  for (const t of [0.035, 0.965]) {
    const bead = cylinder(r * 1.01, r * 1.01, 0.045, SEG, ROOF_TILE, true);
    bead.translate(x, gy + h * t, z);
    sink.roof.push(bead);
  }
  // Lid rim, so the top is not a bare disc.
  const lid = cylinder(r * 0.88, r * 0.88, 0.05, SEG, ROOF_TILE, true);
  lid.translate(x, gy + h - 0.02, z);
  sink.roof.push(lid);
}

/** A tipped-over log pile / firewood stack — cheap yard filler. */
export function woodPile(sink: PropSink, hf: Heightfield, x: number, z: number, seed: number): void {
  const gy = hf.height(x, z);
  const rot = hash2(seed, 1) * Math.PI;
  const rows = 2 + Math.floor(hash2(seed, 2) * 2);
  for (let r = 0; r < rows; r++) {
    const n = 4 - r;
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * 0.26;
      const g = cylinder(0.12, 0.115, 1.4, 10, 2.6);
      offsetUVs(g, hash2(seed, r * 9 + i + 3), hash2(seed, r * 9 + i + 4));
      g.rotateZ(Math.PI / 2);
      g.rotateY(rot);
      g.translate(x + Math.cos(rot) * off, gy + 0.13 + r * 0.24, z - Math.sin(rot) * off);
      sink.wood.push(g);
    }
  }
  addCollider(sink, x, gy + 0.3, z, 1.6, 0.7, 1.2);
  sink.shadows.push({ x, z, hx: 0.75, hz: 0.6, h: 0.75, k: 0.60 });
}
