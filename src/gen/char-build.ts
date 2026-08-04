import * as THREE from 'three';
import { hash2 } from './noise';

// Low-level skinned-geometry builder for the character generator.
//
// Everything is authored in BIND WORLD space (the character standing at the
// origin in its rest pose). Skinning is `boneWorld * bindInverse * v`, and the
// bind matrices are pure translations, so bind-world authoring is exact and
// lets any part be bound to any bone.
//
// Two primitives: lofted rings (rounded, tapered limbs/torso/head — smooth
// normals) and boxes (hard-edged gear, pouches, the rifle — flat normals).
// Nothing is welded across parts, so `computeVertexNormals()` smooths within a
// part and keeps every part's silhouette crisp.
//
// Every vertex carries FOUR streams beyond position:
//   color   vec3  baked albedo (palette * baked AO * mottle * camo * dirt)
//   aSurf   vec3  (roughness, metalness, rimWeight) — read by char-shader.ts
//   aAO     float cavity occlusion, applied to the INDIRECT term only
//   skin    2 influences, so a joint band can blend across two bones and the
//           limb-to-torso seam disappears instead of announcing itself.
//
// Plus two CPU-side parallel streams kept on geometry.userData:
//   author  the PRE-xf authoring position. Parts built through a hold-pose
//           transform (the rifle, both hands) land in a bone's bind space where
//           "up" is not up, so every height-driven bake term (dust gradient,
//           shelf overhangs, occluders) must read the authoring position, not
//           the final one. Reading pos.y put the muzzle at boot level and dusted
//           the weapon pale — the reason cycle 2 shipped a white rifle.
//   slot    which palette slot each vertex came from, so the value ladder can
//           be ASSERTED per slot instead of trusted.

/** (roughness, metalness, rimWeight) */
export type Surf = readonly [number, number, number];

// Roughness is authored against a key light of intensity ~22 (see sky.ts). At
// that level anything under ~0.55 roughness throws a specular lobe that clips
// to white, which is how cycle 2 ended up with cream boots and a white rifle
// measured BRIGHTER than the ground they stood on. Every slot here is at or
// above the roughness where its highlight stays a sheen.
export const SURF_CLOTH: Surf = [0.90, 0.0, 0.30];
export const SURF_SKIN: Surf = [0.62, 0.0, 0.20];
export const SURF_HAIR: Surf = [0.82, 0.0, 0.28];
export const SURF_LEATHER: Surf = [0.64, 0.0, 0.22];
export const SURF_WEBBING: Surf = [0.76, 0.0, 0.34];
export const SURF_PACK: Surf = [0.80, 0.0, 0.46];
// Painted steel, not a mirror: the crown highlight has to be a broad soft band.
export const SURF_HELMET: Surf = [0.62, 0.0, 0.42];
// Parkerised steel. metalness 1.0 with a high roughness gives a dark, tinted,
// broad sheen; the old 0.85/0.46 gave a bright grazing lobe on a light base and
// the rifle became the brightest object in the frame.
export const SURF_METAL: Surf = [0.66, 1.0, 0.18];
export const SURF_GUNWOOD: Surf = [0.66, 0.0, 0.26];
export const SURF_POLY: Surf = [0.52, 0.0, 0.30];
export const SURF_RUBBER: Surf = [0.92, 0.0, 0.16];

// --- palette slots ----------------------------------------------------------
// Tagged per vertex so char-preview's audit can measure the actual mean luma
// written into each slot and fail a seed whose boots or weapon inherited a
// brighter tone. Cycle 2 shipped a seed with 0.645-luma boots under an
// "enforced value ladder" precisely because nothing checked the ladder.
export const SLOT = {
  NONE: 0,
  SKIN: 1,
  HAIR: 2,
  JACKET: 3,
  PANTS: 4,
  VEST: 5,
  BOOT: 6,
  HELMET: 7,
  PACK: 8,
  WEBBING: 9,
  METAL: 10,
  GUNWOOD: 11,
  POLY: 12,
  GLOVE: 13,
} as const;
export const SLOT_NAMES = [
  'NONE', 'SKIN', 'HAIR', 'JACKET', 'PANTS', 'VEST', 'BOOT',
  'HELMET', 'PACK', 'WEBBING', 'METAL', 'GUNWOOD', 'POLY', 'GLOVE',
];

