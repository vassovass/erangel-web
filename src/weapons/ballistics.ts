import * as THREE from 'three';
import type { PhysicsWorld, RayHit } from '../player/physics';
import { ZONE_MULT, rangeFalloff, zoneForHit, type HitZone } from './wpn-damage';

// Projectile ballistics with gravity drop, simulated as segmented raycasts.
// 715 m/s at the muzzle: 14 ms to 10 m, 140 ms to 100 m, 0.56 s to 400 m, over
// which gravity has pulled the round 1.5 m down. Each fixed tick every live
// bullet advances one segment (11.9 m at muzzle speed) and tests the world.
//
// EVERY MUZZLE IN THE MATCH COMES THROUGH HERE — the player's weapon and all
// fifteen bots — so the five-argument `fire` signature is a contract, not an
// implementation detail. match.ts WRAPS this method to log who fired (that is
// how kill credit works in all four directions), and its wrapper forwards
// exactly five arguments. A sixth would be silently dropped. Per-weapon
// behaviour therefore rides the four values already carried, and everything
// terminal is a property of the target, which is where it belongs anyway.

export interface BulletHit {
  hit: RayHit;
  /** Final damage: base x zone multiplier x range falloff. */
  damage: number;
  direction: THREE.Vector3;
  // --- added, all additive so existing consumers are untouched -------------
  /** Where on the body it landed. */
  zone: HitZone;
  /** Convenience: zone === 'head'. */
  headshot: boolean;
  /** Metres the round flew. */
  distance: number;
  /** Range scale applied, 1 down to FALLOFF.farScale. */
  falloff: number;
  /** Zone multiplier applied. */
  zoneMult: number;
  /** Damage before zone and range were taken into account. */
  baseDamage: number;
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

// Scratch for the per-tick march. Both are handed to onTrace, whose consumers
// (fx.tracer, main.ts's distance test) read them synchronously and copy what
// they keep — the same contract ShotRegistry.register already relies on. The
// hit payload still clones, because those escape into the damage router.
const _step = new THREE.Vector3();
const _next = new THREE.Vector3();

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

  /** Live rounds — cheap diagnostic for the test harness. */
  get inFlight(): number {
    return this.bullets.length;
  }

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
      _step.copy(b.vel).normalize();
      const hit = this.world.raycast(b.pos, _step, step, b.ownerCapsuleId);
      if (hit) {
        this.resolveHit(b, hit, _step);
        this.bullets.splice(i, 1);
        continue;
      }
      _next.copy(b.pos).addScaledVector(_step, step);
      this.onTrace?.(b.pos, _next);
      // Near-miss whiz: hostile bullet segment passing close to the listener.
      if (
        this.onWhiz &&
        !b.whizzed &&
        this.listenerPos &&
        b.ownerCapsuleId !== this.listenerCapsuleId &&
        segmentPointDistSq(b.pos, _next, this.listenerPos) < 6.5
      ) {
        b.whizzed = true;
        this.onWhiz(this.listenerPos.clone());
      }
      b.pos.copy(_next);
      b.travelled += step;
      if (b.travelled > MAX_RANGE || b.pos.y < -40) this.bullets.splice(i, 1);
    }
  }

  /**
   * Terminal effect.
   *
   * The collider only distinguishes a head sphere from a body cylinder, so the
   * rest of the anatomy is recovered from how high up the body the round
   * landed — measured against the ground under the impact, which needs no
   * change to physics.ts and no per-limb colliders. wpn-damage.ts owns the
   * bands and the honest fallback for a target that is not standing on the
   * heightfield at all.
   */
  private resolveHit(b: Bullet, hit: RayHit, dir: THREE.Vector3): void {
    if (hit.kind !== 'capsule') {
      this.onImpact?.(hit, dir);
      return;
    }
    const groundY = this.world.hf.height(hit.point.x, hit.point.z);
    const zone = zoneForHit(hit.tag.startsWith('head:'), hit.point.y - groundY);
    const falloff = rangeFalloff(b.travelled);
    const zoneMult = ZONE_MULT[zone];
    this.onTargetHit?.({
      hit,
      damage: b.baseDamage * falloff * zoneMult,
      direction: dir.clone(),
      zone,
      headshot: zone === 'head',
      distance: b.travelled,
      falloff,
      zoneMult,
      baseDamage: b.baseDamage,
    });
  }
}
