import * as THREE from 'three';
import { hash2 } from './noise';

// Erangel rural building kit, generated in code. One building = merged
// geometry per material category + axis-aligned colliders + interior loot
// spots. Buildings only rotate in 90-degree steps so every collider stays a
// clean AABB for the lightweight physics.
//
// Categories exist to keep the whole settlement layer inside a handful of draw
// calls: everything a building or a prop emits lands in one of PIECE_CATS and
// world/buildings.ts merges each category into exactly one mesh.

export type BuildingKind = 'house' | 'house2' | 'shed' | 'barn';

export type PieceCat =
  | 'plaster'   // exterior render — walls, gable ends, foundation skirt
  | 'roof'      // corrugated sheet — roof planes, ridge caps, barrels, chimney caps
  | 'wood'      // exterior joinery — frames, sills, doors, fences, poles, crates
  | 'brick'     // chimneys, yard walls, the well ring
  | 'straw'     // haystacks, barn bales
  | 'glass'     // window panes (shared translucent material)
  | 'intWall'   // BackSide interior shells — the darkness you see through windows
  | 'intWood';  // interior joinery — partitions, furniture massing

export const PIECE_CATS: readonly PieceCat[] = [
  'plaster', 'roof', 'wood', 'brick', 'straw', 'glass', 'intWall', 'intWood',
] as const;

export interface Collider {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

export type GeoBag = Record<PieceCat, THREE.BufferGeometry[]>;

export interface BuildingPieces extends GeoBag {
  colliders: Collider[];
  lootSpots: THREE.Vector3[];
  /** Local Y of the wall top (eave line). Drives the vertex-colour AO band. */
  eaveY: number;
  /**
   * Half-extents of the CORE mass, excluding lean-tos, stairs, canopies and
   * firewood. world/buildings.ts seats a building on the lowest of its four
   * footprint corners and rejects anything whose corners disagree by more than
   * 1.25 m; deriving that footprint from the union of every collider meant a
   * 2 m lean-to reached further onto the slope than the house did and started
   * rejecting buildings that were perfectly seatable — which is what emptied
   * two of the five hero poses.
   */
  coreHalf: { x: number; z: number };
}

interface Opening {
  /** Start along the wall run, metres. */
  s: number;
  w: number;
  sill: number;
  top: number;
  door?: boolean;
}

export const WALL_T = 0.24;
/** How far behind the outer wall face glazing and boarding sit. */
export const REVEAL = 0.13;
export const PLASTER_TILE = 2.6;
// 4.6 m puts the plank grid (24 boards / tile) at roughly 0.19 m boards and
// keeps its horizontal course lines off a 2 m shed wall — at 2.2 m the grid's
// three rows banded every wooden wall like brick courses.
export const WOOD_TILE = 4.6;
export const ROOF_TILE = 2.8;
export const BRICK_TILE = 1.8;
export const STRAW_TILE = 2.0;

export function emptyBag(): GeoBag {
  return { plaster: [], roof: [], wood: [], brick: [], straw: [], glass: [], intWall: [], intWood: [] };
}

export function emptyPieces(): BuildingPieces {
  return { ...emptyBag(), colliders: [], lootSpots: [], eaveY: 3, coreHalf: { x: 4, z: 3 } };
}

/**
 * Rescale box UVs so textures tile in metres, not per-face.
 *
 * Derived from local position + normal rather than from BoxGeometry's face
 * ordering: the walls are now tessellated (see `box`), so the old "4 verts per
 * face in a fixed order" assumption no longer holds. Must still be called
 * BEFORE any rotate/translate — it reads object-local coordinates.
 */
export function mapBoxUVs(geo: THREE.BufferGeometry, sx: number, sy: number, sz: number, m: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!pos || !nor || !uv) return;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (nx >= ny && nx >= nz) uv.setXY(i, z / m, y / m);
    else if (ny >= nz) uv.setXY(i, x / m, z / m);
    else uv.setXY(i, x / m, y / m);
  }
  void sx; void sy; void sz;
}

/**
 * Vertical tessellation of anything tall enough to carry a vertex-colour band.
 *
 * tintLocal()'s eave and contact bands are smoothsteps of local Y. On a
 * single-segment box those functions are only ever evaluated at the top and
 * bottom corners, so the GPU interpolates a straight ramp between them and the
 * intended tight bands vanish — which is why every facade read flat. Sampling
 * every ~30 cm restores them. Small members stay at one segment.
 */
export function heightSegments(sy: number): number {
  return sy > 0.85 ? Math.min(14, Math.max(2, Math.ceil(sy / 0.30))) : 1;
}

export function box(sx: number, sy: number, sz: number, x: number, y: number, z: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz, 1, heightSegments(sy), 1);
  mapBoxUVs(g, sx, sy, sz, tile);
  g.translate(x, y, z);
  return g;
}

/**
 * Slides the UV window. Small timber (fence posts, rails, split logs) samples
 * only a sliver of the plank tile, so without an offset every post in the
 * village lands on the identical texel run and the fence reads stamped.
 */
export function offsetUVs(geo: THREE.BufferGeometry, ou: number, ov: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + ou, uv.getY(i) + ov);
}

/** Uniform UV scale — ExtrudeGeometry hands back UVs in metres. */
export function scaleUVs(geo: THREE.BufferGeometry, s: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
}

export function addCollider(out: { colliders: Collider[] }, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
  out.colliders.push({
    min: new THREE.Vector3(cx - sx / 2, cy - sy / 2, cz - sz / 2),
    max: new THREE.Vector3(cx + sx / 2, cy + sy / 2, cz + sz / 2),
  });
}

interface WallSpec {
  cat: 'plaster' | 'wood';
  length: number;
  height: number;
  /** Wall plane X (alongZ) or run start X (along X). */
  ox: number;
  /** Run start Z (alongZ) or wall plane Z (along X). */
  oz: number;
  alongZ: boolean;
  openings: Opening[];
  tile: number;
  /** +1 or -1: which way the outside face points along the wall normal. */
  outward: number;
  seed: number;
  collide?: boolean;
  /** Emit frames, sills, panes and door slabs into wood/glass. */
  trim?: boolean;
}

/**
 * A wall run along local +X (or +Z) with openings. Emits wall segments,
 * matching colliders (below-sill boxes keep windows bullet-permeable but not
 * walkable) and, when `trim` is on, the joinery that makes an opening read as
 * a window or a door rather than a hole.
 */