export interface LoftRing {
  y: number;
  rx: number;
  rz: number;
  cx?: number;
  cz?: number;
}

/** Secondary bone influence for one ring: [boneIndex, weight 0..1]. */
export type Blend = readonly [number, number] | null;

export interface LoftOpts {
  sides?: number;
  color: THREE.Color;
  surf?: Surf;
  capTop?: boolean;
  capBot?: boolean;
  /**
   * Caps are hemispherical fans by default. A flat terminal ring takes the key
   * square-on and renders as a bright elliptical disc — the "amputated sausage"
   * read — and an UNCAPPED tube shows its own bore and backface. Set false only
   * where the end is genuinely welded inside another mass.
   */
  capRound?: boolean;
  /** Per-vertex colour override; return null to fall through to `color`. */
  colorAt?: (ring: number, side: number, ang: number, y: number) => THREE.Color | null;
  /** Per-ring surface override; return null to fall through to `surf`. */
  surfAt?: (ring: number) => Surf | null;
  /** Per-vertex radius multiplier — asymmetric masses (hairline, calf, ear cup). */
  radMod?: (ring: number, ang: number) => number;
  /** Per-vertex offsets, applied after radMod — brow ridges, jaw taper, sweeps. */
  offMod?: (ring: number, ang: number) => [number, number, number] | null;
  /** Per-ring secondary bone weight — the skin blend band across a joint. */
  blend?: Blend[];
  xf?: THREE.Matrix4;
  slot?: number;
}

export interface BoxOpts {
  color: THREE.Color;
  surf?: Surf;
  /** Euler XYZ applied about the box centre before it is placed. */
  rot?: [number, number, number];
  /** Uniform XZ scale of the top face — crude but effective taper. */
  taper?: number;
  /** Secondary bone influence for the whole box. */
  blend?: Blend;
  xf?: THREE.Matrix4;
  slot?: number;
}

const QUAD_FACES: ReadonlyArray<readonly [number, number, number, number]> = [
  [3, 2, 6, 7], // +Z
  [1, 0, 4, 5], // -Z
  [2, 1, 5, 6], // +X
  [0, 3, 7, 4], // -X
  [7, 6, 5, 4], // +Y
  [0, 1, 2, 3], // -Y
];

/** Hemispherical cap profile: [radius factor, axial factor, colour factor]. */
const DOME: ReadonlyArray<readonly [number, number, number]> = [
  [0.87, 0.24, 0.80],
  [0.60, 0.42, 0.66],
  [0.27, 0.53, 0.56],
];
const DOME_POLE = 0.60;

