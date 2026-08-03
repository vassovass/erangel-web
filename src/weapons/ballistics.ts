import * as THREE from 'three';
import type { PhysicsWorld, RayHit } from '../player/physics';

// Projectile ballistics with gravity drop, simulated as segmented raycasts.
// AKM-class: 715 m/s muzzle velocity. Each fixed tick every live bullet
// advances one segment and tests the world.

export interface BulletHit {
  hit: RayHit;
  damage: number;
  direction: THREE.Vector3;
}

interface Bullet {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  travelled: number;
  ownerCapsuleId: number;
  baseDamage: number;
  whizzed?: boolean;
}

function segmentPointDistSq(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = p.x - (a.x + abx * t), dy = p.y - (a.y + aby * t), dz = p.z - (a.z + abz * t);
  return dx * dx + dy * dy + dz * dz;
}

const GRAVITY = 9.81;
const MAX_RANGE = 700;

export class Ballistics {
  private bullets: Bullet[] = [];
  /** Called for every world hit (impact FX). */
  onImpact: ((hit: RayHit, dir: THREE.Vector3) => void) | null = null;
  /** Called when a capsule target is hit. */
  onTargetHit: ((hit: BulletHit) => void) | null = null;
  /** Tracer hook: (from, to) per advanced segment. */
  onTrace: ((from: THREE.Vector3, to: THREE.Vector3) => void) | null = null;
  /** Near-miss hook: a hostile bullet passed close to the listener. */
  onWhiz: ((at: THREE.Vector3) => void) | null = null;
  /** Listener for whiz detection (player eye) + owning capsule to exclude. */
  listenerPos: THREE.Vector3 | null = null;
  listenerCapsuleId = -1;

  constructor(private world: PhysicsWorld) {}

  fire(origin: THREE.Vector3, dir: THREE.Vector3, muzzleSpeed: number, baseDamage: number, ownerCapsuleId = -1): void {
    this.bullets.push({
      pos: origin.clone(),
      vel: dir.clone().normalize().multiplyScalar(muzzleSpeed),
      travelled: 0,
      ownerCapsuleId,
      baseDamage,
    });
  }

  fixedUpdate(dt: number): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.vel.y -= GRAVITY * dt;
      const step = b.vel.length() * dt;
      const dir = b.vel.clone().normalize();
      const hit = this.world.raycast(b.pos, dir, step, b.ownerCapsuleId);
      if (hit) {
        this.resolveHit(b, hit, dir);
        this.bullets.splice(i, 1);
        continue;
      }
      const next = b.pos.clone().addScaledVector(dir, step);
      this.onTrace?.(b.pos, next);
      // Near-miss whiz: hostile bullet segment passing close to the listener.
      if (
        this.onWhiz &&
        !b.whizzed &&
        this.listenerPos &&
        b.ownerCapsuleId !== this.listenerCapsuleId &&
        segmentPointDistSq(b.pos, next, this.listenerPos) < 6.5
      ) {
        b.whizzed = true;
        this.onWhiz(this.listenerPos.clone());
      }
      b.pos.copy(next);
      b.travelled += step;
      if (b.travelled > MAX_RANGE || b.pos.y < -40) this.bullets.splice(i, 1);
    }
  }

  private resolveHit(b: Bullet, hit: RayHit, dir: THREE.Vector3): void {
    if (hit.kind === 'capsule') {
      const isHead = hit.tag.startsWith('head:');
      // PUBG-ish falloff: full to 50m, linear to 60% at 400m.
      const falloff = b.travelled < 50 ? 1 : Math.max(0.6, 1 - ((b.travelled - 50) / 350) * 0.4);
      const damage = b.baseDamage * falloff * (isHead ? 2.35 : 1);
      this.onTargetHit?.({ hit, damage, direction: dir });
    } else {
      this.onImpact?.(hit, dir);
    }
  }
}