function wallRun(out: BuildingPieces, s: WallSpec): void {
  const { cat, length, height, ox, oz, alongZ, openings, tile, outward, seed } = s;
  const collide = s.collide !== false;

  // 2D grid subtraction, not a 1D cursor walk.
  //
  // The old version processed openings as a left-to-right sequence and, for each
  // one, emitted a full-height "above the lintel" panel over its width. On a
  // two-storey wall the ground-floor and first-floor windows sit at almost the
  // same distance along the run, so the ground-floor window's above-lintel panel
  // covered the first-floor aperture, and the first-floor window's below-sill
  // panel covered the ground-floor one. Every opening on every two-storey facade
  // was plastered over, which is why they read as rectangles painted on a flat.
  //
  // Cutting on a grid of the openings' own edges cannot do that: a cell is
  // emitted only if its centre is outside every opening. Cells are then merged
  // back into runs along the wall so the box count stays close to what it was.
  const eps = 0.005;
  const xsSet = new Set<number>([0, length]);
  const ysSet = new Set<number>([0, height]);
  for (const o of openings) {
    xsSet.add(Math.max(0, Math.min(length, o.s)));
    xsSet.add(Math.max(0, Math.min(length, o.s + o.w)));
    ysSet.add(Math.max(0, Math.min(height, o.sill)));
    ysSet.add(Math.max(0, Math.min(height, o.top)));
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const segs: { s: number; e: number; y0: number; y1: number }[] = [];
  for (let j = 0; j < ys.length - 1; j++) {
    const y0 = ys[j];
    const y1 = ys[j + 1];
    if (y1 - y0 < 0.02) continue;
    const yc = (y0 + y1) / 2;
    let runStart = -1;
    for (let i = 0; i < xs.length - 1; i++) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const solid =
        x1 - x0 >= 0.02 &&
        !openings.some((o) => yc > o.sill + eps && yc < o.top - eps && (x0 + x1) / 2 > o.s + eps && (x0 + x1) / 2 < o.s + o.w - eps);
      if (solid) {
        if (runStart < 0) runStart = x0;
      } else if (runStart >= 0) {
        segs.push({ s: runStart, e: x0, y0, y1 });
        runStart = -1;
      }
    }
    if (runStart >= 0) segs.push({ s: runStart, e: xs[xs.length - 1], y0, y1 });
  }

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

  if (s.trim === false) return;
  const sorted = [...openings].sort((a, b) => a.s - b.s);
  for (let i = 0; i < sorted.length; i++) openingTrim(out, sorted[i], ox, oz, alongZ, outward, tile, seed, i);
}

/**
 * Frames, sills, muntins, glazing and door slabs for one opening.
 * `du` runs along the wall from the opening centre, `dn` along the wall normal.
 */
function openingTrim(
  out: BuildingPieces,
  o: Opening,
  ox: number,
  oz: number,
  alongZ: boolean,
  outward: number,
  _tile: number,
  seed: number,
  k: number
): void {
  const uC = o.s + o.w / 2;
  const put = (cat: PieceCat, su: number, sy: number, sn: number, du: number, cy: number, dn: number, t: number) => {
    const g = alongZ
      ? box(sn, sy, su, ox + dn, cy, oz + uC + du, t)
      : box(su, sy, sn, ox + uC + du, cy, oz + dn, t);
    out[cat].push(g);
  };

  const hOpen = o.top - o.sill;
  const isDoor = o.door === true;
  // RECESSED frame. The wall is 0.24 m thick, so cutting the aperture already
  // makes a reveal exist geometrically — but sitting the joinery flush in it
  // filled that reveal back in, and every aperture in the set read as a flat
  // quad on the facade plane. The frame is pushed 0.07 m inboard on a 0.19 m
  // depth, which leaves ~0.10 m of bare wall thickness standing proud of it: a
  // real jamb that throws a hard band across the frame under a raking sun.
  const jambT = WALL_T * 0.78;
  const inset = -outward * 0.07;

  // Jambs and head — the frame proper.
  put('wood', 0.10, hOpen + 0.14, jambT, -(o.w / 2 + 0.05), o.sill + hOpen / 2, inset, WOOD_TILE);
  put('wood', 0.10, hOpen + 0.14, jambT, o.w / 2 + 0.05, o.sill + hOpen / 2, inset, WOOD_TILE);
  put('wood', o.w + 0.32, 0.13, jambT, 0, o.top + 0.065, inset, WOOD_TILE);
  // Lintel: a band standing 0.12 m PROUD of the render over the head, so the
  // top of every opening carries its own cast shadow instead of dying into the
  // wall. This is the single cheapest thing that stops a window reading painted.
  put(isDoor ? 'wood' : 'brick', o.w + 0.44, 0.15, WALL_T + 0.14, 0, o.top + 0.20,
    outward * 0.055, isDoor ? WOOD_TILE : BRICK_TILE);
  // Head soffit and side liners: dark surfaces filling the reveal so the opening
  // is already the darkest value on the facade before any cast shadow lands.
  put('intWood', o.w - 0.02, 0.05, 0.12, 0, o.top - 0.03, outward * 0.055, WOOD_TILE);
  for (const s of [-1, 1]) {
    put('intWood', 0.035, hOpen - 0.02, 0.115, s * (o.w / 2 - 0.018), o.sill + hOpen / 2,
      outward * 0.055, WOOD_TILE);
  }

  if (isDoor) {
    // Threshold board, then the slab itself, hinged on the left jamb.
    put('wood', o.w + 0.18, 0.07, WALL_T + 0.14, 0, 0.035, 0, WOOD_TILE);
    // A barn's cart doorway stays open — the whole point of the opening is that
    // the interior shell reads as a room behind it.
    const present = o.w > 2.4 ? 0.0 : hash2(seed, k * 7 + 3);
    if (present > 0.12) {
      const swing = hash2(seed, k * 7 + 4);
      const a = swing > 0.42 ? 0.27 + hash2(seed, k * 7 + 5) * 0.26 : 0.0;
      const theta = (alongZ ? 1 : -1) * outward * a;
      const dw = Math.max(0.5, o.w - 0.12);
      const dh = o.top - 0.08;
      const g = new THREE.BoxGeometry(dw, dh, 0.075);
      mapBoxUVs(g, dw, dh, 0.075, WOOD_TILE);
      g.translate(dw / 2, dh / 2 + 0.06, 0);      // hinge edge at the origin
      g.rotateY(theta);
      if (alongZ) g.rotateY(-Math.PI / 2);
      if (alongZ) g.translate(ox, 0, oz + uC - o.w / 2 + 0.06);
      else g.translate(ox + uC - o.w / 2 + 0.06, 0, oz);
      out.wood.push(g);
      // Handle plate.
      const hx = dw - 0.16;
      const hg = new THREE.BoxGeometry(0.1, 0.1, 0.11);
      mapBoxUVs(hg, 0.1, 0.1, 0.11, WOOD_TILE);
      hg.translate(hx, dh * 0.52, outward * 0.05);
      hg.rotateY(theta);
      if (alongZ) hg.rotateY(-Math.PI / 2);
      if (alongZ) hg.translate(ox, 0, oz + uC - o.w / 2 + 0.06);
      else hg.translate(ox + uC - o.w / 2 + 0.06, 0, oz);
      out.roof.push(hg);
    }
    return;
  }

  // Window sill, proud of the face and shedding outward. Kept shallower than
  // before so it reads as a sill, not as a shelf bolted to a flat wall.
  put('wood', o.w + 0.34, 0.085, WALL_T + 0.20, 0, o.sill - 0.045, outward * 0.05, WOOD_TILE);
  // Cill horn / sub-sill drip, the thing every rain streak starts from.
  put('wood', o.w + 0.20, 0.05, 0.09, 0, o.sill - 0.10, outward * (WALL_T / 2 + 0.05), WOOD_TILE);

  // Everything in the aperture sits BEHIND the outer wall face so the jambs and
  // head throw a real reveal shadow into it — glazing is set back with the
  // recessed frame, and the muntins ride just in front of the glass.
  const dnGlass = -outward * 0.055;
  const dnMunt = -outward * 0.030;

  // Muntins: one vertical, one horizontal — this is what makes a hole read as
  // a window at 40 m.
  put('wood', 0.055, hOpen - 0.04, 0.06, 0, o.sill + hOpen / 2, dnMunt, WOOD_TILE);
  put('wood', o.w - 0.08, 0.05, 0.06, 0, o.sill + hOpen * 0.56, dnMunt, WOOD_TILE);

  const glassR = hash2(seed, k * 7 + 11);
  if (glassR > 0.30) {
    if (glassR < 0.40) {
      // Half the pane gone — the shard that is left clings to the top.
      const ph = hOpen * 0.44;
      put('glass', o.w - 0.09, ph, 0.026, 0, o.top - 0.04 - ph / 2, dnGlass, 1);
    } else if (glassR < 0.47) {
      // One vertical light missing.
      put('glass', (o.w - 0.09) * 0.46, hOpen - 0.06, 0.026, -(o.w - 0.09) * 0.26, o.sill + hOpen / 2, dnGlass, 1);
    } else {
      put('glass', o.w - 0.09, hOpen - 0.06, 0.026, 0, o.sill + hOpen / 2, dnGlass, 1);
    }
  } else if (glassR > 0.12) {
    // Boarded up. Emitted into intWood on purpose: that material is clamped
    // dark and barely takes environment light, so a boarded pane can never
    // measure brighter than the plaster around it.
    const boards = 3;
    for (let b = 0; b < boards; b++) {
      const t = (b + 0.5) / boards;
      const tilt = (hash2(seed, k * 13 + b * 3 + 51) - 0.5) * 0.10;
      const bh = (hOpen / boards) * (0.72 + hash2(seed, k * 13 + b * 3 + 52) * 0.2);
      put('intWood', o.w + 0.10, bh, 0.05,
        (hash2(seed, k * 13 + b * 3 + 53) - 0.5) * 0.10,
        o.sill + hOpen * t + tilt, dnMunt, WOOD_TILE);
    }
  }
  // else: the aperture is left open. The interior shell behind it is an unlit
  // near-black volume, so an empty opening is the darkest thing on the wall.
}