export class SkinBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly srf: number[] = [];
  readonly skinIdx: number[] = [];
  readonly skinWt: number[] = [];
  readonly idx: number[] = [];
  /** Pre-xf authoring position, parallel to `pos`. */
  readonly author: number[] = [];
  /** 1 where the vertex was pushed through an xf (rifle / hands). */
  readonly xfMask: number[] = [];
  readonly slot: number[] = [];
  private tmp = new THREE.Vector3();

  get count(): number {
    return this.pos.length / 3;
  }

  private vert(
    bone: number,
    x: number, y: number, z: number,
    c: THREE.Color,
    s: Surf,
    xf: THREE.Matrix4 | undefined,
    blend: Blend | undefined,
    slot: number
  ): void {
    this.author.push(x, y, z);
    this.xfMask.push(xf ? 1 : 0);
    this.slot.push(slot);
    this.tmp.set(x, y, z);
    if (xf) this.tmp.applyMatrix4(xf);
    this.pos.push(this.tmp.x, this.tmp.y, this.tmp.z);
    this.col.push(c.r, c.g, c.b);
    this.srf.push(s[0], s[1], s[2]);
    if (blend && blend[1] > 0.0005) {
      const w = Math.min(1, blend[1]);
      this.skinIdx.push(bone, blend[0], 0, 0);
      this.skinWt.push(1 - w, w, 0, 0);
    } else {
      this.skinIdx.push(bone, 0, 0, 0);
      this.skinWt.push(1, 0, 0, 0);
    }
  }

  private tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /**
   * One ring of vertices. `k` scales the radius and `dy` offsets it along the
   * axis, which is how the hemispherical end caps reuse the ring's own profile
   * instead of collapsing to a flat disc. `dark` scales the emitted colour so a
   * cap sits in the cavity shade rather than catching full key.
   */
  private ringVerts(
    bone: number, ring: LoftRing, r: number, o: LoftOpts, sides: number,
    k: number, dy: number, dark: number
  ): number {
    const base = this.count;
    const surf = (o.surfAt && o.surfAt(r)) || o.surf || SURF_CLOTH;
    const bl = o.blend ? o.blend[r] ?? null : null;
    const slot = o.slot ?? SLOT.NONE;
    const tint = new THREE.Color();
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const m = (o.radMod ? o.radMod(r, a) : 1) * k;
      let x = (ring.cx ?? 0) + Math.sin(a) * ring.rx * m;
      let y = ring.y + dy;
      let z = (ring.cz ?? 0) + Math.cos(a) * ring.rz * m;
      if (o.offMod) {
        const d = o.offMod(r, a);
        if (d) { x += d[0] * k; y += d[1] * k; z += d[2] * k; }
      }
      const c = (o.colorAt && o.colorAt(r, s, a, ring.y)) || o.color;
      if (dark !== 1) tint.setRGB(c.r * dark, c.g * dark, c.b * dark);
      else tint.copy(c);
      this.vert(bone, x, y, z, tint, surf, o.xf, bl, slot);
    }
    return base;
  }

  private poleVert(
    bone: number, ring: LoftRing, r: number, o: LoftOpts, dy: number, dark: number
  ): number {
    const base = this.count;
    const surf = (o.surfAt && o.surfAt(r)) || o.surf || SURF_CLOTH;
    const bl = o.blend ? o.blend[r] ?? null : null;
    const c = (o.colorAt && o.colorAt(r, 0, 0, ring.y)) || o.color;
    const tint = new THREE.Color(c.r * dark, c.g * dark, c.b * dark);
    this.vert(bone, ring.cx ?? 0, ring.y + dy, ring.cz ?? 0, tint, surf, o.xf, bl, o.slot ?? SLOT.NONE);
    return base;
  }

  /**
   * Lofted tube through `rings`, smooth around and along. Rings may run up or
   * down the body — limb chains read more naturally authored shoulder-to-wrist
   * — so the winding and the end caps are oriented from the actual direction,
   * never assumed. `capTop`/`capBot` always mean the geometric top/bottom.
   *
   * A capped end emits a 3-ring hemispherical fan appended to the SAME strip,
   * so the normals sweep continuously off the wall and no cut plane exists.
   */
  loft(bone: number, rings: LoftRing[], o: LoftOpts): void {
    const sides = o.sides ?? 8;
    const descending = rings[rings.length - 1].y < rings[0].y;
    const capFirst = descending ? o.capTop !== false : o.capBot !== false;
    const capLast = descending ? o.capBot !== false : o.capTop !== false;
    const round = o.capRound !== false;

    // Emission plan: optional lead-in dome, the real rings, optional tail dome.
    type Emit = { r: number; k: number; dy: number; dark: number };
    const seq: Emit[] = [];
    const firstDir = descending ? 1 : -1;
    const rmFirst = (rings[0].rx + rings[0].rz) * 0.5;
    const li = rings.length - 1;
    const rmLast = (rings[li].rx + rings[li].rz) * 0.5;
    if (capFirst && round) {
      for (let i = DOME.length - 1; i >= 0; i--) {
        const d = DOME[i];
        seq.push({ r: 0, k: d[0], dy: firstDir * d[1] * rmFirst, dark: d[2] });
      }
    }
    for (let r = 0; r < rings.length; r++) seq.push({ r, k: 1, dy: 0, dark: 1 });
    if (capLast && round) {
      for (const d of DOME) {
        seq.push({ r: li, k: d[0], dy: -firstDir * d[1] * rmLast, dark: d[2] });
      }
    }

    const bases: number[] = [];
    for (const e of seq) bases.push(this.ringVerts(bone, rings[e.r], e.r, o, sides, e.k, e.dy, e.dark));

    for (let i = 0; i < seq.length - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        const A = bases[i] + s;
        const B = bases[i] + s2;
        const C = bases[i + 1] + s2;
        const D = bases[i + 1] + s;
        if (descending) {
          this.tri(A, D, C);
          this.tri(A, C, B);
        } else {
          this.tri(A, C, D);
          this.tri(A, B, C);
        }
      }
    }

    // Pole fans close the domes. Flat caps keep the old behaviour, which is
    // still correct where a ring is buried inside a neighbouring mass.
    const fan = (ringIdx: number, cb: number, mid: number, faceUp: boolean): void => {
      void ringIdx;
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        if (faceUp) this.tri(mid, cb + s, cb + s2);
        else this.tri(mid, cb + s2, cb + s);
      }
    };
    if (capFirst) {
      if (round) {
        const mid = this.poleVert(bone, rings[0], 0, o, firstDir * DOME_POLE * rmFirst, DOME[2][2]);
        fan(0, bases[0], mid, descending);
      } else {
        const cb = this.ringVerts(bone, rings[0], 0, o, sides, 1, 0, 1);
        const mid = this.poleVert(bone, rings[0], 0, o, 0, 1);
        fan(0, cb, mid, descending);
      }
    }
    if (capLast) {
      const last = bases[bases.length - 1];
      if (round) {
        const mid = this.poleVert(bone, rings[li], li, o, -firstDir * DOME_POLE * rmLast, DOME[2][2]);
        fan(li, last, mid, !descending);
      } else {
        const cb = this.ringVerts(bone, rings[li], li, o, sides, 1, 0, 1);
        const mid = this.poleVert(bone, rings[li], li, o, 0, 1);
        fan(li, cb, mid, !descending);
      }
    }
  }

  /** Flat-shaded box, optionally rotated about its own centre then placed. */
  box(
    bone: number,
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    o: BoxOpts
  ): void {
    const m = new THREE.Matrix4();
    if (o.rot) m.makeRotationFromEuler(new THREE.Euler(o.rot[0], o.rot[1], o.rot[2], 'XYZ'));
    m.setPosition(cx, cy, cz);

    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const t = o.taper ?? 1;
    const surf = o.surf || SURF_CLOTH;
    const slot = o.slot ?? SLOT.NONE;
    const corners: Array<[number, number, number]> = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz],
      [-hx * t, hy, -hz * t], [hx * t, hy, -hz * t], [hx * t, hy, hz * t], [-hx * t, hy, hz * t],
    ];
    // The local rotate/place matrix is folded in here rather than passed to
    // vert(): the authoring stream must record the box in BIND-WORLD space,
    // and only the optional hold-pose xf counts as a change of frame.
    const p = new THREE.Vector3();
    for (const face of QUAD_FACES) {
      const base = this.count;
      for (const ci of face) {
        const c = corners[ci];
        p.set(c[0], c[1], c[2]).applyMatrix4(m);
        this.vert(bone, p.x, p.y, p.z, o.color, surf, o.xf, o.blend, slot);
      }
      this.tri(base, base + 1, base + 2);
      this.tri(base, base + 2, base + 3);
    }
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const n = this.count;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.srf, 3));
    geo.setAttribute('aAO', new THREE.Float32BufferAttribute(new Float32Array(n).fill(1), 1));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.skinIdx, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.skinWt, 4));
    geo.setIndex(this.idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.userData.author = new Float32Array(this.author);
    geo.userData.xfMask = new Uint8Array(this.xfMask);
    geo.userData.slot = new Uint8Array(this.slot);
    return geo;
  }
}

