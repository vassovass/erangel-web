import * as THREE from 'three';
import { hash2 } from './noise';

// Erangel rural building kit, generated in code. One building = merged
// geometry per material category + axis-aligned colliders + interior loot
// spots. Buildings only rotate in 90-degree steps so every collider stays a
// clean AABB for the lightweight physics.

export type BuildingKind = 'house' | 'house2' | 'shed' | 'barn';

export interface BuildingPieces {
  plaster: THREE.BufferGeometry[];
  roof: THREE.BufferGeometry[];
  wood: THREE.BufferGeometry[];
  colliders: { min: THREE.Vector3; max: THREE.Vector3 }[];
  lootSpots: THREE.Vector3[];
}

interface Opening {
  /** Start along the wall run, metres. */
  s: number;
  w: number;
  sill: number;
  top: number;
}

const WALL_T = 0.24;
const PLASTER_TILE = 2.6;
const WOOD_TILE = 2.2;
const ROOF_TILE = 2.8;

/** Rescale BoxGeometry UVs so textures tile in metres, not per-face. */
function mapBoxUVs(geo: THREE.BoxGeometry, sx: number, sy: number, sz: number, m: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  // BoxGeometry face order: +x -x +y -y +z -z, 4 verts each.
  const scales: [number, number][] = [
    [sz / m, sy / m], [sz / m, sy / m],
    [sx / m, sz / m], [sx / m, sz / m],
    [sx / m, sy / m], [sx / m, sy / m],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = scales[f];
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
}

function box(sx: number, sy: number, sz: number, x: number, y: number, z: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  mapBoxUVs(g, sx, sy, sz, tile);
  g.translate(x, y, z);
  return g;
}

/**
 * A wall run along local +X of given length at offset (ox, oz), with openings.
 * Emits geometry segments and matching colliders (below-sill boxes keep
 * windows bullet-permeable but not walkable). rotZ=true builds along Z instead.
 */
function wallRun(
  out: BuildingPieces,
  cat: 'plaster' | 'wood',
  length: number,
  height: number,
  ox: number,
  oz: number,
  alongZ: boolean,
  openings: Opening[],
  tile: number,
  collide = true
): void {
  const segs: { s: number; e: number; y0: number; y1: number }[] = [];
  // Full-height segments between openings.
  let cursor = 0;
  const sorted = [...openings].sort((a, b) => a.s - b.s);
  for (const o of sorted) {
    if (o.s > cursor) segs.push({ s: cursor, e: o.s, y0: 0, y1: height });
    // Below-sill and lintel pieces.
    if (o.sill > 0.01) segs.push({ s: o.s, e: o.s + o.w, y0: 0, y1: o.sill });
    if (o.top < height - 0.01) segs.push({ s: o.s, e: o.s + o.w, y0: o.top, y1: height });
    cursor = o.s + o.w;
  }
  if (cursor < length - 0.01) segs.push({ s: cursor, e: length, y0: 0, y1: height });

  for (const seg of segs) {
    const len = seg.e - seg.s;
    const h = seg.y1 - seg.y0;
    if (len < 0.02 || h < 0.02) continue;
    const cx = alongZ ? ox : ox + seg.s + len / 2;
    const cz = alongZ ? oz + seg.s + len / 2 : oz;
    const g = alongZ
      ? box(WALL_T, h, len, cx, seg.y0 + h / 2, cz, tile)
      : box(len, h, WALL_T, cx, seg.y0 + h / 2, cz, tile);
    out[cat].push(g);
    if (collide) {
      out.colliders.push({
        min: new THREE.Vector3(
          alongZ ? cx - WALL_T / 2 : cx - len / 2,
          seg.y0,
          alongZ ? cz - len / 2 : cz - WALL_T / 2
        ),
        max: new THREE.Vector3(
          alongZ ? cx + WALL_T / 2 : cx + len / 2,
          seg.y1,
          alongZ ? cz + len / 2 : cz + WALL_T / 2
        ),
      });
    }
  }
}

function gableRoof(out: BuildingPieces, w: number, d: number, wallH: number, pitch: number, overhang: number): void {
  const halfW = w / 2 + overhang;
  const slope = Math.hypot(halfW, pitch);
  const ang = Math.atan2(pitch, halfW);
  const t = 0.1;

  for (const side of [-1, 1]) {
    const g = new THREE.BoxGeometry(slope, t, d + overhang * 2);
    mapBoxUVs(g as THREE.BoxGeometry, slope, t, d + overhang * 2, ROOF_TILE);
    // -side*ang: inner end lands on the ridge, outer end on the eave.
    g.rotateZ(-side * ang);
    g.translate(side * halfW * 0.5, wallH + pitch / 2 + t / 2, 0);
    out.roof.push(g);
  }
  // Gable end triangles (thin prisms via extrude).
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, pitch);
  shape.closePath();
  for (const side of [-1, 1]) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: WALL_T, bevelEnabled: false });
    g.translate(0, wallH, side * (d / 2) - WALL_T / 2);
    out.plaster.push(g);
  }
  // Roof volume collider (stops bullets/players at roof plane, approximate).
  out.colliders.push({
    min: new THREE.Vector3(-w / 2, wallH + pitch * 0.35, -d / 2),
    max: new THREE.Vector3(w / 2, wallH + pitch * 0.75, d / 2),
  });
}

