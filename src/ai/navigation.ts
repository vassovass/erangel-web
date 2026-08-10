import * as THREE from 'three';
import type { PhysicsWorld } from '../player/physics';
import type { AiContext, Combatant, DetRng } from './types';
import type { BotProfile } from './profiles';

// Locomotion and destination picking.
//
// There is no navmesh — this map is a heightfield with ~3000 tree colliders and
// a few hundred building AABBs, and baking a mesh for it would cost more than
// the whole AI. Instead: steer, slide, and notice when you are stuck. The stuck
// detector is what stops a bot grinding its face into a wall for the whole
// match, which is the single most obvious "not very good" tell there is.

const RUN = 5.6;
export const WALK = 3.4;
export const SPRINT = 6.4;
export { RUN };

const _step = new THREE.Vector3();
const _right = new THREE.Vector3();

export class Locomotion {
  readonly pos: THREE.Vector3;
  readonly vel = new THREE.Vector3();
  yaw: number;
  vy = 0;
  speed01 = 0;
  walkPhase = 0;
  /** 0..1 crouch blend. */
  crouch = 0;

  private prev = new THREE.Vector3();
  private stuckAccum = 0;
  private stuckTimer = 0;
  private detourTimer = 0;
  private detourSign = 1;
  private lastCommandedSpeed = 0;

  constructor(pos: THREE.Vector3, yaw: number, private radius = 0.36) {
    this.pos = pos.clone();
    this.prev.copy(pos);
    this.yaw = yaw;
  }

  private moved = false;

  /** Call once per fixed tick, before any movement command. */
  beginTick(dt: number, rng: DetRng): void {
    if (dt > 0) {
      this.vel.set(
        (this.pos.x - this.prev.x) / dt,
        (this.pos.y - this.prev.y) / dt,
        (this.pos.z - this.prev.z) / dt
      );
    }
    // Stuck detection: commanded to move but barely moving.
    this.stuckAccum += Math.hypot(this.pos.x - this.prev.x, this.pos.z - this.prev.z);
    this.stuckTimer += dt;
    if (this.stuckTimer >= 0.8) {
      if (this.lastCommandedSpeed > 0.5 && this.stuckAccum < this.lastCommandedSpeed * 0.8 * 0.25) {
        // Commit to one side for a while instead of jittering between them.
        this.detourTimer = 1.4;
        this.detourSign = rng.chance(0.5) ? 1 : -1;
      }
      this.stuckTimer = 0;
      this.stuckAccum = 0;
    }
    if (this.detourTimer > 0) this.detourTimer -= dt;
    this.prev.copy(this.pos);
    this.lastCommandedSpeed = 0;
    this.moved = false;
    this.speed01 = 0;
  }

  /**
   * Close the tick. moveCapsule walks every collider in the world, so it is
   * called AT MOST ONCE per bot per tick: if the bot already stepped, this is a
   * no-op; if it stood still, one zero-delta move settles it onto the ground.
   */
  endTick(dt: number, world: PhysicsWorld): void {
    if (this.moved) return;
    // moveCapsule walks all ~3000 colliders and measures ~0.4 ms on the target
    // machine. A bot standing still on the ground does not need any of that:
    // if it is already within a few centimetres of the terrain and not falling,
    // snapping y is the whole answer for one heightfield sample.
    const g = world.hf.height(this.pos.x, this.pos.z);
    if (this.vy === 0 && Math.abs(this.pos.y - g) < 0.3) {
      this.pos.y = g;
      return;
    }
    const res = world.moveCapsule(this.pos, _step.set(0, 0, 0), this.vy, dt, this.radius);
    this.pos.copy(res.pos);
    this.vy = res.vy;
  }

  /** Steer toward (tx, tz). Returns the remaining planar distance. */
  seek(dt: number, tx: number, tz: number, speed: number, world: PhysicsWorld, turnRate = 3.4): number {
    const dx = tx - this.pos.x;
    const dz = tz - this.pos.z;
    const dist = Math.hypot(dx, dz);
    this.lastCommandedSpeed = speed;
    if (dist < 0.35) {
      this.speed01 = 0;
      return dist;
    }
    let desired = Math.atan2(dx, dz);
    if (this.detourTimer > 0) desired += this.detourSign * 1.15;
    this.turnTo(dt, desired, turnRate);

    _step.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(speed * dt);
    const res = world.moveCapsule(this.pos, _step, this.vy, dt, this.radius);
    if (res.blocked && this.detourTimer <= 0) this.detourTimer = 0.6;
    this.pos.copy(res.pos);
    this.vy = res.vy;
    this.moved = true;
    this.speed01 = Math.min(speed / SPRINT, 1);
    this.walkPhase += dt * (5 + this.speed01 * 6);
    return dist;
  }

