import * as THREE from 'three';

// BUILD-TIME AMBIENT OCCLUSION FOR THE VIEWMODEL RIG.
//
// Cycle 2's weapon had zero contact darkening anywhere two components met: the
// wood-to-metal boundary was a hard 1 px line, the front sight base had no
// shadow under it, the mag well had no cavity, and the support hand's fingers
// laid over the handguard with nothing under them. That single missing band is
// what made a merged, welded object read as loose parts floating near each
// other — it is the difference the reference AKM sells on.
//
// A real hemisphere raytrace against 40k triangles per vertex is far too slow to
// run at boot on this target. This does the same job against a VOXEL OCCUPANCY
// GRID instead: rasterise every triangle into 5 mm cells once, then march a
// short fixed ray bundle out of each vertex and count how many hit solid. Cost
// is O(verts x 45) integer lookups — about a quarter second for the whole rig —
// and the weapon geometry is static and merged, so it is paid once at boot and
// never again at runtime. The result multiplies into the existing vertex-colour
// attribute, which the standard shader already folds into the diffuse term.
//
// Deterministic: the ray bundle is a fixed table, no Math.random anywhere.

const CELL = 0.004;
const PAD = 3;
/** Ray start offset along the normal. Must clear the vertex's OWN cell in every
 *  axis or convex edges self-occlude and the whole gun just goes darker. */
const LIFT = CELL * 2;

/** Fixed cosine-ish hemisphere bundle in tangent space (z = surface normal). */
const BUNDLE: [number, number, number][] = [
  [0, 0, 1],
  [0.62, 0, 0.78],
  [-0.62, 0, 0.78],
  [0, 0.62, 0.78],
  [0, -0.62, 0.78],
  [0.44, 0.44, 0.78],
  [-0.44, 0.44, 0.78],
  [0.44, -0.44, 0.78],
  [-0.44, -0.44, 0.78],
];
/** March distances in metres. Near hits darken hardest (1/r-ish weighting). */
const STEPS = [0.004, 0.008, 0.014, 0.022, 0.034];
const STEP_W = [1.0, 0.72, 0.48, 0.3, 0.16];

class Grid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cells: Uint8Array;
  constructor(
    readonly min: THREE.Vector3,
    readonly max: THREE.Vector3
  ) {
    this.nx = Math.max(1, Math.ceil((max.x - min.x) / CELL) + PAD * 2);
    this.ny = Math.max(1, Math.ceil((max.y - min.y) / CELL) + PAD * 2);
    this.nz = Math.max(1, Math.ceil((max.z - min.z) / CELL) + PAD * 2);
    this.cells = new Uint8Array(this.nx * this.ny * this.nz);
  }
  mark(x: number, y: number, z: number): void {
    const i = Math.floor((x - this.min.x) / CELL) + PAD;
    const j = Math.floor((y - this.min.y) / CELL) + PAD;
    const k = Math.floor((z - this.min.z) / CELL) + PAD;
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return;
    this.cells[(k * this.ny + j) * this.nx + i] = 1;
  }
  solid(x: number, y: number, z: number): boolean {
    const i = Math.floor((x - this.min.x) / CELL) + PAD;
    const j = Math.floor((y - this.min.y) / CELL) + PAD;
    const k = Math.floor((z - this.min.z) / CELL) + PAD;
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return false;
    return this.cells[(k * this.ny + j) * this.nx + i] === 1;
  }
}

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();

function rasterise(grid: Grid, geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const index = geo.getIndex();
  const count = index ? index.count : pos.count;
  for (let f = 0; f < count; f += 3) {
    const a = index ? index.getX(f) : f;
    const b = index ? index.getX(f + 1) : f + 1;
    const c = index ? index.getX(f + 2) : f + 2;
    _p0.fromBufferAttribute(pos, a);
    _p1.fromBufferAttribute(pos, b);
    _p2.fromBufferAttribute(pos, c);
    // Sample density follows the longest edge so a big flat panel is not
    // rasterised as three lonely corner cells.
    const e = Math.max(_p0.distanceTo(_p1), _p1.distanceTo(_p2), _p2.distanceTo(_p0));
    const n = Math.min(6, Math.max(1, Math.ceil(e / (CELL * 0.7))));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const u = i / n;
        const v = j / n;
        const w = 1 - u - v;
        grid.mark(
          _p0.x * w + _p1.x * u + _p2.x * v,
          _p0.y * w + _p1.y * u + _p2.y * v,
          _p0.z * w + _p1.z * u + _p2.z * v
        );
      }
    }
  }
}

/**
 * Bakes cavity AO across a SET of geometries treated as one solid, multiplying
 * the result into each one's vertex-colour attribute in place. Passing the
 * weapon and the hands together is the point: it is the band under the support
 * hand's fingers, and in the seam where the retainer crosses the wood, that
 * makes them read as touching.
 *
 * @param strength 0..1 — how dark a fully enclosed vertex goes (0.45 = 55% cut).
 */
export function bakeVertexAO(geos: THREE.BufferGeometry[], strength = 0.45): void {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const g of geos) {
    g.computeBoundingBox();
    if (!g.boundingBox) continue;
    min.min(g.boundingBox.min);
    max.max(g.boundingBox.max);
  }
  if (!isFinite(min.x)) return;

  const grid = new Grid(min, max);
  for (const g of geos) rasterise(grid, g);

  // A ray contributes its FIRST hit only, so the saturation point is every ray
  // hitting at the nearest step.
  let wTotal = 0;
  for (const d of BUNDLE) wTotal += d[2] * STEP_W[0];

  for (const g of geos) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!col) continue;
    for (let v = 0; v < pos.count; v++) {
      _p0.fromBufferAttribute(pos, v);
      _n.fromBufferAttribute(nor, v);
      if (_n.lengthSq() < 1e-8) continue;
      _n.normalize();
      // Deterministic tangent frame.
      _t.set(0, 0, 1);
      if (Math.abs(_n.z) > 0.9) _t.set(1, 0, 0);
      _b.crossVectors(_n, _t).normalize();
      _t.crossVectors(_b, _n).normalize();

      let occ = 0;
      for (const d of BUNDLE) {
        const dx = _t.x * d[0] + _b.x * d[1] + _n.x * d[2];
        const dy = _t.y * d[0] + _b.y * d[1] + _n.y * d[2];
        const dz = _t.z * d[0] + _b.z * d[1] + _n.z * d[2];
        for (let s = 0; s < STEPS.length; s++) {
          const r = STEPS[s];
          // Start off the surface so a vertex never occludes itself.
          if (
            grid.solid(
              _p0.x + _n.x * LIFT + dx * r,
              _p0.y + _n.y * LIFT + dy * r,
              _p0.z + _n.z * LIFT + dz * r
            )
          ) {
            occ += d[2] * STEP_W[s];
            break; // first hit along a ray shadows the rest of it
          }
        }
      }
      const ao = 1 - (occ / wTotal) * strength;
      col.setXYZ(v, col.getX(v) * ao, col.getY(v) * ao, col.getZ(v) * ao);
    }
    col.needsUpdate = true;
  }
}