/**
 * Where a wall meets the ground. Three parts, all of them needed:
 * a buried skirt (undulating ground must never show daylight under a wall), a
 * PLINTH course standing 2-3 cm proud so the base of the wall has its own
 * shadow line, and a scatter of rubble that breaks the silhouette where the
 * building enters the grass. The old version used one flat collar ring, which
 * is still a perfectly straight horizontal cut across lit grass — the exact
 * thing that made every structure read as a box resting on a plane.
 */
function groundSkirt(out: BuildingPieces, w: number, d: number, seed: number, buried = 2.6): void {
  out.brick.push(box(w + 0.2, buried, d + 0.2, 0, -buried / 2 + 0.02, 0, BRICK_TILE));
  out.brick.push(box(w + 0.26, 0.34, d + 0.26, 0, 0.10, 0, BRICK_TILE));
  // Rubble: small blocks walked round the perimeter at a jittered offset, yaw
  // and size. 18 of them costs ~430 triangles and buys an irregular contact.
  const N = 18;
  const per = (w + d) * 2;
  for (let i = 0; i < N; i++) {
    const t = ((i + hash2(seed, i * 3 + 401) * 0.85) / N) * per;
    let x: number;
    let z: number;
    let nx = 0;
    let nz = 0;
    if (t < w) { x = -w / 2 + t; z = -d / 2; nz = -1; }
    else if (t < w + d) { x = w / 2; z = -d / 2 + (t - w); nx = 1; }
    else if (t < w * 2 + d) { x = w / 2 - (t - w - d); z = d / 2; nz = 1; }
    else { x = -w / 2; z = d / 2 - (t - w * 2 - d); nx = -1; }
    const out2 = 0.09 + hash2(seed, i * 3 + 402) * 0.32;
    x += nx * out2;
    z += nz * out2;
    const s = 0.16 + hash2(seed, i * 3 + 403) * 0.30;
    const g = new THREE.BoxGeometry(s, s * (0.45 + hash2(seed, i * 3 + 404) * 0.4), s * (0.7 + hash2(seed, i * 3 + 405) * 0.6));
    mapBoxUVs(g, s, s, s, BRICK_TILE);
    offsetUVs(g, hash2(seed, i * 3 + 406), hash2(seed, i * 3 + 407));
    g.rotateY(hash2(seed, i * 3 + 408) * Math.PI);
    g.translate(x, 0.02 + hash2(seed, i * 3 + 409) * 0.05, z);
    out.brick.push(g);
  }
}

/**
 * Lean-to against one gable: 4 posts, a mono-pitch slab and a rail. The kit's
 * loudest failure at range was that three archetypes repeated at an identical
 * roof pitch and an identical single mass, so the cheapest fix is a second
 * volume that changes the outline without changing the building.
 */