  /** Sidestep while keeping the current facing (combat strafe). */
  strafe(dt: number, dir: number, speed: number, world: PhysicsWorld): void {
    this.lastCommandedSpeed = speed;
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(dir * speed * dt);
    const res = world.moveCapsule(this.pos, _right, this.vy, dt, this.radius);
    this.pos.copy(res.pos);
    this.vy = res.vy;
    this.moved = true;
    this.speed01 = Math.min(speed / SPRINT, 1) * 0.7;
    this.walkPhase += dt * 7;
  }

  turnTo(dt: number, targetYaw: number, rate = 3.4): void {
    let d = targetYaw - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += THREE.MathUtils.clamp(d, -rate * dt, rate * dt);
  }

  faceTowards(dt: number, x: number, z: number, rate = 4.2): void {
    this.turnTo(dt, Math.atan2(x - this.pos.x, z - this.pos.z), rate);
  }

  hold(): void {
    this.speed01 = 0;
  }
}

/** A walkable wander point, biased toward the safe circle. */
export function pickWanderTarget(
  ctx: AiContext,
  self: Combatant,
  rng: DetRng,
  out: THREE.Vector3
): void {
  const zc = ctx.zone.center;
  const inward = Math.atan2(zc.x - self.pos.x, zc.z - self.pos.z);
  for (let attempt = 0; attempt < 10; attempt++) {
    // Bias headings toward the circle, widening as attempts fail.
    const spread = 0.7 + attempt * 0.35;
    const a = inward + rng.signed() * spread;
    const r = 25 + rng.next() * 75;
    const x = self.pos.x + Math.sin(a) * r;
    const z = self.pos.z + Math.cos(a) * r;
    if (!ctx.hf.walkable(x, z)) continue;
    if (Math.hypot(x - zc.x, z - zc.z) > ctx.zone.radius - 10) continue;
    out.set(x, ctx.hf.height(x, z), z);
    return;
  }
  out.set(self.pos.x, self.pos.y, self.pos.z);
}

export interface ZonePlan {
  x: number;
  z: number;
  urgent: boolean;
}

/**
 * Where this bot should be standing to survive the next circle, or null when it
 * is already fine. Skill shows up as LEAD TIME: an elite starts walking 45 s
 * before the circle moves, a recruit waits until the gas is on its heels.
 */
export function zonePlan(ctx: AiContext, self: Combatant, profile: BotProfile): ZonePlan | null {
  const z = ctx.zone;
  const dCur = Math.hypot(self.pos.x - z.center.x, self.pos.z - z.center.z);
  const outside = dCur > z.radius - 4;

  const dNext = Math.hypot(self.pos.x - z.nextCenter.x, self.pos.z - z.nextCenter.z);
  const safeNext = Math.max(12, z.nextRadius - 18);
  const needsMove = dNext > safeNext;
  // Rough time cost of the walk, so a bot 400 m out leaves earlier than one
  // standing on the edge.
  const travelS = (dNext - safeNext) / RUN;
  const closing = z.shrinking || z.countdown < profile.zoneLeadS + travelS;

  if (!outside && !(needsMove && closing)) return null;

  // Aim for the near side of the next circle, not its middle: fifteen bots all
  // walking to one point is a conga line, and the edge is where cover is.
  const toX = self.pos.x - z.nextCenter.x;
  const toZ = self.pos.z - z.nextCenter.z;
  const len = Math.hypot(toX, toZ) || 1;
  const ring = Math.max(6, z.nextRadius * 0.55);
  let x = z.nextCenter.x + (toX / len) * ring;
  let zz = z.nextCenter.z + (toZ / len) * ring;
  if (!ctx.hf.walkable(x, zz)) {
    // Slide around the ring until the ground is standable.
    const base = Math.atan2(toX, toZ);
    for (let i = 1; i <= 8; i++) {
      const a = base + (i % 2 === 0 ? 1 : -1) * i * 0.4;
      const px = z.nextCenter.x + Math.sin(a) * ring;
      const pz = z.nextCenter.z + Math.cos(a) * ring;
      if (ctx.hf.walkable(px, pz)) {
        x = px;
        zz = pz;
        break;
      }
    }
  }
  return { x, z: zz, urgent: outside || z.shrinking };
}