// ---------------------------------------------------------------------------
// Baked shading
// ---------------------------------------------------------------------------

/** Contact/cavity darkener: a sphere of influence around a crease. */
export interface Occluder {
  x: number; y: number; z: number;
  r: number;
  s: number;
}

/** Overhang darkener: everything just under a hem/brim/strap goes into shadow. */
export interface Shelf {
  y: number;
  /** horizontal reach from the body axis */
  r: number;
  /** how far down the shadow falls off */
  depth: number;
  s: number;
  /** optional horizontal centre (backpack, side pouches) */
  cx?: number;
  cz?: number;
}

/** Coherent 3D value noise on a hash lattice — deterministic fabric mottle. */
export function vnoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const g = (i: number, j: number, k: number): number => hash2(i * 157 + k * 311, j * 71 + k * 3, seed);
  const c00 = g(xi, yi, zi) + (g(xi + 1, yi, zi) - g(xi, yi, zi)) * u;
  const c10 = g(xi, yi + 1, zi) + (g(xi + 1, yi + 1, zi) - g(xi, yi + 1, zi)) * u;
  const c01 = g(xi, yi, zi + 1) + (g(xi + 1, yi, zi + 1) - g(xi, yi, zi + 1)) * u;
  const c11 = g(xi, yi + 1, zi + 1) + (g(xi + 1, yi + 1, zi + 1) - g(xi, yi + 1, zi + 1)) * u;
  const c0 = c00 + (c10 - c00) * v;
  const c1 = c01 + (c11 - c01) * v;
  return c0 + (c1 - c0) * w;
}

