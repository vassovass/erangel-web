import * as THREE from 'three';
import type { Heightfield } from '../gen/terraingen';

// Lightweight deterministic physics: analytic heightfield ground + static AABB
// colliders (buildings/props) + dynamic capsule targets (bots/player). Chosen
// over Rapier deliberately: kinematic FPS movement and raycast ballistics need
// exactness and low CPU, not rigid-body simulation (ruling logged 2026-08-04).

export interface GroundSample {
  height: number;
  slope: number;
}

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  kind: 'terrain' | 'box' | 'capsule';
  /** Registered id of the box/capsule hit, -1 for terrain. */
  id: number;
  /** User tag carried by the collider (e.g. 'building', 'bot:3', 'head:3'). */
  tag: string;
}

export interface BoxCollider {
  id: number;
  min: THREE.Vector3;
  max: THREE.Vector3;
  tag: string;
}

export interface CapsuleTarget {
  id: number;
  /** Foot position (bottom of capsule). */
  pos: THREE.Vector3;
  radius: number;
  height: number;
  tag: string;
  /** Head sphere for headshot detection. */
  headRadius: number;
  enabled: boolean;
}

const _tmpN = new THREE.Vector3();

export class PhysicsWorld {
  private boxes: BoxCollider[] = [];
  private capsules = new Map<number, CapsuleTarget>();
  private nextId = 1;

  constructor(readonly hf: Heightfield) {}

  addBox(min: THREE.Vector3, max: THREE.Vector3, tag = 'box'): number {
    const id = this.nextId++;
    this.boxes.push({ id, min: min.clone(), max: max.clone(), tag });
    return id;
  }

  addCapsule(pos: THREE.Vector3, radius: number, height: number, tag: string, headRadius = 0.16): number {
    const id = this.nextId++;
    this.capsules.set(id, { id, pos: pos.clone(), radius, height, tag, headRadius, enabled: true });
    return id;
  }

  updateCapsule(id: number, pos: THREE.Vector3, enabled = true): void {
    const c = this.capsules.get(id);
    if (c) {
      c.pos.copy(pos);
      c.enabled = enabled;
    }
  }

  removeCapsule(id: number): void {
    this.capsules.delete(id);
  }

  ground(x: number, z: number): GroundSample {
    return { height: this.hf.height(x, z), slope: this.hf.slope(x, z) };
  }

  /**
   * Kinematic capsule move with wall slide against AABBs, step limit against
   * terrain, and ground snap. Returns new position and grounded flag.
   * pos is the FOOT position; vertical motion handled via vy.
   */
  moveCapsule(
    pos: THREE.Vector3,
    delta: THREE.Vector3,
    vy: number,
    dt: number,
    radius: number,
    maxStep = 0.55
  ): { pos: THREE.Vector3; vy: number; grounded: boolean; blocked: boolean } {
    const out = pos.clone();
    let blocked = false;

    // Horizontal, axis-separated for cheap sliding.
    for (const axis of ['x', 'z'] as const) {
      const d = delta[axis];
      if (d === 0) continue;
      const trial = out.clone();
      trial[axis] += d;
      // Terrain step limit: refuse ascents steeper than maxStep per move.
      const hHere = this.hf.height(out.x, out.z);
      const hThere = this.hf.height(trial.x, trial.z);
      if (hThere - Math.max(out.y, hHere) > maxStep) {
        blocked = true;
        continue;
      }
      // AABB test at foot + mid + head heights.
      if (this.capsuleVsBoxes(trial, radius)) {
        blocked = true;
        continue;
      }
      out[axis] = trial[axis];
    }

    // Vertical.
    let grounded = false;
    let newVy = vy - 22 * dt; // gravity, slightly heavy for FPS snap
    out.y += newVy * dt;
    const groundH = this.hf.height(out.x, out.z);
    if (out.y <= groundH) {
      out.y = groundH;
      newVy = 0;
      grounded = true;
    }
    // Box roofs/floors: stand on boxes whose top is under our feet.
    for (const b of this.boxes) {
      if (
        out.x + radius > b.min.x && out.x - radius < b.max.x &&
        out.z + radius > b.min.z && out.z - radius < b.max.z
      ) {
        const top = b.max.y;
        if (vy <= 0 && out.y <= top && pos.y >= top - 0.3) {
          out.y = top;
          newVy = 0;
          grounded = true;
        }
      }
    }

    return { pos: out, vy: newVy, grounded, blocked };
  }

  private capsuleVsBoxes(foot: THREE.Vector3, radius: number): boolean {
    for (const b of this.boxes) {
      // Cheap: treat capsule as a vertical stack of 3 spheres.
      for (const hOff of [0.35, 0.95, 1.55]) {
        const cy = foot.y + hOff;
        const cx = Math.max(b.min.x, Math.min(foot.x, b.max.x));
        const cyC = Math.max(b.min.y, Math.min(cy, b.max.y));
        const cz = Math.max(b.min.z, Math.min(foot.z, b.max.z));
        const dx = foot.x - cx, dy = cy - cyC, dz = foot.z - cz;
        if (dx * dx + dy * dy + dz * dz < radius * radius) return true;
      }
    }
    return false;
  }

