import * as THREE from 'three';
import type { BotProfile } from './profiles';
import type { Combatant, DetRng } from './types';

// Magazine, trigger and aim solution.
//
// Finite ammunition is what turns "shooting" into a decision. A recruit dumps
// thirty rounds and then stands in the open for three seconds with an empty
// gun; a veteran tops up at thirty percent from behind a wall. Both are visible
// from across a field, and both are the difference between a target and an
// opponent.

export const BULLET_SPEED = 715;
/** Per-round damage, identical for every tier. Skill is the variable, not hurt. */
export const BOT_DAMAGE = 24;
const GRAVITY = 9.81;

export class Firearm {
  readonly magSize: number;
  ammo: number;
  reserve: number;
  reloading = false;
  reloadLeft = 0;
  /** Rounds still owed to the current burst. */
  burstLeft = 0;
  private shotTimer = 0;
  private pause = 0;
  /** Sim time of the last round fired. */
  lastShotT = -999;
  /** Completed reloads — real evidence for the ammo assertion. */
  reloadsCompleted = 0;

  constructor(profile: BotProfile, reserve: number) {
    this.magSize = profile.magSize;
    this.ammo = profile.magSize;
    this.reserve = reserve;
  }

  update(dt: number): void {
    if (this.shotTimer > 0) this.shotTimer -= dt;
    if (this.pause > 0) this.pause -= dt;
    if (this.reloading) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) this.finishReload();
    }
  }

  get dry(): boolean {
    return this.ammo <= 0;
  }

  get canShootNow(): boolean {
    return !this.reloading && this.ammo > 0;
  }

  /** True on the exact ticks the trigger would break, before anything is spent. */
  get readyToFire(): boolean {
    return !this.reloading && this.ammo > 0 && this.pause <= 0 && this.shotTimer <= 0;
  }

  /** Would this bot rather be reloading than shooting right now? */
  wantsReload(profile: BotProfile): boolean {
    if (this.reloading || this.reserve <= 0) return false;
    if (this.ammo <= 0) return true;
    return this.ammo <= this.magSize * profile.reloadAt;
  }

  /**
   * Out of contact, everybody tops up — that is not a skill, it is having
   * hands. What separates the tiers is reloading MID-FIGHT (see reloadAt and
   * reloadNeedsCover), not whether a bot can be bothered when nothing is
   * shooting at it.
   */
  wantsTopUp(): boolean {
    return !this.reloading && this.reserve > 0 && this.ammo < this.magSize * 0.62;
  }

  startReload(profile: BotProfile): boolean {
    if (this.reloading || this.reserve <= 0 || this.ammo >= this.magSize) return false;
    this.reloading = true;
    this.reloadLeft = profile.reloadTime;
    this.burstLeft = 0;
    return true;
  }

  cancelReload(): void {
    this.reloading = false;
    this.reloadLeft = 0;
  }

  private finishReload(): void {
    const want = this.magSize - this.ammo;
    const take = Math.min(want, this.reserve);
    this.ammo += take;
    this.reserve -= take;
    this.reloading = false;
    this.reloadLeft = 0;
    if (take > 0) this.reloadsCompleted++;
  }

  /**
   * Trigger control. Returns true exactly on the ticks a round should leave the
   * muzzle. Burst length and the pause between bursts are the tier's signature:
   * recruits hold a five-to-ten round spray and pause barely long enough to
   * see what they hit; elites tap two or three and reset.
   */
  tryFire(profile: BotProfile, rng: DetRng, t: number): boolean {
    if (this.reloading || this.ammo <= 0) return false;
    if (this.pause > 0 || this.shotTimer > 0) return false;
    if (this.burstLeft <= 0) {
      this.burstLeft =
        profile.burstMin + Math.floor(rng.next() * (profile.burstMax - profile.burstMin + 1));
    }
    this.shotTimer = profile.shotInterval;
    this.burstLeft--;
    this.ammo--;
    this.lastShotT = t;
    if (this.burstLeft <= 0 || this.ammo <= 0) {
      this.pause = rng.range(profile.burstPauseMin, profile.burstPauseMax);
    }
    return true;
  }

  /** Break the burst — target lost, moving, or ducking back behind cover. */
  breakBurst(rng: DetRng, profile: BotProfile): void {
    if (this.burstLeft > 0) {
      this.burstLeft = 0;
      this.pause = Math.max(this.pause, rng.range(profile.burstPauseMin * 0.5, profile.burstPauseMax * 0.6));
    }
  }
}

export interface AimInputs {
  /** Seconds of continuous contact — the cone starts wide and settles. */
  contactAge: number;
  /** 0..1 own movement. */
  selfSpeed01: number;
  /** 0..1 recent incoming fire. */
  suppression: number;
}

const _aim = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _point = new THREE.Vector3();

export interface AimSolution {
  dir: THREE.Vector3;
  dist: number;
  /** The cone actually used, radians — surfaced for the AI test harness. */
  cone: number;
}

/**
 * Turn "I want to shoot that" into a direction.
 *
 * Three separate skills live here and they are separately observable:
 *  - LEAD: multiply the target's velocity by flight time. At 0 the bot shoots
 *    where the target was, which is why a recruit cannot hit a strafing player.
 *  - DROP: bullets fall. Compensating is what lets an elite reach 200 m.
 *  - CONE: a base spread that widens with range, with the bot's own movement,
 *    with incoming fire, and hugely in the first moments of contact.
 */
export function solveAim(
  from: THREE.Vector3,
  target: Combatant,
  aimPoint: THREE.Vector3,
  profile: BotProfile,
  rng: DetRng,
  inputs: AimInputs
): AimSolution {
  _point.copy(aimPoint);
  const rawDist = _point.distanceTo(from);
  const flight = rawDist / BULLET_SPEED;

  // Lead.
  _point.addScaledVector(target.vel, flight * profile.leadFactor);
  // Drop compensation.
  _point.y += 0.5 * GRAVITY * flight * flight * profile.dropComp;

  _aim.subVectors(_point, from);
  const dist = _aim.length();
  if (dist < 0.001) return { dir: _aim.set(0, 0, 1).clone(), dist: 0, cone: 0 };
  _aim.divideScalar(dist);

  const settle = 1 + (profile.settleMult - 1) * Math.max(0, 1 - inputs.contactAge / profile.settleS);
  const moveMult = 1 + (profile.moveErrMult - 1) * inputs.selfSpeed01;
  const suppress = 1 + inputs.suppression * (1 - profile.suppressionResist) * 1.6;
  const cone = (profile.aimErrBase + rawDist * profile.aimErrPerM) * settle * moveMult * suppress;

  _right.set(_aim.z, 0, -_aim.x).normalize();
  _up.crossVectors(_right, _aim);
  _aim
    .addScaledVector(_right, rng.signed() * cone)
    .addScaledVector(_up, rng.signed() * cone)
    .normalize();

  return { dir: _aim.clone(), dist, cone };
}