function leanTo(out: BuildingPieces, w: number, d: number, wallH: number, seed: number): void {
  const side = hash2(seed, 71) > 0.5 ? 1 : -1;
  const lw = 1.9 + hash2(seed, 72) * 1.3;
  const ld = Math.min(d - 0.6, 2.2 + hash2(seed, 73) * 1.6);
  const lz = (hash2(seed, 74) - 0.5) * (d - ld - 0.4);
  const lh = wallH * (0.52 + hash2(seed, 75) * 0.16);
  const lx = side * (w / 2 + lw / 2);
  for (let i = 0; i < 2; i++) {
    const px = side * (w / 2 + lw - 0.14);
    const pz = lz + (i - 0.5) * (ld - 0.28);
    out.wood.push(box(0.14, lh, 0.14, px, lh / 2, pz, WOOD_TILE));
  }
  // Ledger against the wall, then the slab dropping outward.
  out.wood.push(box(0.10, 0.16, ld, side * (w / 2 + 0.05), lh + 0.34, lz, WOOD_TILE));
  const slab = new THREE.BoxGeometry(lw + 0.34, 0.09, ld + 0.24);
  mapBoxUVs(slab, lw + 0.34, 0.09, ld + 0.24, ROOF_TILE);
  slab.rotateZ(side * 0.235);
  slab.translate(lx, lh + 0.30 - 0.115 * (lw + 0.34) / 2 + 0.06, lz);
  out.roof.push(slab);
  // Back board so the lean-to is not see-through from the yard.
  out.wood.push(box(0.09, lh, ld, side * (w / 2 + lw - 0.05), lh / 2, lz, WOOD_TILE));
  out.colliders.push({
    min: new THREE.Vector3(Math.min(side * (w / 2), lx + lw / 2 * side) - 0.1, 0, lz - ld / 2),
    max: new THREE.Vector3(Math.max(side * (w / 2), lx + lw / 2 * side) + 0.1, lh, lz + ld / 2),
  });
  // Firewood stacked under it — the reason a lean-to exists.
  const rows = 3;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < 4 - Math.floor(r / 2); i++) {
      const g = new THREE.BoxGeometry(lw * 0.8, 0.17, 0.17);
      mapBoxUVs(g, lw * 0.8, 0.17, 0.17, WOOD_TILE);
      offsetUVs(g, hash2(seed, r * 11 + i + 81), hash2(seed, r * 11 + i + 82));
      g.translate(lx, 0.10 + r * 0.185, lz - ld * 0.3 + i * 0.19);
      out.wood.push(g);
    }
  }
}

/** External timber stair to a first-floor door — a two-storey-only silhouette. */
function externalStair(out: BuildingPieces, w: number, d: number, floorH: number, seed: number): void {
  const side = hash2(seed, 91) > 0.5 ? 1 : -1;
  const x = side * (w / 2 + 0.55);
  const z0 = -d / 2 + 0.5;
  const steps = 9;
  const rise = (floorH + 0.25) / steps;
  const going = 0.30;
  for (let i = 0; i < steps; i++) {
    out.wood.push(box(1.0, 0.075, going, x, rise * (i + 1), z0 + going * i, WOOD_TILE));
    if (i % 3 === 0) {
      out.wood.push(box(0.10, rise * (i + 1), 0.10, x + side * 0.42, rise * (i + 1) / 2, z0 + going * i, WOOD_TILE));
    }
  }
  // Landing and handrail.
  out.wood.push(box(1.1, 0.09, 0.95, x, floorH + 0.28, z0 + going * steps + 0.4, WOOD_TILE));
  const rail = new THREE.BoxGeometry(0.07, 0.07, going * steps + 0.9);
  mapBoxUVs(rail, 0.07, 0.07, going * steps + 0.9, WOOD_TILE);
  rail.rotateX(-Math.atan2(rise * steps, going * steps) * 0.55);
  rail.translate(x + side * 0.44, floorH * 0.62, z0 + going * steps * 0.5 + 0.2);
  out.wood.push(rail);
  out.colliders.push({
    min: new THREE.Vector3(Math.min(x - 0.55, x + 0.55), 0, z0 - 0.2),
    max: new THREE.Vector3(Math.max(x - 0.55, x + 0.55), floorH + 0.4, z0 + going * steps + 0.9),
  });
}

interface RoofSpec {
  w: number;
  d: number;
  wallH: number;
  pitch: number;
  overhang: number;
  chimney?: boolean;
  seed: number;
}

