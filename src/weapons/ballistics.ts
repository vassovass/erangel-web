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