export interface BakeOpts {
  /** fabric mottle amplitude at ~9cm */
  fabric?: number;
  /** low-frequency grunge amplitude at ~45cm */
  grunge?: number;
  /** dust TINT ground into the lower body (a multiplier hue, never a lift) */
  dust?: THREE.Color;
  /** how much dust reaches the boots (0..1) — clamped to 0.15 */
  dustK?: number;
  /** camo band strength, 0 disables */
  camo?: number;
  /** slots that take the camo pass */
  camoSlots?: readonly number[];
}

/**
 * Multiplies baked lighting into the vertex colours and writes the cavity term
 * into `aAO` for the shader's INDIRECT path.
 *
 * Three things changed from cycle 2, all of them root causes rather than
 * symptoms:
 *  1. Everything height-driven now reads the AUTHORING position. The rifle and
 *     both hands are built through a hold-pose transform into farmR/farmL bind
 *     space, where the forearm points -Y, so their final positions put the
 *     muzzle at y~0.36. The dust ramp treated the weapon as boot-level and
 *     lifted it toward a pale tan — a white AK visible at 20m.
 *  2. Dust is a MULTIPLY toward a tint, never a lerp toward a colour. A lerp
 *     can only ever raise a dark value; it turned a 0.068-luma boot into 0.32.
 *     Soiling darkens and shifts hue; it does not brighten.
 *  3. The cavity/shelf AO is written to `aAO` and applied to indirect light
 *     only. Baking full AO into albedo darkens the DIRECT term too, which is
 *     what flattened the lit side while the shadow side crushed to black.
 */