function gableRoof(out: BuildingPieces, spec: RoofSpec): void {
  const { w, d, wallH, pitch, overhang, seed } = spec;
  const halfW = w / 2 + overhang;
  const slope = Math.hypot(halfW, pitch);
  const ang = Math.atan2(pitch, halfW);
  const t = 0.1;
  const runD = d + overhang * 2;

  for (const side of [-1, 1]) {
    const g = new THREE.BoxGeometry(slope, t, runD);
    mapBoxUVs(g as THREE.BoxGeometry, slope, t, runD, ROOF_TILE);
    // -side*ang: inner end lands on the ridge, outer end on the eave.
    g.rotateZ(-side * ang);
    g.translate(side * halfW * 0.5, wallH + pitch / 2 + t / 2, 0);
    out.roof.push(g);
  }

  // Ridge cap: a wider capping band straddling the apex.
  out.roof.push(box(0.5, 0.17, runD + 0.05, 0, wallH + pitch + 0.03, 0, ROOF_TILE));

  // Eave fascia boards, hung off the roof edge.
  for (const side of [-1, 1]) {
    out.wood.push(box(0.09, 0.24, runD, side * (halfW + 0.045), wallH - 0.10, 0, WOOD_TILE));
  }
  // Gable barge boards along the sloping edges.
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      const g = new THREE.BoxGeometry(slope, 0.17, 0.09);
      mapBoxUVs(g, slope, 0.17, 0.09, WOOD_TILE);
      g.rotateZ(-side * ang);
      g.translate(side * halfW * 0.5, wallH + pitch / 2 - 0.10, end * (d / 2 + overhang + 0.045));
      out.wood.push(g);
    }
  }

  // Gable end triangles (thin prisms via extrude).
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, pitch);
  shape.closePath();
  for (const side of [-1, 1]) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: WALL_T, bevelEnabled: false });
    scaleUVs(g, 1 / PLASTER_TILE);
    g.translate(0, wallH, side * (d / 2) - WALL_T / 2);
    out.plaster.push(g);
  }

  if (spec.chimney) {
    const cx = (hash2(seed, 21) - 0.5) * w * 0.44;
    const cz = (hash2(seed, 22) - 0.5) * d * 0.34;
    const roofY = wallH + pitch * (1 - Math.abs(cx) / halfW);
    const chH = 1.05 + hash2(seed, 23) * 0.75;
    const base = wallH - 0.7;
    const topY = roofY + chH;
    out.brick.push(box(0.74, topY - base, 0.64, cx, (base + topY) / 2, cz, BRICK_TILE));
    out.roof.push(box(0.92, 0.11, 0.82, cx, topY + 0.055, cz, ROOF_TILE));
    // Flue lip so the cap does not read as a floating slab.
    out.brick.push(box(0.84, 0.12, 0.74, cx, topY - 0.06, cz, BRICK_TILE));
    // Lead flashing skirt where the stack passes through the roof plane. The
    // bare box-through-plane intersection is one of the loudest "untextured
    // primitive" tells at 15 m.
    out.roof.push(box(1.02, 0.045, 0.92, cx, roofY + 0.075, cz, ROOF_TILE));
    out.roof.push(box(0.88, 0.22, 0.78, cx, roofY + 0.20, cz, ROOF_TILE));
  }

  // --- silhouette pass: gutter, downpipe, ridge fittings ---------------------
  // At battle-royale read range the outline carries most of the recognition, and
  // an unbroken extruded box carries none. Everything here merges into the
  // existing category meshes, so it costs geometry and no draw calls.
  const gutterZ = d / 2 + overhang - 0.06;
  for (const side of [-1, 1]) {
    out.roof.push(box(0.115, 0.10, runD - 0.12, side * (halfW + 0.055), wallH - 0.235, 0, ROOF_TILE));
  }
  // One downpipe per gable end, run down the WALL face (not out at the eave
  // line, which would leave it hanging in mid-air a whole overhang away).
  const dpSide = hash2(seed, 33) > 0.5 ? 1 : -1;
  const dpX = dpSide * (w / 2 + 0.06);
  const dpZ = (hash2(seed, 34) > 0.5 ? 1 : -1) * (d / 2 - 0.35);
  const dpH = wallH - 0.28;
  out.roof.push(box(0.085, dpH, 0.085, dpX, dpH / 2 + 0.05, dpZ, ROOF_TILE));
  // Swan neck from the gutter at the eave back to the pipe head.
  out.roof.push(box(overhang + 0.16, 0.085, 0.085, dpSide * (w / 2 + overhang / 2), wallH - 0.22, dpZ, ROOF_TILE));
  for (const by of [0.42, 0.86]) {
    out.roof.push(box(0.13, 0.05, 0.13, dpSide * (w / 2 + 0.03), dpH * by, dpZ, ROOF_TILE));
  }
  // Shoe at the bottom, kicking the run away from the plinth.
  out.roof.push(box(0.10, 0.16, 0.24, dpX, 0.14, dpZ + 0.08, ROOF_TILE));
  void gutterZ;

  // A ridge fitting on most houses: stovepipe, aerial mast or a vent hood.
  const acc = hash2(seed, 35);
  const ax = (hash2(seed, 36) - 0.5) * w * 0.5;
  if (acc > 0.62) {
    // Stovepipe with a rain cap.
    const ph = 0.75 + hash2(seed, 37) * 0.5;
    out.roof.push(box(0.16, ph, 0.16, ax, wallH + pitch + ph / 2, 0.1, ROOF_TILE));
    out.roof.push(box(0.28, 0.05, 0.28, ax, wallH + pitch + ph + 0.07, 0.1, ROOF_TILE));
  } else if (acc > 0.30) {
    // TV aerial: a mast with three elements.
    const mh = 1.15 + hash2(seed, 38) * 0.5;
    out.roof.push(box(0.055, mh, 0.055, ax, wallH + pitch + mh / 2, 0, ROOF_TILE));
    for (let i = 0; i < 3; i++) {
      out.roof.push(box(0.045, 0.035, 0.62 - i * 0.11, ax, wallH + pitch + mh - 0.12 - i * 0.19, 0, ROOF_TILE));
    }
  } else {
    // Ridge vent hood.
    out.roof.push(box(0.34, 0.20, 0.34, ax, wallH + pitch + 0.14, 0, ROOF_TILE));
  }

  // Roof volume collider (stops bullets/players at roof plane, approximate).
  out.colliders.push({
    min: new THREE.Vector3(-w / 2, wallH + pitch * 0.35, -d / 2),
    max: new THREE.Vector3(w / 2, wallH + pitch * 0.75, d / 2),
  });
}

/**
 * Interior shell: a BackSide box inset just inside the wall faces. Seen from
 * outside only its far faces draw, so every window shows a dark room instead of
 * open sky; seen from inside, all six faces draw as dark walls, ceiling, floor.
 */
function interiorShell(out: BuildingPieces, w: number, d: number, y0: number, y1: number, tile: number): void {
  const iw = w - WALL_T - 0.02;
  const id = d - WALL_T - 0.02;
  const ih = y1 - y0;
  if (iw <= 0.2 || id <= 0.2 || ih <= 0.2) return;
  const g = new THREE.BoxGeometry(iw, ih, id);
  mapBoxUVs(g, iw, ih, id, tile);
  g.translate(0, y0 + ih / 2, 0);
  out.intWall.push(g);
}

/** Table / bed / shelf massing so a room is not void through a window. */
function furnish(out: BuildingPieces, w: number, d: number, floorY: number, seed: number): void {
  const r = (k: number) => hash2(seed, k);

  // Trestle table.
  const tx = -w * 0.24 + (r(51) - 0.5) * 0.8;
  const tz = (r(52) - 0.5) * d * 0.35;
  out.intWood.push(box(1.45, 0.09, 0.86, tx, floorY + 0.78, tz, WOOD_TILE));
  out.intWood.push(box(0.1, 0.72, 0.72, tx - 0.6, floorY + 0.37, tz, WOOD_TILE));
  out.intWood.push(box(0.1, 0.72, 0.72, tx + 0.6, floorY + 0.37, tz, WOOD_TILE));
  addCollider(out, tx, floorY + 0.4, tz, 1.45, 0.8, 0.86);

  // Bed pushed against the far wall.
  const bx = w * 0.26;
  const bz = -d / 2 + 1.2;
  out.intWood.push(box(1.05, 0.34, 2.0, bx, floorY + 0.17, bz, WOOD_TILE));
  out.intWood.push(box(0.98, 0.2, 1.9, bx, floorY + 0.44, bz, WOOD_TILE));
  addCollider(out, bx, floorY + 0.27, bz, 1.05, 0.55, 2.0);

  // Shelf unit.
  const sx = w * 0.34;
  const sz = d * 0.3;
  out.intWood.push(box(0.34, 1.65, 1.05, sx, floorY + 0.82, sz, WOOD_TILE));
  out.intWood.push(box(0.42, 0.05, 1.12, sx, floorY + 1.15, sz, WOOD_TILE));
  out.intWood.push(box(0.42, 0.05, 1.12, sx, floorY + 0.6, sz, WOOD_TILE));

  // A crate or two on the floor.
  if (r(53) > 0.4) {
    const cx = (r(54) - 0.5) * w * 0.4;
    const cz = d * 0.26;
    out.intWood.push(box(0.62, 0.6, 0.62, cx, floorY + 0.3, cz, WOOD_TILE));
  }
}