/** Builds one building in LOCAL space (origin at floor centre). */
export function generateBuilding(kind: BuildingKind, seed: number): BuildingPieces {
  const out: BuildingPieces = { plaster: [], roof: [], wood: [], colliders: [], lootSpots: [] };
  const r = (k: number) => hash2(seed, k);

  if (kind === 'shed') {
    const w = 3 + r(1) * 1.6;
    const d = 2.4 + r(2) * 1.2;
    const h = 2.15;
    // Wood shed: three walls + door wall, single-pitch wood roof.
    wallRun(out, 'wood', w, h, -w / 2, -d / 2, false, [], WOOD_TILE);
    wallRun(out, 'wood', w, h, -w / 2, d / 2, false, [{ s: w / 2 - 0.55, w: 1.1, sill: 0, top: 2.0 }], WOOD_TILE);
    wallRun(out, 'wood', d, h, -w / 2, -d / 2, true, [], WOOD_TILE);
    wallRun(out, 'wood', d, h, w / 2, -d / 2, true, [], WOOD_TILE);
    const g = new THREE.BoxGeometry(w + 0.5, 0.08, d + 0.5);
    mapBoxUVs(g, w + 0.5, 0.08, d + 0.5, ROOF_TILE);
    g.rotateX(-0.12);
    g.translate(0, h + 0.12, 0);
    out.roof.push(g);
    out.colliders.push({
      min: new THREE.Vector3(-w / 2, h + 0.02, -d / 2),
      max: new THREE.Vector3(w / 2, h + 0.3, d / 2),
    });
    out.lootSpots.push(new THREE.Vector3(0, 0.2, 0));
    return out;
  }

  if (kind === 'barn') {
    const w = 9 + r(1) * 4;
    const d = 6.5 + r(2) * 2;
    const h = 3.3;
    wallRun(out, 'wood', w, h, -w / 2, -d / 2, false, [{ s: w / 2 - 1.6, w: 3.2, sill: 0, top: 2.9 }], WOOD_TILE);
    wallRun(out, 'wood', w, h, -w / 2, d / 2, false, [], WOOD_TILE);
    wallRun(out, 'wood', d, h, -w / 2, -d / 2, true, [{ s: d / 2 - 0.7, w: 1.4, sill: 0.9, top: 2.2 }], WOOD_TILE);
    wallRun(out, 'wood', d, h, w / 2, -d / 2, true, [], WOOD_TILE);
    gableRoof(out, w, d, h, 1.6 + r(3) * 0.6, 0.35);
    out.lootSpots.push(new THREE.Vector3(-w * 0.25, 0.2, 0), new THREE.Vector3(w * 0.25, 0.2, d * 0.2));
    return out;
  }

  // Houses: plaster, gable roof, windows all round, door on +Z (road side).
  const w = 7.5 + r(1) * 3.5;
  const d = 5.5 + r(2) * 2.2;
  const floors = kind === 'house2' ? 2 : 1;
  const floorH = 2.75;
  const h = floors * floorH;

  const winsFront: Opening[] = [];
  const winsBack: Opening[] = [];
  const doorS = w * 0.5 - 0.55 + (r(3) - 0.5) * w * 0.3;
  winsFront.push({ s: doorS, w: 1.1, sill: 0, top: 2.1 }); // door
  // Windows across both long walls, both floors.
  for (let f = 0; f < floors; f++) {
    const sill = f * floorH + 0.95;
    const top = f * floorH + 2.15;
    let x = 0.9;
    while (x < w - 2.0) {
      if (f > 0 || Math.abs(x - doorS) > 1.6) {
        winsFront.push({ s: x, w: 1.15, sill, top });
      }
      winsBack.push({ s: x + 0.3, w: 1.15, sill, top });
      x += 2.3 + r(Math.floor(x * 7)) * 0.7;
    }
  }
  const winsSide: Opening[] = [{ s: d / 2 - 0.6, w: 1.2, sill: 0.95, top: 2.15 }];

  wallRun(out, 'plaster', w, h, -w / 2, d / 2, false, winsFront, PLASTER_TILE);
  wallRun(out, 'plaster', w, h, -w / 2, -d / 2, false, winsBack, PLASTER_TILE);
  wallRun(out, 'plaster', d, h, -w / 2, -d / 2, true, winsSide, PLASTER_TILE);
  wallRun(out, 'plaster', d, h, w / 2, -d / 2, true, winsSide, PLASTER_TILE);

  // Wall runs above measure from local corner; shift into centred space.
  // (wallRun already places against -w/2 etc; front wall passed oz=+d/2.)

  // Floor slab + foundation skirt (hides terrain poking through on slopes).
  const slab = box(w, 0.14, d, 0, 0.07, 0, WOOD_TILE);
  out.wood.push(slab);
  out.plaster.push(box(w + 0.2, 1.4, d + 0.2, 0, -0.66, 0, PLASTER_TILE));
  if (floors === 2) {
    const upper = box(w, 0.16, d, 0, floorH + 0.08, 0, WOOD_TILE);
    out.wood.push(upper);
    out.colliders.push({
      min: new THREE.Vector3(-w / 2, floorH, -d / 2),
      max: new THREE.Vector3(w / 2, floorH + 0.16, d / 2),
    });
  }

  // Door + window trims (wood) on the front for depth.
  out.wood.push(box(1.3, 0.12, 0.1, -w / 2 + doorS + 0.55, 2.2, d / 2 + 0.08, WOOD_TILE));

  gableRoof(out, w, d, h, 1.7 + r(4) * 0.7, 0.4);

  out.lootSpots.push(new THREE.Vector3(-w * 0.28, 0.25, -d * 0.2));
  if (r(9) > 0.5) out.lootSpots.push(new THREE.Vector3(w * 0.3, 0.25, d * 0.22));
  if (floors === 2) out.lootSpots.push(new THREE.Vector3(0, floorH + 0.3, 0));
  return out;
}