export function bakeShading(
  geo: THREE.BufferGeometry,
  occluders: Occluder[],
  shelves: Shelf[],
  seed: number,
  o: BakeOpts = {}
): void {
  const fabric = o.fabric ?? 0.10;
  const grunge = o.grunge ?? 0.10;
  const dust = o.dust ?? new THREE.Color(0.86, 0.78, 0.62);
  const dustK = Math.min(0.15, o.dustK ?? 0.12);
  const camo = o.camo ?? 0;
  const camoSet = new Set(o.camoSlots ?? []);
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const col = geo.getAttribute('color');
  const aoAttr = geo.getAttribute('aAO');
  const author = geo.userData.author as Float32Array | undefined;
  const xfMask = geo.userData.xfMask as Uint8Array | undefined;
  const slots = geo.userData.slot as Uint8Array | undefined;
  const n = pos.count;
  // Per-instance offset so no two bots wear the same wear pattern.
  const ox = (seed % 97) * 0.37, oz = (seed % 53) * 0.61;
  // Normalise the dust tint so its brightest channel is 1: it can then only
  // ever pull channels DOWN, which is the whole point.
  const dmax = Math.max(1e-4, dust.r, dust.g, dust.b);
  const dr = dust.r / dmax, dg = dust.g / dmax, db = dust.b / dmax;

  for (let i = 0; i < n; i++) {
    const ax = author ? author[i * 3] : pos.getX(i);
    const ay = author ? author[i * 3 + 1] : pos.getY(i);
    const az = author ? author[i * 3 + 2] : pos.getZ(i);
    const xf = xfMask ? xfMask[i] === 1 : false;
    const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);

    // Sky occlusion: up-facing cloth catches the dome, down-facing loses it.
    // Parts built through the hold-pose xf have their normals in a rotated
    // frame, so a world-up test on them is meaningless — they take the flat
    // mid value instead of a bogus gradient.
    let ao = xf
      ? 0.86
      : (0.64 + 0.36 * (ny * 0.5 + 0.5)) * (0.90 + 0.10 * Math.min(1, ay / 1.1));

    if (!xf) {
      for (let o2 = 0; o2 < occluders.length; o2++) {
        const oc = occluders[o2];
        const dx = oc.x - ax, dy = oc.y - ay, dz = oc.z - az;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d >= oc.r) continue;
        const k = 1 - d / oc.r;
        const inv = d > 1e-5 ? 1 / d : 0;
        const facing = Math.max(0, nx * dx * inv + ny * dy * inv + nz * dz * inv);
        ao *= 1 - oc.s * k * k * (0.3 + 0.7 * facing);
      }

      for (let s = 0; s < shelves.length; s++) {
        const sh = shelves[s];
        const drop = sh.y - ay;
        if (drop < 0 || drop > sh.depth) continue;
        const hx = ax - (sh.cx ?? 0), hz = az - (sh.cz ?? 0);
        if (Math.sqrt(hx * hx + hz * hz) > sh.r) continue;
        const t = 1 - drop / sh.depth;
        ao *= 1 - sh.s * t * t;
      }
    }

    // Wear: coherent at ~9cm (weave/scuff) plus ~45cm (panel soiling).
    const m =
      1 + (vnoise3(ax * 11 + ox, ay * 11, az * 11 + oz, seed) - 0.5) * fabric * 2
        + (vnoise3(ax * 2.2 + ox, ay * 2.2, az * 2.2 + oz, seed ^ 0x5f3) - 0.5) * grunge * 2;

    // Direct light sees only a softened share of the cavity term; the full
    // term goes to `aAO` for the indirect path.
    const aoDirect = Math.pow(ao, 0.45);
    const f = aoDirect * m;
    let r = col.getX(i) * f, g = col.getY(i) * f, bl = col.getZ(i) * f;

    // --- camo / print pass ---------------------------------------------------
    // Two octaves at ~18cm and ~6cm thresholded into three bands. A garment
    // with a single flat hue and +/-11% noise has no pattern at all, which is
    // the single biggest read difference against the references.
    if (camo > 0 && slots && camoSet.has(slots[i])) {
      const c1 = vnoise3(ax * 5.6 + ox, ay * 5.6, az * 5.6 + oz, seed ^ 0x9a1);
      const c2 = vnoise3(ax * 16.5 + ox, ay * 16.5, az * 16.5 + oz, seed ^ 0x33d);
      const v = c1 * 0.68 + c2 * 0.32;
      let k = 1;
      if (v < 0.40) {
        k = 1 - 0.22 * camo;
        // Hue rotation on the darkest band only: real DPM/camo prints shift
        // hue between blotches, they do not just change value.
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        r += (lum * 0.84 - r) * 0.24 * camo;
        g += (lum * 1.08 - g) * 0.24 * camo;
        bl += (lum * 0.62 - bl) * 0.24 * camo;
      } else if (v > 0.61) {
        k = 1 + 0.16 * camo;
      }
      r *= k; g *= k; bl *= k;
    }

    // Dirt gradient: boots and shins grade toward the dust TINT. Multiply only.
    if (ay < 0.95) {
      const t = Math.min(1, (0.95 - ay) / 0.80);
      const dm = dustK * t * t * (0.55 + 0.45 * vnoise3(ax * 6 + ox, ay * 6, az * 6, seed ^ 0x21));
      r *= 1 - dm * (1 - dr);
      g *= 1 - dm * (1 - dg);
      bl *= 1 - dm * (1 - db);
    }
    col.setXYZ(i, r, g, bl);
    aoAttr.setX(i, ao);
  }
  col.needsUpdate = true;
  aoAttr.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Value-ladder audit
// ---------------------------------------------------------------------------

