import * as THREE from 'three';

// Viewmodel geometry toolkit. Everything the gun is built from is a SWEEP:
// a closed 2D profile carried along +Z through a list of stations that may
// scale, offset and shear it. That one primitive covers boxes, bevelled boxes,
// cylinders, tapered receivers, curved magazines, finger-grooved handguards and
// angled muzzle cuts — and, unlike BoxGeometry/CylinderGeometry, it bakes:
//
//   * analytic smooth normals (cross of the two grid tangents, so tapers and
//     shears shade correctly without computeVertexNormals faceting),
//   * WORLD-DENSITY UVs (repeats per metre, u along the part's length) so one
//     baked texture reads at the same scale on a 0.5 m barrel and a 2 cm rivet,
//     with wood grain always running along the part,
//   * per-vertex edge wear from the profile's turn angle, so bevels and rims
//     brighten the way a carried rifle's do.
//
// All parts merge into two draw calls (metal, wood) in vm-akm.ts.

export type Pt = readonly [number, number];

export interface Station {
  z: number;
  /** Profile scale at this station. */
  sx?: number;
  sy?: number;
  /** Profile offset at this station (the sweep's spine). */
  ox?: number;
  oy?: number;
  /** z += (y - shearPivot) * shear. Angled cuts (AKM slant brake). */
  shear?: number;
}