/** One internal partition with a doorway gap, running across the depth. */
function partition(out: BuildingPieces, w: number, d: number, floorY: number, height: number, seed: number): void {
  const px = (hash2(seed, 61) - 0.5) * w * 0.22 - w * 0.02;
  const inner = d / 2 - WALL_T / 2;
  const gapC = (hash2(seed, 62) - 0.5) * d * 0.4;
  const gapH = 0.55;
  const runs: [number, number][] = [
    [-inner, gapC - gapH],
    [gapC + gapH, inner],
  ];
  for (const [z0, z1] of runs) {
    const len = z1 - z0;
    if (len < 0.3) continue;
    out.intWood.push(box(0.16, height, len, px, floorY + height / 2, (z0 + z1) / 2, WOOD_TILE));
    addCollider(out, px, floorY + height / 2, (z0 + z1) / 2, 0.16, height, len);
  }
}

/** Builds one building in LOCAL space (origin at floor centre). */
export function generateBuilding(kind: BuildingKind, seed: number): BuildingPieces {
  const out = emptyPieces();
  const r = (k: number) => hash2(seed, k);

  if (kind === 'shed') {
    const w = 3 + r(1) * 1.6;
    const d = 2.4 + r(2) * 1.2;
    const h = 2.15;
    out.eaveY = h;
    out.coreHalf = { x: w / 2, z: d / 2 };
    const door: Opening = { s: w / 2 - 0.55, w: 1.1, sill: 0, top: 1.95, door: true };
    const sideWin: Opening[] = r(9) > 0.45 ? [{ s: d / 2 - 0.45, w: 0.75, sill: 1.1, top: 1.75 }] : [];
    // A shed used to present a completely blank plank rectangle on three of its
    // four faces, so from most angles it read as an untextured grey box. Every
    // face now carries at least one aperture or vent slot.
    const backWin: Opening[] = r(41) > 0.35
      ? [{ s: w * (0.24 + r(42) * 0.4), w: 0.62 + r(43) * 0.24, sill: 1.24, top: 1.86 }]
      : [];
    const sideB: Opening[] = [{ s: d * 0.32, w: 0.44, sill: 1.62, top: 1.86 }];
    wallRun(out, { cat: 'wood', length: w, height: h, ox: -w / 2, oz: -d / 2, alongZ: false, openings: backWin, tile: WOOD_TILE, outward: -1, seed: seed + 11 });
    wallRun(out, { cat: 'wood', length: w, height: h, ox: -w / 2, oz: d / 2, alongZ: false, openings: [door], tile: WOOD_TILE, outward: 1, seed });
    wallRun(out, { cat: 'wood', length: d, height: h, ox: -w / 2, oz: -d / 2, alongZ: true, openings: sideWin, tile: WOOD_TILE, outward: -1, seed });
    wallRun(out, { cat: 'wood', length: d, height: h, ox: w / 2, oz: -d / 2, alongZ: true, openings: sideB, tile: WOOD_TILE, outward: 1, seed: seed + 13 });
    interiorShell(out, w, d, 0.02, h, WOOD_TILE);

    // Mono-pitch lid. The slab is rotated about its own centre and then lifted
    // so its LOW edge lands on the wall head; the previous version rotated a
    // slab that had already been placed, which hinged it open and left a wedge
    // of daylight between the roof underside and the top plate along the whole
    // eave. The wedge itself is now closed with structure.
    const PITCH = 0.2;
    const roofD = d + 0.7;
    const sinP = Math.sin(PITCH);
    const halfRise = (sinP * roofD) / 2;
    const g = new THREE.BoxGeometry(w + 0.6, 0.14, roofD);
    mapBoxUVs(g, w + 0.6, 0.14, roofD, ROOF_TILE);
    g.rotateX(-PITCH);
    g.translate(0, h + 0.07 + halfRise, 0);
    out.roof.push(g);

    // Top plate along both side walls, then the triangular gable fillers that
    // close the wedge. Local Y of the underside at depth z is
    //   yU(z) = h + 0.07 + sinP * (z + roofD/2).
    const yU = (z: number) => h + 0.07 + sinP * (z + roofD / 2);
    out.wood.push(box(w + 0.05, 0.12, WALL_T, 0, h + 0.06, -d / 2, WOOD_TILE));
    out.wood.push(box(w + 0.05, 0.12, WALL_T, 0, h + 0.06, d / 2, WOOD_TILE));
    // High-end wall extension (the +Z side rises the most).
    const wedge = Math.max(0.06, yU(d / 2) - h);
    out.wood.push(box(w, wedge, WALL_T, 0, h + wedge / 2, d / 2, WOOD_TILE));
    // Side trapezoids under the slope.
    for (const s of [-1, 1]) {
      const shape = new THREE.Shape();
      shape.moveTo(-d / 2, 0);
      shape.lineTo(d / 2, 0);
      shape.lineTo(d / 2, yU(d / 2) - h);
      shape.lineTo(-d / 2, yU(-d / 2) - h);
      shape.closePath();
      const tri = new THREE.ExtrudeGeometry(shape, { depth: WALL_T, bevelEnabled: false });
      scaleUVs(tri, 1 / WOOD_TILE);
      // rotateY(-90) maps shape-x to world +Z and the extrude depth to world -X,
      // so the trapezoid keeps the slab's sense instead of mirroring it.
      tri.rotateY(-Math.PI / 2);
      tri.translate(s * (w / 2 - WALL_T / 2) + WALL_T / 2, h, 0);
      out.wood.push(tri);
    }
    // Fascia along both eaves and verge boards down both rakes.
    for (const s of [-1, 1]) {
      const fg = new THREE.BoxGeometry(w + 0.66, 0.20, 0.09);
      mapBoxUVs(fg, w + 0.66, 0.20, 0.09, WOOD_TILE);
      fg.rotateX(-PITCH);
      fg.translate(0, yU(s * roofD / 2) - 0.04, s * (roofD / 2));
      out.wood.push(fg);
    }
    for (const s of [-1, 1]) {
      const vg = new THREE.BoxGeometry(0.08, 0.18, roofD);
      mapBoxUVs(vg, 0.08, 0.18, roofD, WOOD_TILE);
      vg.rotateX(-PITCH);
      vg.translate((s * (w + 0.66)) / 2, h + 0.02 + halfRise, 0);
      out.wood.push(vg);
    }
    out.colliders.push({
      min: new THREE.Vector3(-w / 2, h + 0.02, -d / 2),
      max: new THREE.Vector3(w / 2, h + wedge + 0.2, d / 2),
    });
    out.intWood.push(box(0.7, 0.65, 0.7, -w * 0.22, 0.33, -d * 0.18, WOOD_TILE));
    groundSkirt(out, w, d, seed + 17, 1.7);
    // Firewood against the blank side wall, so a shed is never a featureless
    // box from whichever face the camera happens to see.
    if (r(31) > 0.42) {
      const fs = r(32) > 0.5 ? 1 : -1;
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 3; i++) {
          const g = new THREE.BoxGeometry(0.17, 0.17, d * 0.62);
          mapBoxUVs(g, 0.17, 0.17, d * 0.62, WOOD_TILE);
          offsetUVs(g, hash2(seed, row * 7 + i + 61), hash2(seed, row * 7 + i + 62));
          g.translate(fs * (w / 2 + 0.14 + i * 0.185), 0.10 + row * 0.18, (r(33) - 0.5) * 0.5);
          out.wood.push(g);
        }
      }
    }
    out.lootSpots.push(new THREE.Vector3(0, 0.2, 0));
    return out;
  }

  if (kind === 'barn') {
    const w = 9 + r(1) * 4;
    const d = 6.5 + r(2) * 2;
    const h = 3.3;
    out.eaveY = h;
    out.coreHalf = { x: w / 2, z: d / 2 };
    const bigDoor: Opening = { s: w / 2 - 1.6, w: 3.2, sill: 0, top: 2.9, door: true };
    wallRun(out, { cat: 'wood', length: w, height: h, ox: -w / 2, oz: -d / 2, alongZ: false, openings: [bigDoor], tile: WOOD_TILE, outward: -1, seed });
    wallRun(out, { cat: 'wood', length: w, height: h, ox: -w / 2, oz: d / 2, alongZ: false, openings: [], tile: WOOD_TILE, outward: 1, seed });
    wallRun(out, {
      cat: 'wood', length: d, height: h, ox: -w / 2, oz: -d / 2, alongZ: true,
      openings: [{ s: d / 2 - 0.7, w: 1.4, sill: 0.9, top: 2.2 }], tile: WOOD_TILE, outward: -1, seed,
    });
    wallRun(out, { cat: 'wood', length: d, height: h, ox: w / 2, oz: -d / 2, alongZ: true, openings: [], tile: WOOD_TILE, outward: 1, seed });
    interiorShell(out, w, d, 0.02, h, WOOD_TILE);
    gableRoof(out, { w, d, wallH: h, pitch: 1.6 + r(3) * 0.6, overhang: 0.35, seed });

    // Hayloft platform plus bales, so the interior is not an empty box.
    const loftX = -w / 2 + 2.4;
    out.intWood.push(box(4.4, 0.14, d - WALL_T - 0.1, loftX, 2.05, 0, WOOD_TILE));
    addCollider(out, loftX, 2.05, 0, 4.4, 0.16, d - WALL_T - 0.1);
    for (let i = 0; i < 4; i++) {
      const bx = loftX - 1.4 + (i % 2) * 1.5;
      const bz = -d * 0.22 + Math.floor(i / 2) * 1.5;
      out.straw.push(box(1.2, 0.62, 0.8, bx, 2.44, bz, STRAW_TILE));
    }
    out.straw.push(box(1.3, 0.65, 0.85, w * 0.22, 0.35, -d * 0.2, STRAW_TILE));
    out.straw.push(box(1.3, 0.65, 0.85, w * 0.22, 1.0, -d * 0.16, STRAW_TILE));
    groundSkirt(out, w, d, seed + 23, 1.9);
    // Lean-to on half the barns: a broken silhouette reads as a place, not a box.
    if (r(11) > 0.5) {
      const lw = 2.4 + r(12) * 1.1;
      const lx = w / 2 + lw / 2;
      const lh = h - 0.8;
      for (let i = 0; i < 4; i++) {
        const px = w / 2 + 0.2 + (i % 2) * (lw - 0.4);
        const pz = (Math.floor(i / 2) - 0.5) * (d - 1.2);
        out.wood.push(box(0.16, lh, 0.16, px, lh / 2, pz, WOOD_TILE));
      }
      const slab = new THREE.BoxGeometry(lw + 0.5, 0.1, d);
      mapBoxUVs(slab, lw + 0.5, 0.1, d, ROOF_TILE);
      // -0.26 so the OUTER edge drops; the inner edge lands on the barn wall.
      slab.rotateZ(-0.26);
      slab.translate(lx, lh + 0.15 - 0.257 * ((lw + 0.5) / 2), 0);
      out.roof.push(slab);
      out.straw.push(box(1.2, 0.6, 0.8, lx, 0.3, d * 0.2, STRAW_TILE));
      addCollider(out, lx, lh / 2, 0, lw, lh, d);
    }
    out.lootSpots.push(new THREE.Vector3(-w * 0.25, 0.2, 0), new THREE.Vector3(w * 0.25, 0.2, d * 0.2));
    return out;
  }

  // Houses: plaster, gable roof, windows all round, door on +Z (road side).
  // Proportions, storey height and the window grid all move with the seed: the
  // village used to read as one cottage and one two-storey stamped down a lane.
  const w = 7.2 + r(1) * 4.4;
  const d = 5.2 + r(2) * 2.8;
  const floors = kind === 'house2' ? 2 : 1;
  const floorH = 2.62 + r(21) * 0.34;
  const h = floors * floorH;
  const winW = 0.98 + r(22) * 0.42;
  const winH = 1.05 + r(23) * 0.34;
  out.eaveY = h;
  out.coreHalf = { x: w / 2, z: d / 2 };

  const winsFront: Opening[] = [];
  const winsBack: Opening[] = [];
  const doorS = w * 0.5 - 0.55 + (r(3) - 0.5) * w * 0.3;
  winsFront.push({ s: doorS, w: 1.15, sill: 0, top: 2.12, door: true });
  for (let f = 0; f < floors; f++) {
    const sill = f * floorH + 0.88 + r(30 + f) * 0.16;
    const top = sill + winH;
    let x = 0.75 + r(32 + f) * 0.5;
    while (x < w - 1.7 - winW) {
      if (f > 0 || Math.abs(x - doorS) > 1.6) {
        winsFront.push({ s: x, w: winW, sill, top });
      }
      winsBack.push({ s: x + 0.3, w: winW, sill, top });
      x += 1.9 + winW + r(Math.floor(x * 7)) * 0.8;
    }
  }
  const sideSill = 0.9 + r(35) * 0.15;
  const winsSide: Opening[] = [{ s: d / 2 - winW / 2, w: winW, sill: sideSill, top: sideSill + winH }];
  if (floors === 2) winsSide.push({ s: d / 2 - winW / 2, w: winW, sill: floorH + sideSill, top: floorH + sideSill + winH });

  wallRun(out, { cat: 'plaster', length: w, height: h, ox: -w / 2, oz: d / 2, alongZ: false, openings: winsFront, tile: PLASTER_TILE, outward: 1, seed });
  wallRun(out, { cat: 'plaster', length: w, height: h, ox: -w / 2, oz: -d / 2, alongZ: false, openings: winsBack, tile: PLASTER_TILE, outward: -1, seed: seed + 3 });
  wallRun(out, { cat: 'plaster', length: d, height: h, ox: -w / 2, oz: -d / 2, alongZ: true, openings: winsSide, tile: PLASTER_TILE, outward: -1, seed: seed + 5 });
  wallRun(out, { cat: 'plaster', length: d, height: h, ox: w / 2, oz: -d / 2, alongZ: true, openings: winsSide, tile: PLASTER_TILE, outward: 1, seed: seed + 7 });

  // Floor slab + foundation skirt (hides terrain poking through on slopes).
  // The skirt is brick, not render: on a slope the exposed sliver used to read
  // as a strip of white paper under the wall.
  out.wood.push(box(w, 0.14, d, 0, 0.07, 0, WOOD_TILE));
  // 2.6 m of buried skirt, because the building is seated at the LOWEST of its
  // four footprint corners (world/buildings.ts): the surplus has to be buried,
  // not left hanging as a bowed strip of daylight under the uphill wall.
  groundSkirt(out, w, d, seed + 29, 2.6);

  interiorShell(out, w, d, 0.13, h, PLASTER_TILE);
  partition(out, w, d, 0.14, floorH - 0.2, seed);
  furnish(out, w, d, 0.14, seed);

  if (floors === 2) {
    const upper = box(w, 0.16, d, 0, floorH + 0.08, 0, WOOD_TILE);
    out.wood.push(upper);
    out.colliders.push({
      min: new THREE.Vector3(-w / 2, floorH, -d / 2),
      max: new THREE.Vector3(w / 2, floorH + 0.16, d / 2),
    });
    // Upstairs massing: a bed and a chest.
    out.intWood.push(box(1.05, 0.34, 2.0, -w * 0.25, floorH + 0.33, -d / 2 + 1.25, WOOD_TILE));
    out.intWood.push(box(0.98, 0.2, 1.9, -w * 0.25, floorH + 0.6, -d / 2 + 1.25, WOOD_TILE));
    out.intWood.push(box(1.0, 0.62, 0.6, w * 0.26, floorH + 0.47, d * 0.24, WOOD_TILE));
  }

  gableRoof(out, { w, d, wallH: h, pitch: 1.35 + r(4) * 1.15, overhang: 0.30 + r(24) * 0.26, chimney: true, seed });

  // Door canopy on a third of the houses — another silhouette break, and it
  // gives the entrance a shadow of its own.
  if (r(25) > 0.66) {
    const cw = 1.9;
    out.wood.push(box(cw, 0.09, 0.95, -w / 2 + doorS + 0.55, 2.42, d / 2 + 0.42, WOOD_TILE));
    for (const s of [-1, 1]) {
      out.wood.push(box(0.09, 0.09, 0.9, -w / 2 + doorS + 0.55 + s * (cw / 2 - 0.1), 2.36, d / 2 + 0.42, WOOD_TILE));
    }
  }
  // Secondary volumes. Between them these give a lane of houses four distinct
  // outlines off one base mass, which is what the reference street has and what
  // three repeated archetypes at one roof pitch never will.
  if (r(41) > 0.55) leanTo(out, w, d, h, seed + 61);
  if (floors === 2 && r(42) > 0.5) externalStair(out, w, d, floorH, seed + 67);
  // Firewood stack against a gable on some plots.
  if (r(43) > 0.62) {
    const fs = r(44) > 0.5 ? 1 : -1;
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i < 3; i++) {
        const g = new THREE.BoxGeometry(0.18, 0.18, 1.5);
        mapBoxUVs(g, 0.18, 0.18, 1.5, WOOD_TILE);
        offsetUVs(g, hash2(seed, row * 9 + i + 121), hash2(seed, row * 9 + i + 122));
        g.translate(fs * (w / 2 + 0.18 + i * 0.19), 0.11 + row * 0.19, (r(45) - 0.5) * d * 0.4);
        out.wood.push(g);
      }
    }
  }
  // Wall-mounted conduit run on some houses.
  if (r(26) > 0.55) {
    const cz = (r(27) > 0.5 ? 1 : -1) * (d / 2 + 0.05);
    out.roof.push(box(w * 0.55, 0.055, 0.055, (r(28) - 0.5) * w * 0.25, h - 0.55, cz, ROOF_TILE));
    out.roof.push(box(0.055, 1.1, 0.055, (r(28) - 0.5) * w * 0.25 + w * 0.27, h - 1.1, cz, ROOF_TILE));
  }

  out.lootSpots.push(new THREE.Vector3(-w * 0.28, 0.25, -d * 0.2));
  if (r(9) > 0.5) out.lootSpots.push(new THREE.Vector3(w * 0.3, 0.25, d * 0.22));
  if (floors === 2) out.lootSpots.push(new THREE.Vector3(0, floorH + 0.3, 0));
  return out;
}