function lin2srgb(c: number): number {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** sRGB luma of a LINEAR colour triple, matching toneAt()'s target space. */
export function srgbLuma(r: number, g: number, b: number): number {
  return 0.2126 * lin2srgb(r) + 0.7152 * lin2srgb(g) + 0.0722 * lin2srgb(b);
}

/** Mean sRGB luma of every vertex in each palette slot. */
export function slotLuma(geo: THREE.BufferGeometry): Record<string, number> {
  const col = geo.getAttribute('color');
  const slots = geo.userData.slot as Uint8Array | undefined;
  const out: Record<string, number> = {};
  if (!slots) return out;
  const sum = new Float64Array(SLOT_NAMES.length);
  const cnt = new Float64Array(SLOT_NAMES.length);
  for (let i = 0; i < col.count; i++) {
    const s = slots[i];
    if (!s) continue;
    sum[s] += srgbLuma(col.getX(i), col.getY(i), col.getZ(i));
    cnt[s]++;
  }
  for (let s = 1; s < SLOT_NAMES.length; s++) {
    if (cnt[s] > 0) out[SLOT_NAMES[s]] = +(sum[s] / cnt[s]).toFixed(4);
  }
  return out;
}

/** Per-slot standard deviation of sRGB luma — the "is there any pattern" probe. */
export function slotVariance(geo: THREE.BufferGeometry, want: readonly number[]): number {
  const col = geo.getAttribute('color');
  const slots = geo.userData.slot as Uint8Array | undefined;
  if (!slots) return 0;
  const set = new Set(want);
  let n = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < col.count; i++) {
    if (!set.has(slots[i])) continue;
    const l = srgbLuma(col.getX(i), col.getY(i), col.getZ(i));
    n++; s1 += l; s2 += l * l;
  }
  if (n < 8) return 0;
  const mean = s1 / n;
  return +Math.sqrt(Math.max(0, s2 / n - mean * mean)).toFixed(4);
}

// ---------------------------------------------------------------------------
// Palette helpers
// ---------------------------------------------------------------------------

/** Picks deterministically from a palette. */
export function pick<T>(list: readonly T[], seed: number, salt: number): T {
  return list[Math.min(list.length - 1, Math.floor(hash2(seed, salt) * list.length))];
}

/** Deterministic 0..1 draw. */
export function draw(seed: number, salt: number): number {
  return hash2(seed, salt);
}

/** Copies a colour and scales it in linear space. */
export function shade(c: THREE.Color, k: number): THREE.Color {
  return new THREE.Color(c.r * k, c.g * k, c.b * k);
}

/** Blends two colours in linear space. */
export function mix(a: THREE.Color, b: THREE.Color, t: number): THREE.Color {
  return new THREE.Color(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}

/** Maximum (max-min)/max chroma any palette entry may reach. */
export const SAT_CAP = 0.30;

/**
 * Builds a colour from an sRGB hex RESCALED to hit an exact sRGB luma. The
 * palettes below carry hue only; value comes from the slot. That is what makes
 * the value ladder (dark gear / mid trousers / light jacket) survive every
 * hue permutation instead of collapsing into one olive mass at 30m.
 */
export function toneAt(hex: number, luma: number, satCap = SAT_CAP): THREE.Color {
  let r = ((hex >> 16) & 255) / 255;
  let g = ((hex >> 8) & 255) / 255;
  let b = (hex & 255) / 255;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = l > 1e-4 ? luma / l : 1;
  r *= k; g *= k; b *= k;
  // Chroma ceiling. Rescaling a hex to a LIGHT slot multiplies its saturation
  // as well as its value, so a plausible 0x2f5a6e denim pushed to a 0.54 jacket
  // slot comes out as neon cyan and a rust orange comes out as hi-vis. Nothing
  // in a late-afternoon Erangel grade is that chromatic; clamping here means a
  // palette can carry real hue families without any entry ever going lurid.
  {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const chroma = mx > 1e-4 ? (mx - mn) / mx : 0;
    if (chroma > satCap) {
      const t = 1 - satCap / chroma;
      r += (luma - r) * t; g += (luma - g) * t; b += (luma - b) * t;
    }
  }
  // If the rescale clipped a channel, pull the whole triple toward grey until
  // it fits, so the luma target holds and the hue only weakens.
  const hi = Math.max(r, g, b);
  if (hi > 1) {
    const t = (hi - 1) / (hi - luma + 1e-5);
    r += (luma - r) * t; g += (luma - g) * t; b += (luma - b) * t;
  }
  return new THREE.Color().setRGB(
    Math.min(1, Math.max(0, r)),
    Math.min(1, Math.max(0, g)),
    Math.min(1, Math.max(0, b)),
    THREE.SRGBColorSpace
  );
}