export interface SweepOpts {
  /** [startCap, endCap] or a single flag for both. Default true. */
  caps?: boolean | [boolean, boolean];
  /** Texture repeats per metre along the sweep (grain direction). */
  uPerM?: number;
  /** Texture repeats per metre around the profile. */
  vPerM?: number;
  /** Edge-wear brightening, 0..1 — scales with the profile's turn angle. */
  wear?: number;
  /** Flat vertex-colour multiplier (use < 1 for blackened parts). */
  tint?: number;
  shearPivot?: number;
  /** Reverse winding + normals: bores and other inward-facing shells. */
  flip?: boolean;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _tu = new THREE.Vector3();
const _tz = new THREE.Vector3();
const _n = new THREE.Vector3();

export function sweep(profile: Pt[], stations: Station[], opts: SweepOpts = {}): THREE.BufferGeometry {
  const n = profile.length;
  const m = stations.length;
  const uPerM = opts.uPerM ?? 4;
  const vPerM = opts.vPerM ?? 4;
  const wearAmt = opts.wear ?? 0;
  const tint = opts.tint ?? 1;
  const pivot = opts.shearPivot ?? 0;
  const flip = opts.flip === true;
  const caps: [boolean, boolean] = Array.isArray(opts.caps)
    ? opts.caps
    : [opts.caps !== false, opts.caps !== false];

  // Cumulative perimeter (v) over the base profile.
  const per: number[] = [0];
  for (let i = 1; i <= n; i++) {
    const a = profile[i - 1];
    const b = profile[i % n];
    per.push(per[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }

  // Turn angle per profile point -> edge-wear weight.
  const turn: number[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = profile[(i - 1 + n) % n];
    const p1 = profile[i];
    const p2 = profile[(i + 1) % n];
    const a1 = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
    const a2 = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    let dA = a2 - a1;
    while (dA > Math.PI) dA -= Math.PI * 2;
    while (dA < -Math.PI) dA += Math.PI * 2;
    turn.push(Math.min(1, Math.abs(dA) / 0.6));
  }

  const at = (j: number, i: number, out: THREE.Vector3): THREE.Vector3 => {
    const s = stations[j < 0 ? 0 : j >= m ? m - 1 : j];
    const p = profile[((i % n) + n) % n];
    const x = p[0] * (s.sx ?? 1) + (s.ox ?? 0);
    const y = p[1] * (s.sy ?? 1) + (s.oy ?? 0);
    return out.set(x, y, s.z + (y - pivot) * (s.shear ?? 0));
  };

  // Per-part UV offset. Every part is small enough to cover a fraction of a
  // tile, so without this they all sample the same corner of the texture and
  // any single bright patch there shows up on every part at once. Deterministic
  // hash — no Math.random anywhere in a gen path.
  const seed = Math.abs(
    Math.sin(stations[0].z * 12.9898 + stations[m - 1].z * 37.719 + per[n] * 78.233 + n * 4.1414) * 43758.5453
  );
  const uOff = seed % 1;
  const vOff = (seed * 7.317) % 1;

  const ring = n + 1; // duplicate seam vertex so v does not wrap
  const wallVerts = m * ring;
  const capVerts = (caps[0] ? n + 1 : 0) + (caps[1] ? n + 1 : 0);
  const total = wallVerts + capVerts;

  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const col = new Float32Array(total * 3);
  const idx: number[] = [];

  for (let j = 0; j < m; j++) {
    for (let k = 0; k <= n; k++) {
      const i = k % n;
      const vi = j * ring + k;
      at(j, i, _a);
      at(j, i + 1, _b);
      at(j, i - 1, _c);
      _tu.subVectors(_b, _c);
      at(Math.min(j + 1, m - 1), i, _b);
      at(Math.max(j - 1, 0), i, _d);
      _tz.subVectors(_b, _d);
      _n.crossVectors(_tu, _tz);
      if (_n.lengthSq() < 1e-14) _n.set(0, 0, 1);
      else _n.normalize();
      if (flip) _n.negate();

      pos[vi * 3] = _a.x;
      pos[vi * 3 + 1] = _a.y;
      pos[vi * 3 + 2] = _a.z;
      nor[vi * 3] = _n.x;
      nor[vi * 3 + 1] = _n.y;
      nor[vi * 3 + 2] = _n.z;
      uv[vi * 2] = uOff + stations[j].z * uPerM;
      uv[vi * 2 + 1] = vOff + per[k] * vPerM;
      const w = tint * (1 + wearAmt * turn[i]);
      col[vi * 3] = w;
      col[vi * 3 + 1] = w;
      col[vi * 3 + 2] = w;
    }
  }

  for (let j = 0; j < m - 1; j++) {
    for (let k = 0; k < n; k++) {
      const v00 = j * ring + k;
      const v01 = j * ring + k + 1;
      const v10 = (j + 1) * ring + k;
      const v11 = (j + 1) * ring + k + 1;
      if (flip) {
        idx.push(v00, v11, v01, v00, v10, v11);
      } else {
        idx.push(v00, v01, v11, v00, v11, v10);
      }
    }
  }

  let base = wallVerts;
  // Caps are mapped as a polar fan CONTINUOUS with the wall: v carries the same
  // perimeter coordinate as the adjoining ring, u fans out by radius. Mapping
  // them planar in local space instead (the obvious choice) collapses every cap
  // in the gun onto the same few texels, and one worn patch there turns every
  // flat face into a chrome disc.
  const addCap = (j: number, front: boolean) => {
    // Cap plane normal straight off the ring (survives shear).
    at(j, 0, _a);
    at(j, Math.floor(n / 3), _b);
    at(j, Math.floor((2 * n) / 3), _c);
    _n.crossVectors(_b.sub(_a), _c.sub(_a)).normalize();
    // Orient away from the body. The neighbouring station always lies INTO the
    // solid (j+1 for the start cap, j-1 for the end cap), so the outward normal
    // is simply the one pointing against it — getting this sign wrong on the
    // end caps only shows up as flat, wrongly-lit rear faces, since the walls
    // and start caps still look correct.
    at(j, 0, _a);
    at(front ? j + 1 : j - 1, 0, _b);
    _d.subVectors(_b, _a);
    if (_n.dot(_d) > 0) _n.negate();
    if (flip) _n.negate();

    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      at(j, i, _a);
      cx += _a.x;
      cy += _a.y;
      cz += _a.z;
    }
    const ci = base;
    pos[ci * 3] = cx / n;
    pos[ci * 3 + 1] = cy / n;
    pos[ci * 3 + 2] = cz / n;
    nor[ci * 3] = _n.x;
    nor[ci * 3 + 1] = _n.y;
    nor[ci * 3 + 2] = _n.z;
    uv[ci * 2] = uOff + stations[j].z * uPerM;
    uv[ci * 2 + 1] = vOff + per[n] * 0.5 * vPerM;
    col[ci * 3] = col[ci * 3 + 1] = col[ci * 3 + 2] = tint;
    for (let i = 0; i < n; i++) {
      const vi = base + 1 + i;
      at(j, i, _a);
      pos[vi * 3] = _a.x;
      pos[vi * 3 + 1] = _a.y;
      pos[vi * 3 + 2] = _a.z;
      nor[vi * 3] = _n.x;
      nor[vi * 3 + 1] = _n.y;
      nor[vi * 3 + 2] = _n.z;
      uv[vi * 2] = uOff + stations[j].z * uPerM + Math.hypot(_a.x - cx / n, _a.y - cy / n) * vPerM;
      uv[vi * 2 + 1] = vOff + per[i] * vPerM;
      const w = tint * (1 + wearAmt * 0.8);
      col[vi * 3] = w;
      col[vi * 3 + 1] = w;
      col[vi * 3 + 2] = w;
    }
    for (let i = 0; i < n; i++) {
      const a = base + 1 + i;
      const b = base + 1 + ((i + 1) % n);
      const flipWind = front !== flip;
      if (flipWind) idx.push(ci, b, a);
      else idx.push(ci, a, b);
    }
    base += n + 1;
  };
  if (caps[0]) addCap(0, true);
  if (caps[1]) addCap(m - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

// ---------------------------------------------------------------- profiles

/** CCW rounded rectangle centred on the origin. */
export function roundedRect(w: number, h: number, r: number, seg = 3): Pt[] {
  const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4);
  const hw = w / 2 - rr;
  const hh = h / 2 - rr;
  const centres: Pt[] = [
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
    [-hw, -hh],
  ];
  const pts: Pt[] = [];
  for (let c = 0; c < 4; c++) {
    const a0 = -Math.PI / 2 + (c * Math.PI) / 2;
    for (let s = 0; s <= seg; s++) {
      const a = a0 + (s / seg) * (Math.PI / 2);
      pts.push([centres[c][0] + Math.cos(a) * rr, centres[c][1] + Math.sin(a) * rr]);
    }
  }
  return pts;
}

/** CCW circle. */
export function circleProfile(r: number, seg = 12): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

/** CCW arch: flat bottom at y = -skirt, elliptical top of height h. */
export function archProfile(w: number, h: number, skirt = 0.010, seg = 8): Pt[] {
  const pts: Pt[] = [[w / 2, -skirt]];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI;
    pts.push([Math.cos(a) * (w / 2), Math.sin(a) * h]);
  }
  pts.push([-w / 2, -skirt]);
  return pts;
}

// ---------------------------------------------------------------- transforms

export interface Place {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
}

export function place(geo: THREE.BufferGeometry, p: Place): THREE.BufferGeometry {
  if (p.rx) geo.rotateX(p.rx);
  if (p.ry) geo.rotateY(p.ry);
  if (p.rz) geo.rotateZ(p.rz);
  geo.translate(p.x ?? 0, p.y ?? 0, p.z ?? 0);
  return geo;
}

/** Adds the attributes merge needs to geometry built by three's primitives. */
export function adopt(geo: THREE.BufferGeometry, tint = 1, uvScale = 1): THREE.BufferGeometry {
  const count = geo.getAttribute('position').count;
  if (!geo.getAttribute('uv')) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  } else if (uvScale !== 1) {
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) uv.setXY(i, uv.getX(i) * uvScale, uv.getY(i) * uvScale);
  }
  const col = new Float32Array(count * 3);
  col.fill(tint);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.deleteAttribute('tangent');
  return geo;
}

/** Multiplies existing vertex colours (blackened sights, bore shadow). */
export function tintGeo(geo: THREE.BufferGeometry, mul: number): THREE.BufferGeometry {
  const col = geo.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < col.count; i++) {
    col.setXYZ(i, col.getX(i) * mul, col.getY(i) * mul, col.getZ(i) * mul);
  }
  return geo;
}
