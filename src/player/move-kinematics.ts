// Pure locomotion math for the player controller.
//
// Everything here is a deterministic function of its arguments: no state, no
// randomness, no THREE types, no allocation in the hot paths. It lives apart
// from controller.ts so each rule of the movement model can be read, reasoned
// about and driven from a test harness on its own, and so the controller reads
// as policy ("what the soldier is trying to do") rather than as arithmetic.
//
// Convention: horizontal vectors are {x, z} in world space. A THREE.Vector3
// satisfies that shape structurally, so the controller passes its velocity
// vector straight in and the y component is simply not touched.

export interface Vec2 {
  x: number;
  z: number;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Hermite ease used for stance blends and slope falloffs. */
export function smoothstep01(v: number): number {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

/** Move `cur` toward `target` by at most `maxDelta`. */
export function moveTowards(cur: number, target: number, maxDelta: number): number {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

/**
 * Ground locomotion: accelerate along the wish direction, brake back to it when
 * over-speed, and bleed the sideways leftover separately.
 *
 * Splitting velocity into "along the direction I want to go" and "the momentum
 * I still carry sideways" is what gives a direction change weight. Deleting the
 * sideways part (what the old controller did implicitly, by writing velocity
 * every frame) is what made turns feel like a teleport.
 *
 * @param vel        mutated in place (x/z only)
 * @param wishX/wishZ UNIT direction the player is asking for; (0,0) = no input
 * @param wishSpeed  the speed that direction should settle at (m/s)
 * @param accel      m/s^2 available to speed up along the wish direction
 * @param brake      m/s^2 available to slow down (also used when reversing)
 * @param turnBrake  m/s^2 at which leftover sideways momentum decays
 */
export function groundAccelerate(
  vel: Vec2,
  wishX: number,
  wishZ: number,
  wishSpeed: number,
  accel: number,
  brake: number,
  turnBrake: number,
  dt: number
): void {
  const wishing = wishSpeed > 0 && (wishX !== 0 || wishZ !== 0);

  if (!wishing) {
    // Hands off the sticks: brake the whole vector toward rest. This is the
    // stopping distance the player feels.
    const sp = Math.hypot(vel.x, vel.z);
    if (sp <= 1e-5) {
      vel.x = 0;
      vel.z = 0;
      return;
    }
    const k = Math.max(0, sp - brake * dt) / sp;
    vel.x *= k;
    vel.z *= k;
    return;
  }

  const along = vel.x * wishX + vel.z * wishZ;
  let perpX = vel.x - wishX * along;
  let perpZ = vel.z - wishZ * along;

  const perp = Math.hypot(perpX, perpZ);
  if (perp > 1e-5) {
    const k = Math.max(0, perp - turnBrake * dt) / perp;
    perpX *= k;
    perpZ *= k;
  } else {
    perpX = 0;
    perpZ = 0;
  }

  let na: number;
  if (along < wishSpeed) {
    // Pushing against your own momentum (along < 0) digs in with the braking
    // authority, not the (softer) accelerating one — you plant a foot to
    // reverse, you do not gently fade the other way.
    const rate = along < 0 ? brake : accel;
    na = Math.min(wishSpeed, along + rate * dt);
  } else {
    na = Math.max(wishSpeed, along - brake * dt);
  }

  vel.x = wishX * na + perpX;
  vel.z = wishZ * na + perpZ;
}

/**
 * Airborne control: a small nudge along the wish direction, no free speed.
 * The along-component is never pushed past `wishSpeed` and the total is never
 * pushed past the speed carried into the jump, so air-strafing cannot be used
 * to outrun the ground model.
 */
export function airAccelerate(
  vel: Vec2,
  wishX: number,
  wishZ: number,
  wishSpeed: number,
  accel: number,
  drag: number,
  dt: number
): void {
  const sp0 = Math.hypot(vel.x, vel.z);
  if (drag > 0 && sp0 > 1e-5) {
    const k = Math.max(0, sp0 - drag * dt) / sp0;
    vel.x *= k;
    vel.z *= k;
  }
  if (wishSpeed <= 0 || (wishX === 0 && wishZ === 0)) return;

  const along = vel.x * wishX + vel.z * wishZ;
  const add = Math.min(accel * dt, Math.max(0, wishSpeed - along));
  if (add <= 0) return;
  vel.x += wishX * add;
  vel.z += wishZ * add;

  const cap = Math.max(wishSpeed, sp0);
  const sp1 = Math.hypot(vel.x, vel.z);
  if (sp1 > cap) {
    const k = cap / sp1;
    vel.x *= k;
    vel.z *= k;
  }
}

/**
 * Speed multiplier for a slope, given the GRADE along the direction of travel
 * (rise over run = tan of the incline; positive is uphill).
 *
 * Gentle ground costs nothing, the cost ramps in over the band, and anything
 * past `steepTan` is a scramble at `uphillMinScale`. Downhill gives a small,
 * capped boost so running down a hill reads as momentum rather than as a
 * treadmill.
 */
export function slopeSpeedScale(
  grade: number,
  gentleTan: number,
  steepTan: number,
  uphillMinScale: number,
  downhillMaxBoost: number
): number {
  if (grade >= 0) {
    const t = smoothstep01((grade - gentleTan) / Math.max(1e-4, steepTan - gentleTan));
    return 1 - t * (1 - uphillMinScale);
  }
  const t = smoothstep01((-grade - gentleTan) / Math.max(1e-4, steepTan - gentleTan));
  return 1 + t * downhillMaxBoost;
}

/** Free-fall impact speed after dropping `drop` metres under `gravity`. */
export function impactSpeedForDrop(drop: number, gravity: number): number {
  return drop <= 0 ? 0 : Math.sqrt(2 * gravity * drop);
}

/**
 * Fall damage from a landing impact speed.
 *
 * Quadratic between the safe threshold and the lethal one: kinetic energy goes
 * with v^2, and it matches the shape players expect — a scraped knee just past
 * the threshold, a broken everything at the top.
 */
export function fallDamageFor(
  impactSpeed: number,
  safeSpeed: number,
  lethalSpeed: number,
  maxDamage: number
): number {
  if (impactSpeed <= safeSpeed) return 0;
  const t = clamp01((impactSpeed - safeSpeed) / Math.max(1e-3, lethalSpeed - safeSpeed));
  return Math.min(maxDamage, maxDamage * t * t);
}

/** A critically damped 1D spring: current value and its velocity. */
export interface Spring {
  x: number;
  v: number;
}

/**
 * One implicit-Euler step of a critically damped spring toward `target`,
 * mutating `s` in place (no allocation — these run every render frame).
 *
 * Implicit rather than explicit because it is unconditionally stable at any
 * dt, and this laptop genuinely does drop to single-digit frame rates; an
 * explicit spring at 6 fps explodes.
 */
export function springStep(s: Spring, target: number, omega: number, dt: number): void {
  const denom = 1 + 2 * dt * omega + dt * dt * omega * omega;
  s.v = (s.v + dt * omega * omega * (target - s.x)) / denom;
  s.x += dt * s.v;
}