  /** Nearest hit along a ray against terrain, boxes and capsule targets. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, skipCapsuleId = -1): RayHit | null {
    let best: RayHit | null = null;

    const terr = this.raycastTerrain(origin, dir, maxDist);
    if (terr) best = terr;

    for (const b of this.boxes) {
      const t = rayVsAabb(origin, dir, b.min, b.max, best ? best.distance : maxDist);
      if (t !== null) {
        const point = origin.clone().addScaledVector(dir, t);
        best = { point, normal: aabbNormal(point, b), distance: t, kind: 'box', id: b.id, tag: b.tag };
      }
    }

    for (const c of this.capsules.values()) {
      if (!c.enabled || c.id === skipCapsuleId) continue;
      const limit = best ? best.distance : maxDist;
      // Head sphere first (higher priority at equal distance).
      const headC = c.pos.clone();
      headC.y += c.height - c.headRadius;
      const th = rayVsSphere(origin, dir, headC, c.headRadius, limit);
      if (th !== null) {
        const point = origin.clone().addScaledVector(dir, th);
        best = { point, normal: point.clone().sub(headC).normalize(), distance: th, kind: 'capsule', id: c.id, tag: `head:${c.tag}` };
        continue;
      }
      const tb = rayVsVerticalCapsule(origin, dir, c.pos, c.radius, c.height, limit);
      if (tb !== null) {
        const point = origin.clone().addScaledVector(dir, tb);
        _tmpN.set(point.x - c.pos.x, 0, point.z - c.pos.z).normalize();
        best = { point, normal: _tmpN.clone(), distance: tb, kind: 'capsule', id: c.id, tag: c.tag };
      }
    }

    return best;
  }

  private raycastTerrain(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    // March then bisect. Step adapts: fine near, coarse far.
    let prevT = 0;
    let prevAbove = origin.y - this.hf.height(origin.x, origin.z) > 0;
    if (!prevAbove) {
      return { point: origin.clone(), normal: new THREE.Vector3(0, 1, 0), distance: 0, kind: 'terrain', id: -1, tag: 'terrain' };
    }
    for (let t = 1.2; t <= maxDist; t += t < 60 ? 1.2 : 4) {
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      const z = origin.z + dir.z * t;
      const above = y - this.hf.height(x, z) > 0;
      if (!above) {
        // Bisect between prevT and t.
        let lo = prevT, hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          const my = origin.y + dir.y * mid;
          if (my - this.hf.height(origin.x + dir.x * mid, origin.z + dir.z * mid) > 0) lo = mid;
          else hi = mid;
        }
        const hitT = (lo + hi) / 2;
        const px = origin.x + dir.x * hitT;
        const pz = origin.z + dir.z * hitT;
        const n = this.hf.normal(px, pz);
        return {
          point: new THREE.Vector3(px, this.hf.height(px, pz), pz),
          normal: new THREE.Vector3(n[0], n[1], n[2]),
          distance: hitT,
          kind: 'terrain',
          id: -1,
          tag: 'terrain',
        };
      }
      prevT = t;
      prevAbove = above;
    }
    return null;
  }
}

function rayVsAabb(o: THREE.Vector3, d: THREE.Vector3, min: THREE.Vector3, max: THREE.Vector3, maxDist: number): number | null {
  let tmin = 0;
  let tmax = maxDist;
  for (const a of ['x', 'y', 'z'] as const) {
    const inv = 1 / d[a];
    let t0 = (min[a] - o[a]) * inv;
    let t1 = (max[a] - o[a]) * inv;
    if (inv < 0) { const tmp = t0; t0 = t1; t1 = tmp; }
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
    if (tmin > tmax) return null;
  }
  return tmin > 0.001 ? tmin : null;
}

function aabbNormal(p: THREE.Vector3, b: BoxCollider): THREE.Vector3 {
  const eps = 0.02;
  if (Math.abs(p.x - b.min.x) < eps) return new THREE.Vector3(-1, 0, 0);
  if (Math.abs(p.x - b.max.x) < eps) return new THREE.Vector3(1, 0, 0);
  if (Math.abs(p.y - b.min.y) < eps) return new THREE.Vector3(0, -1, 0);
  if (Math.abs(p.y - b.max.y) < eps) return new THREE.Vector3(0, 1, 0);
  if (Math.abs(p.z - b.min.z) < eps) return new THREE.Vector3(0, 0, -1);
  return new THREE.Vector3(0, 0, 1);
}

function rayVsSphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number, maxDist: number): number | null {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0.001 && t < maxDist ? t : null;
}

function rayVsVerticalCapsule(o: THREE.Vector3, d: THREE.Vector3, foot: THREE.Vector3, r: number, h: number, maxDist: number): number | null {
  // Infinite cylinder test clamped to segment, plus end sphere at top.
  const ox = o.x - foot.x, oz = o.z - foot.z;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-8) {
    const b = ox * d.x + oz * d.z;
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      if (t > 0.001 && t < maxDist) {
        const y = o.y + d.y * t;
        if (y >= foot.y && y <= foot.y + h - r) return t;
      }
    }
  }
  // Bottom sphere (crouched/prone shots).
  const bot = foot.clone();
  bot.y += r;
  return rayVsSphere(o, d, bot, r, maxDist);
}
