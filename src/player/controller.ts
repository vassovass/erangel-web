import * as THREE from 'three';
import type { System } from '../core/engine';
import type { Input } from '../core/input';
import type { PhysicsWorld } from './physics';
import type { Spring } from './move-kinematics';
import {
  airAccelerate,
  clamp01,
  fallDamageFor,
  groundAccelerate,
  impactSpeedForDrop,
  moveTowards,
  slopeSpeedScale,
  smoothstep01,
  springStep,
} from './move-kinematics';

// First-person movement with momentum. The soldier is a mass that has to be
// pushed up to speed and braked back down: acceleration and friction on the
// ground, near-zero authority in the air, stance changes that cost time, a
// sprint that spins up and needs a moment to settle before the weapon is
// steady again, slope-aware speed with a hard climb limit, fall damage, and a
// camera that reads actual velocity rather than a timer.
//
// The previous version wrote `delta = wishDir * speed * dt` straight into the
// capsule move, so the body reached top speed and stopped dead inside a single
// 16 ms tick and every direction change was a teleport. Everything below
// exists to replace that one line.

// ===========================================================================
// MOVEMENT TUNING — every dial that decides how the player feels is here.
// `MOVE` is a plain mutable object, so poking a field from the devtools
// console (see `window.__MOVE__`) retunes the game on the next tick with no
// rebuild. Every value carries what it means in the world and why it is that.
// ===========================================================================
export const MOVE = {
  // ---- Top speeds (m/s) --------------------------------------------------
  /** Tactical walk of a soldier under load: 4.3 m/s ~= 15.5 km/h. Unchanged
   *  from the original controller so weapon spread, AI lead and footstep
   *  cadence keep the scale they were tuned against. */
  walkSpeed: 4.3,
  /** Run carrying 25-30 kg of kit: 6.4 m/s ~= 23 km/h — brisk, and nowhere
   *  near a 100 m sprinter's 10 m/s, which is the point. */
  sprintSpeed: 6.4,
  /** Crouched shuffle, 2.1 m/s: about half walking pace, which is roughly what
   *  a bent-knee gait actually costs. */
  crouchSpeed: 2.1,
  /** Aiming down sights you shuffle, you do not stroll. 0.62 x walk = 2.7 m/s. */
  adsSpeedFactor: 0.62,
  /** You cannot back away as fast as you advance: 72% of forward pace. */
  backSpeedFactor: 0.72,
  /** Side-stepping crosses your feet: 88% of forward pace. */
  strafeSpeedFactor: 0.88,

  // ---- Ground acceleration (m/s^2) --------------------------------------
  /** 20 m/s^2 reaches walk speed in 0.22 s and sprint in 0.32 s from a stand:
   *  responsive enough that a tap of W is a lean forward, slow enough that the
   *  body clearly has mass. */
  groundAccel: 20,
  /** Crouched you push off from a squat — roughly half the authority. */
  crouchAccel: 11,
  /** Braking. 18 m/s^2 stops a 4.3 m/s walk in 0.24 s over 0.51 m, and a
   *  6.4 m/s sprint in 0.36 s over 1.14 m. That slide IS the weight. */
  groundBrake: 18,
  /** Sideways momentum left over from a direction change bleeds at 12 m/s^2 —
   *  slower than a straight stop, so a strafe swap arcs instead of snapping. */
  turnBrake: 12,

  // ---- Air ---------------------------------------------------------------
  /** Once your feet leave the ground you have almost no say. 2.2 m/s^2 is 9x
   *  less authority than the ground's 20: holding a direction key hard for the
   *  whole 0.65 s of a jump bends the flight path by about 19 degrees — enough
   *  to correct a landing, nowhere near enough to steer. (At 3.0 it was 25
   *  degrees, which starts to read as flying.) */
  airAccel: 2.2,
  /** Token drag so a jump keeps its momentum without sailing forever. */
  airDrag: 0.4,
  /** Jump take-off speed. Against gravity 22 that is a 1.18 m apex and 0.65 s
   *  of air — a soldier hopping a fence, not a platformer double-jump. */
  jumpSpeed: 7.2,
  /** Minimum seconds between jumps. Stops bunny-hopping becoming a movement
   *  tech and stops a jump from cancelling its own landing dip. */
  jumpCooldown: 0.35,
  /** MUST mirror the gravity inside PhysicsWorld.moveCapsule (22 m/s^2,
   *  deliberately heavier than Earth for FPS snap). Used here only to turn
   *  drop heights into impact speeds; if physics.ts changes, change this. */
  gravity: 22,
  /** Seconds after leaving the ground during which the body will still stick
   *  to a surface below it. Walking downhill, moveCapsule's gravity lags the
   *  falling terrain and the capsule micro-falls every frame; without this the
   *  player counts as airborne on any slope past ~5 deg, which would kill
   *  sprint, the gait and the accel model on every hillside. 0.15 s. */
  groundStickTime: 0.15,
  /** How far below the feet that stick reaches: 0.4 m. Large enough for a
   *  steep descent at sprint speed, far too small to catch a real fall. */
  groundStickDist: 0.4,

  // ---- Stance ------------------------------------------------------------
  /** Eye height standing: 1.68 m. Also hard-coded in main.ts's encounter
   *  staging, so it is a shared contract — do not move it casually. */
  eyeStand: 1.68,
  /** Eye height crouched: 1.05 m, a real bent-knee firing crouch. */
  eyeCrouch: 1.05,
  /** Dropping into a crouch is fast — 0.28 s, essentially a controlled fall. */
  crouchDownTime: 0.28,
  /** Standing back up fights gravity with a loaded rig: 0.38 s. */
  crouchUpTime: 0.38,
  /** While the stance is changing you are between stable bases, so speed is
   *  cut to 55% and ramps back as the transition completes. */
  stanceChangeSpeedScale: 0.55,

  // ---- Sprint ------------------------------------------------------------
  /** Seconds to spin the sprint speed cap up from walk to full. At 0.8 s the
   *  cap, not the acceleration, is the limiter for the whole wind-up: from a
   *  walk you reach 90% of top speed at 0.48 s and 99% at 0.71 s. Holding
   *  shift is a build-up you can feel, not a switch. (Measured at 0.55 s the
   *  wind-up finished in 0.33 s and was indistinguishable from instant.) */
  sprintWindup: 0.8,
  /** How fast the wind-up unwinds when sprint drops (0.25 s) — letting go
   *  settles quicker than committing. */
  sprintUnwind: 0.25,
  /** Seconds after sprint ends before the weapon is steady again. PUBG's
   *  sprint-to-fire delay sits around a third of a second. Exposed as
   *  `sprintRecovery01` / `aimPenalty01`; nothing is enforced here, because
   *  accuracy belongs to the weapon lane. */
  sprintRecover: 0.35,
  /** Sprint needs the stick genuinely forward: 0.7 = cos 45 deg, so W and W+A
   *  sprint but a pure side-step does not. Full-speed strafing is the classic
   *  way a shooter stops reading as a body. */
  sprintForwardDot: 0.7,
  /** Extra FOV degrees at full sprint, riding the wind-up so the lens opens as
   *  the legs spin up. */
  sprintFovKick: 6,

  // ---- Slopes ------------------------------------------------------------
  /** Grade (rise/run) below which ground is "flat" and free: 0.18 = 10 deg. */
  slopeGentleTan: 0.18,
  /** Grade at which the slope penalty is fully applied: 0.84 = 40 deg. */
  slopeSteepTan: 0.84,
  /** Speed left at 40 deg uphill: 45%. A scramble, not a walk. */
  slopeUphillMinScale: 0.45,
  /** Extra speed at 40 deg downhill: +18%, capped so a hillside is never a
   *  speed exploit. */
  slopeDownhillBoost: 0.18,
  /** Hard climb limit: grade 1.19 = 50 deg. Above a SUSTAINED face this steep
   *  the legs get nothing — you cannot walk up a cliff. Deliberately just past
   *  Heightfield.walkable()'s 49.5 deg, so ground the AI treats as impassable
   *  is impassable for the player too and no walkable ground ever locks up. */
  slopeClimbMaxTan: 1.19,
  /** Metres ahead the ground is sampled. 0.35 m is one boot length past the
   *  capsule edge (radius 0.38) and 0.75 m is about a stride: the near sample
   *  catches a lip, the far one catches a face. */
  slopeProbeNear: 0.35,
  slopeProbeFar: 0.75,
  /** Re-probe every N fixed ticks (4 = 15 Hz). At sprint speed the player
   *  covers 0.11 m per tick, so a 4-tick-old sample still describes the ground
   *  under the probe. Staggered because hf.height() is analytic fBm and this
   *  has to run on an Intel HD 620. */
  slopeProbeTicks: 4,

  // ---- Step limit --------------------------------------------------------
  /** Vertical terrain step the capsule may take standing: 0.5 m — a kerb, a
   *  low wall, a rock. Passed to moveCapsule, whose own default is 0.55. */
  stepUpStand: 0.5,
  /** Crouched you cannot hoist yourself: 0.28 m. */
  stepUpCrouch: 0.28,

  // ---- Landing / fall damage ---------------------------------------------
  /** Drops up to 4 m are free. Against gravity 22 that is a 13.3 m/s impact —
   *  comfortably above the 7.2 m/s a jump lands at, so jumping never hurts. */
  fallSafeDrop: 4.0,
  /** 22 m kills from full health (31.1 m/s impact). Between the two thresholds
   *  the damage curve is quadratic, like the kinetic energy it stands for. */
  fallLethalDrop: 22.0,
  /** Cap on a single landing, so an absurd drop cannot overflow the health
   *  system. 100 is a full bar. */
  fallMaxDamage: 100,
  /** Drop above which the camera dips at all: 0.5 m — stepping off a kerb
   *  registers, faintly. */
  landDipMinDrop: 0.5,
  /** Drop at which the camera dip is at full strength: 8 m. */
  landDipFullDrop: 8.0,
  /** Impulse (m/s) fed into the dip spring at full severity. With landDipFreq
   *  22 rad/s this peaks at roughly a 12 cm drop of the eye. */
  landDipImpulse: 7.0,
  /** Dip spring frequency, rad/s. 22 ~= 3.5 Hz: one firm compress and recover
   *  inside about 0.25 s, no wobble. */
  landDipFreq: 22,
  /** Radians of nose-down pitch per metre of eye dip — the head pitches into
   *  the landing. 0.28 rad/m x 0.12 m = 1.9 deg on a full-strength landing. */
  landDipPitchPerM: 0.28,
  /** Drop above which a landing counts as hard: 5 m. */
  hardLandDrop: 5.0,
  /** Speed cap multiplier immediately after a hard landing — you stagger. */
  hardLandSpeedScale: 0.45,
  /** Seconds the hard-landing penalty takes to ramp back to full. */
  hardLandRecover: 0.6,
  /** Horizontal momentum kept through a hard landing; the legs absorb the rest. */
  hardLandMomentumScale: 0.55,

  // ---- Camera: gait, sway, lean ------------------------------------------
  /** Metres of ground per footfall when walking. 4.3 / 1.55 = 2.8 steps/s
   *  ~= 166 steps per minute: a real loaded march tipping into a jog. */
  strideWalk: 1.55,
  /** Sprinting: 6.4 / 2.05 = 3.1 steps/s ~= 187 spm. */
  strideSprint: 2.05,
  /** Crouched: short shuffling steps, 2.1 / 0.85 = 2.5 steps/s. */
  strideCrouch: 0.85,
  /** Peak vertical head travel per footfall, metres. */
  bobAmplitudeY: 0.022,
  /** Peak lateral head sway per stride (two footfalls), metres. */
  bobAmplitudeX: 0.016,
  /** Bob is cut to 28% while aiming — the sights have to stay usable. */
  bobAdsScale: 0.28,
  /** Camera roll into a strafe at full lateral speed: 1.4 deg. Subtle on
   *  purpose; anything larger reads as a driving game. */
  strafeRollDeg: 1.4,
  /** Roll spring frequency, rad/s. 9 ~= 1.4 Hz: the tilt lags the input just
   *  enough to feel like a body leaning rather than a camera rotating. */
  strafeRollFreq: 9,
  /** Lean (Q/E) lateral offset in metres and roll in radians — unchanged. */
  leanOffset: 0.32,
  leanRoll: 0.13,
  /** Lean blend rate, 1/s. */
  leanRate: 12,

  // ---- Look ---------------------------------------------------------------
  lookSens: 0.0021,
  lookSensAds: 0.0011,
  /** +/- 1.5 rad = 86 deg, just short of straight up/down. */
  pitchLimit: 1.5,

  // ---- Capsule ------------------------------------------------------------
  radius: 0.38,

  // ---- Housekeeping -------------------------------------------------------
  /** Any frame-to-frame position change larger than this that the controller
   *  did not itself produce is treated as an external teleport (the __TEST__
   *  hooks in main.ts move the player exactly this way). Momentum, fall
   *  tracking and landing state are all cleared, so a teleport can never be
   *  mistaken for a fall or spike the weapon's movement spread. */
  teleportEpsilon: 0.05,
};

/** Anything that can take fall damage. Matches Health's signature. */
export interface DamageSink {
  damage(amount: number, fromDx?: number, fromDz?: number): void;
}

export type MoveState = 'idle' | 'walk' | 'sprint' | 'crouch' | 'air';

const UP = new THREE.Vector3(0, 1, 0);

export class PlayerController implements System {
  readonly position: THREE.Vector3; // foot position
  yaw = 0;
  pitch = 0;

  /** Set by the weapon system each frame; slows movement while aiming. */
  ads = false;
  /** Horizontal ground speed in m/s. Read by weapon spread, viewmodel sway,
   *  footsteps and the AI. Now the ACTUAL speed of the body — walk into a wall
   *  and it reads zero, where the old intent-based value stayed at full pace. */
  speed2D = 0;
  isSprinting = false;

  // ---- Added state. Nothing above is renamed; everything here is additive. --
  /** World-space velocity: x/z horizontal, y vertical. */
  readonly velocity = new THREE.Vector3();
  /** True while the capsule rests on ground or a box roof (ground stick
   *  included, so a downhill run does not read as falling). */
  grounded = true;
  /** Crouch toggle state — the intent. `stance01` is the blend it drives. */
  crouched = false;
  /** 1 = fully standing, 0 = fully crouched. */
  stance01 = 1;
  /** Sprint wind-up, 0..1. The speed cap and the FOV kick both ride this. */
  sprintCharge01 = 0;
  /** 0 the instant sprint ends, 1 once the weapon has settled again. */
  sprintRecovery01 = 1;
  /** Severity 0..1 of the most recent landing. */
  landingImpact01 = 0;
  /** Metres of the most recent completed fall (apex to touchdown). */
  lastFallDrop = 0;
  /** Coarse label for HUD / AI / animation. */
  moveState: MoveState = 'idle';
  /** Footfalls since spawn. Footsteps fires on each increment. */
  stepCount = 0;
  /** Position inside the current step, 0..1. Zero is the footfall. */
  gaitPhase01 = 0;
  /** Grade (rise/run) of the ground ahead along the direction of travel. */
  slopeGrade = 0;
  /** True when the ground ahead is a sustained face too steep to climb. */
  climbBlocked = false;
  /** Seconds the body has been off the ground (0 while grounded). */
  airTime = 0;

  /** Extra spread multiplier 0..1 for the weapon lane: 1 straight out of a
   *  sprint, 0 once settled. The weapon lane decides what to do with it. */
  get aimPenalty01(): number {
    return 1 - this.sprintRecovery01;
  }
  /** False while sprinting or still settling out of a sprint. */
  get weaponSteady(): boolean {
    return !this.isSprinting && this.sprintRecovery01 >= 1;
  }
  /** Current eye height above the feet, metres (crouch blend included). */
  get eyeHeight(): number {
    return this.eye;
  }

  /** Touchdown, with impact speed in m/s. WRAP this, do not replace it. */
  onLand: ((impactSpeed: number, severity01: number) => void) | null = null;
  /** Take-off. WRAP this, do not replace it. */
  onJump: (() => void) | null = null;
  /** Fall damage sink. Defaults to the optional constructor `health`. */
  onFallDamage: ((amount: number, impactSpeed: number) => void) | null = null;

  // ---- Internals ----------------------------------------------------------
  private vy = 0;
  private eye = MOVE.eyeStand;
  private baseFov: number;
  private fovKick = 0;
  private leanAmount = 0; // -1..1
  private stanceTimer = 0; // seconds left of the stance-change speed penalty
  private jumpTimer = 0;
  private hardLandTimer = 0;
  private sinceSprintEnd = MOVE.sprintRecover;
  private fallPeakY: number;
  private slopeTick = 0;
  private gradeSustained = 0;
  private gaitTotal = 0; // steps, wrapped modulo 2 so the sway stays continuous
  private dip: Spring = { x: 0, v: 0 };
  private rollSpring: Spring = { x: 0, v: 0 };
  private lastSimPos = new THREE.Vector3();
  // Scratch — reused every tick so the movement path allocates nothing.
  private readonly wish = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(
    private camera: THREE.PerspectiveCamera,
    private input: Input,
    private world: PhysicsWorld,
    spawn: THREE.Vector3,
    /** Optional — when supplied, fall damage is routed here automatically.
     *  Optional so main.ts's existing four-argument call keeps working. */
    health: DamageSink | null = null
  ) {
    this.position = spawn.clone();
    this.lastSimPos.copy(this.position);
    this.fallPeakY = this.position.y;
    this.baseFov = camera.fov;
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
    if (health) this.onFallDamage = (amount) => health.damage(amount);
    // Live tuning + read-only diagnostics, in the same spirit as the existing
    // window.__TEST__ / __APPLY_POSE__ hooks. Nothing in the game reads it.
    (globalThis as Record<string, unknown>).__MOVE__ = { tuning: MOVE, player: this };
  }

  /** Explicit teleport: moves the body and clears everything momentum-shaped. */
  teleport(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.resetMomentum();
  }

  private resetMomentum(): void {
    this.velocity.set(0, 0, 0);
    this.vy = 0;
    this.speed2D = 0;
    this.grounded = true;
    this.airTime = 0;
    this.fallPeakY = this.position.y;
    this.hardLandTimer = 0;
    this.landingImpact01 = 0;
    this.slopeGrade = 0;
    this.gradeSustained = 0;
    this.climbBlocked = false;
    this.slopeTick = 0;
    this.lastSimPos.copy(this.position);
  }

  fixedUpdate(dt: number): void {
    // Something outside the controller moved the body — the __TEST__ hooks in
    // main.ts do exactly this. Treat it as a teleport rather than as motion,
    // or a 40 m relocation reads as a 2400 m/s sprint and a lethal fall.
    if (this.position.distanceToSquared(this.lastSimPos) > MOVE.teleportEpsilon ** 2) {
      this.resetMomentum();
    }

    this.jumpTimer = Math.max(0, this.jumpTimer - dt);
    this.hardLandTimer = Math.max(0, this.hardLandTimer - dt);
    this.stanceTimer = Math.max(0, this.stanceTimer - dt);

    // ---- Stance ------------------------------------------------------------
    // Crouching in mid-air is a tuck, not a stance change: the toggle only
    // takes effect with feet on the ground (the press is still consumed).
    if (this.input.wasPressed('crouch') && this.grounded) {
      this.crouched = !this.crouched;
      this.stanceTimer = this.crouched ? MOVE.crouchDownTime : MOVE.crouchUpTime;
    }
    const stanceRate = this.crouched ? 1 / MOVE.crouchDownTime : 1 / MOVE.crouchUpTime;
    this.stance01 = moveTowards(this.stance01, this.crouched ? 0 : 1, stanceRate * dt);
    const stanceBlend = smoothstep01(this.stance01);
    // Eye height is SIMULATION state, not a camera effect: the AI's line of
    // sight, the HUD and anything else asking how tall the player currently is
    // must get the same answer between render frames as during one.
    this.eye = MOVE.eyeCrouch + (MOVE.eyeStand - MOVE.eyeCrouch) * stanceBlend;

    // ---- Wish direction ----------------------------------------------------
    let inX = 0;
    let inZ = 0;
    if (this.input.isDown('forward')) inZ -= 1;
    if (this.input.isDown('back')) inZ += 1;
    if (this.input.isDown('left')) inX -= 1;
    if (this.input.isDown('right')) inX += 1;
    const inLen = Math.hypot(inX, inZ);
    if (inLen > 0) {
      inX /= inLen;
      inZ /= inLen;
    }

    // Directional speed: full ahead, reduced sideways, slowest in reverse.
    // `fwd` is the forward component of the (unit) input, in [-1, 1].
    const fwd = -inZ;
    const dirScale =
      inLen === 0
        ? 0
        : fwd >= 0
          ? MOVE.strafeSpeedFactor + (1 - MOVE.strafeSpeedFactor) * fwd
          : MOVE.strafeSpeedFactor + (MOVE.backSpeedFactor - MOVE.strafeSpeedFactor) * -fwd;

    // ---- Sprint ------------------------------------------------------------
    const wantSprint =
      this.input.isDown('sprint') &&
      inLen > 0 &&
      fwd >= MOVE.sprintForwardDot &&
      !this.crouched &&
      !this.ads &&
      this.grounded;
    this.isSprinting = wantSprint;
    this.sprintCharge01 = moveTowards(
      this.sprintCharge01,
      wantSprint ? 1 : 0,
      dt / (wantSprint ? MOVE.sprintWindup : MOVE.sprintUnwind)
    );
    this.sinceSprintEnd = wantSprint ? 0 : Math.min(MOVE.sprintRecover, this.sinceSprintEnd + dt);
    this.sprintRecovery01 =
      MOVE.sprintRecover <= 0 ? 1 : clamp01(this.sinceSprintEnd / MOVE.sprintRecover);

    // ---- Target speed ------------------------------------------------------
    // Base speed by stance, blended through the crouch transition so the
    // penalty ramps in with the knees instead of snapping at the keypress.
    let speed = MOVE.crouchSpeed + (MOVE.walkSpeed - MOVE.crouchSpeed) * stanceBlend;
    // Sprint rides its wind-up on top of the walk cap.
    speed += (MOVE.sprintSpeed - MOVE.walkSpeed) * smoothstep01(this.sprintCharge01) * stanceBlend;
    if (this.ads) speed *= MOVE.adsSpeedFactor;
    speed *= dirScale;

    // Mid-stance-change you are between stable bases.
    if (this.stanceTimer > 0) {
      const t = clamp01(this.stanceTimer / (this.crouched ? MOVE.crouchDownTime : MOVE.crouchUpTime));
      speed *= 1 - (1 - MOVE.stanceChangeSpeedScale) * t;
    }
    // Still staggering off a hard landing.
    if (this.hardLandTimer > 0) {
      const t = clamp01(this.hardLandTimer / MOVE.hardLandRecover);
      speed *= 1 - (1 - MOVE.hardLandSpeedScale) * t;
    }

    // ---- Wish direction in world space, and the ground it points at --------
    this.wish.set(inX, 0, inZ);
    if (inLen > 0) this.wish.applyAxisAngle(UP, this.yaw);

    if (inLen > 0 && this.grounded) {
      speed *= this.sampleSlope();
      // Past the climb limit the legs get nothing. moveCapsule's step limit
      // still catches sheer walls, but at 60 Hz the body only advances 7 cm a
      // tick, so a 0.5 m step limit only ever refuses a near-vertical face —
      // everything shallower can be ratcheted up one tick at a time. This is
      // the graded version: past 50 degrees the legs simply get no speed.
      if (this.climbBlocked) speed = 0;
    } else {
      this.slopeTick = 0;
      this.slopeGrade = 0;
      this.gradeSustained = 0;
      this.climbBlocked = false;
    }

    // ---- Integrate horizontal velocity -------------------------------------
    if (this.grounded) {
      const accel = MOVE.crouchAccel + (MOVE.groundAccel - MOVE.crouchAccel) * stanceBlend;
      groundAccelerate(
        this.velocity,
        this.wish.x,
        this.wish.z,
        speed,
        accel,
        MOVE.groundBrake,
        MOVE.turnBrake,
        dt
      );
    } else {
      airAccelerate(this.velocity, this.wish.x, this.wish.z, speed, MOVE.airAccel, MOVE.airDrag, dt);
    }

    // ---- Jump ---------------------------------------------------------------
    if (
      this.input.wasPressed('jump') &&
      this.grounded &&
      !this.crouched &&
      this.jumpTimer <= 0 &&
      this.stanceTimer <= 0
    ) {
      this.vy = MOVE.jumpSpeed;
      this.grounded = false;
      this.airTime = 0;
      this.jumpTimer = MOVE.jumpCooldown;
      this.fallPeakY = this.position.y;
      this.onJump?.();
    }

    // ---- Move ---------------------------------------------------------------
    const wasGrounded = this.grounded;
    const dx = this.velocity.x * dt;
    const dz = this.velocity.z * dt;
    const beforeX = this.position.x;
    const beforeZ = this.position.z;
    // Step limit scales with the stance: standing you can take a kerb,
    // crouched you cannot hoist yourself over anything.
    const maxStep = MOVE.stepUpCrouch + (MOVE.stepUpStand - MOVE.stepUpCrouch) * stanceBlend;

    const res = this.world.moveCapsule(
      this.position,
      this.delta.set(dx, 0, dz),
      this.vy,
      dt,
      MOVE.radius,
      maxStep
    );
    this.position.copy(res.pos);
    this.vy = res.vy;
    let grounded = res.grounded;

    // Ground stick: moveCapsule applies gravity but never snaps DOWN to a
    // falling surface, so descending any slope past ~5 deg leaves the capsule
    // hanging a few millimetres in the air every single frame. Re-seat it,
    // but only just after having been grounded and only over a short reach, so
    // a genuine fall (and its damage) is untouched.
    if (!grounded && this.vy <= 0 && this.airTime <= MOVE.groundStickTime) {
      const gh = this.world.hf.height(this.position.x, this.position.z);
      if (this.position.y - gh <= MOVE.groundStickDist) {
        this.position.y = gh;
        this.vy = 0;
        grounded = true;
      }
    }
    this.grounded = grounded;
    this.airTime = grounded ? 0 : this.airTime + dt;

    // Reconcile: moveCapsule accepts or refuses each horizontal axis whole, so
    // an axis that did not move is an axis whose momentum just met a wall.
    // Without this the body keeps "running" into geometry at full speed and
    // the weapon's movement spread stays wide while you stand still.
    const movedX = this.position.x - beforeX;
    const movedZ = this.position.z - beforeZ;
    if (dx !== 0 && Math.abs(movedX) < Math.abs(dx) * 0.5) this.velocity.x = 0;
    if (dz !== 0 && Math.abs(movedZ) < Math.abs(dz) * 0.5) this.velocity.z = 0;

    this.velocity.y = this.vy;
    this.speed2D = Math.hypot(this.velocity.x, this.velocity.z);

    // ---- Fall tracking + landing -------------------------------------------
    if (!this.grounded) {
      if (this.position.y > this.fallPeakY) this.fallPeakY = this.position.y;
    } else {
      if (!wasGrounded) {
        // Apex to touchdown is pure free fall, so the drop gives the exact
        // impact speed without having to trust vy bookkeeping across the snap.
        this.onTouchdown(Math.max(0, this.fallPeakY - this.position.y));
      }
      this.fallPeakY = this.position.y;
    }

    // ---- Gait phase (drives both the head bob and the footstep events) -----
    if (this.grounded && this.speed2D > 0.35) {
      const stride = this.isSprinting
        ? MOVE.strideSprint
        : this.crouched
          ? MOVE.strideCrouch
          : MOVE.strideWalk;
      const before = this.gaitTotal;
      this.gaitTotal += Math.hypot(movedX, movedZ) / stride;
      if (Math.floor(this.gaitTotal) > Math.floor(before)) this.stepCount++;
      // Wrapped modulo 2 (one stride = two footfalls) so the lateral sway,
      // which runs at half the step rate, stays continuous across the wrap.
      if (this.gaitTotal >= 2) this.gaitTotal -= 2;
      this.gaitPhase01 = this.gaitTotal % 1;
    }

    // ---- Move state ---------------------------------------------------------
    this.moveState = !this.grounded
      ? 'air'
      : this.crouched
        ? 'crouch'
        : this.isSprinting
          ? 'sprint'
          : this.speed2D > 0.35
            ? 'walk'
            : 'idle';

    // ---- Lean ---------------------------------------------------------------
    // Leaning while sprinting is not something a running body does.
    const leanTarget = this.isSprinting
      ? 0
      : (this.input.isDown('leanRight') ? 1 : 0) - (this.input.isDown('leanLeft') ? 1 : 0);
    this.leanAmount += (leanTarget - this.leanAmount) * Math.min(1, dt * MOVE.leanRate);

    this.lastSimPos.copy(this.position);
  }

  /**
   * Slope speed multiplier along the direction of travel, and the climb gate.
   * Two probes: the NEAR one catches a lip you could step over, the FAR one
   * catches a sustained face. The speed penalty takes the worse of the two
   * (a step does cost you); the climb block takes the BETTER of the two, so a
   * boulder within the step limit never wedges you in place while a real
   * hillside still refuses.
   */
  private sampleSlope(): number {
    if (this.slopeTick <= 0) {
      this.slopeTick = MOVE.slopeProbeTicks;
      const h0 = this.world.hf.height(this.position.x, this.position.z);
      this.probe.copy(this.position).addScaledVector(this.wish, MOVE.slopeProbeNear);
      const gNear = (this.world.hf.height(this.probe.x, this.probe.z) - h0) / MOVE.slopeProbeNear;
      this.probe.copy(this.position).addScaledVector(this.wish, MOVE.slopeProbeFar);
      const gFar = (this.world.hf.height(this.probe.x, this.probe.z) - h0) / MOVE.slopeProbeFar;
      this.slopeGrade = Math.max(gNear, gFar);
      this.gradeSustained = Math.min(gNear, gFar);
    }
    this.slopeTick--;
    this.climbBlocked = this.gradeSustained > MOVE.slopeClimbMaxTan;
    return slopeSpeedScale(
      this.slopeGrade,
      MOVE.slopeGentleTan,
      MOVE.slopeSteepTan,
      MOVE.slopeUphillMinScale,
      MOVE.slopeDownhillBoost
    );
  }

  private onTouchdown(drop: number): void {
    const impact = impactSpeedForDrop(drop, MOVE.gravity);
    this.lastFallDrop = drop;
    this.landingImpact01 = clamp01(
      (drop - MOVE.landDipMinDrop) / Math.max(1e-3, MOVE.landDipFullDrop - MOVE.landDipMinDrop)
    );

    // Camera: an impulse into the dip spring, scaled by how hard it was.
    this.dip.v -= MOVE.landDipImpulse * this.landingImpact01;

    if (drop >= MOVE.hardLandDrop) {
      this.hardLandTimer = MOVE.hardLandRecover;
      this.velocity.x *= MOVE.hardLandMomentumScale;
      this.velocity.z *= MOVE.hardLandMomentumScale;
      this.speed2D = Math.hypot(this.velocity.x, this.velocity.z);
    }

    const dmg = fallDamageFor(
      impact,
      impactSpeedForDrop(MOVE.fallSafeDrop, MOVE.gravity),
      impactSpeedForDrop(MOVE.fallLethalDrop, MOVE.gravity),
      MOVE.fallMaxDamage
    );
    if (dmg > 0) this.onFallDamage?.(dmg, impact);

    this.onLand?.(impact, this.landingImpact01);
  }

  update(dt: number): void {
    // Mouse look (per render frame for responsiveness)
    const look = this.input.consumeLook();
    const sens = this.ads ? MOVE.lookSensAds : MOVE.lookSens;
    this.yaw -= look.dx * sens;
    this.pitch -= look.dy * sens;
    this.pitch = Math.max(-MOVE.pitchLimit, Math.min(MOVE.pitchLimit, this.pitch));

    // ---- Head bob, from the actual gait -------------------------------------
    // The phase is advanced by DISTANCE TRAVELLED in fixedUpdate, so the bob is
    // locked to real ground speed: walk into a wall and it stops, run downhill
    // and it quickens, and every footstep sound lands on a dip.
    const refSpeed = this.isSprinting ? MOVE.sprintSpeed : MOVE.walkSpeed;
    const speedRatio = clamp01(this.speed2D / refSpeed);
    const bobScale = this.grounded ? speedRatio * (this.ads ? MOVE.bobAdsScale : 1) : 0;
    const bobY = -MOVE.bobAmplitudeY * bobScale * (1 + Math.cos(2 * Math.PI * this.gaitPhase01)) * 0.5;
    const bobX = MOVE.bobAmplitudeX * bobScale * Math.sin(Math.PI * this.gaitTotal);

    // ---- Landing dip (critically damped spring back to rest) ---------------
    springStep(this.dip, 0, MOVE.landDipFreq, dt);

    // ---- Strafe roll --------------------------------------------------------
    // Lateral velocity relative to where the camera looks: the body banks into
    // a side-step. Sprung, so the tilt lags the input slightly.
    // Camera right at this yaw is (cos yaw, 0, -sin yaw).
    const lateral = this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw);
    const rollTarget =
      -THREE.MathUtils.degToRad(MOVE.strafeRollDeg) *
      Math.max(-1, Math.min(1, lateral / MOVE.walkSpeed));
    springStep(this.rollSpring, rollTarget, MOVE.strafeRollFreq, dt);

    // ---- Sprint FOV kick ----------------------------------------------------
    // Rides the wind-up rather than the boolean, so the lens opens with the legs.
    const kickTarget = MOVE.sprintFovKick * smoothstep01(this.sprintCharge01);
    this.fovKick += (kickTarget - this.fovKick) * Math.min(1, dt * 8);
    const adsFovScale = this.ads ? 0.62 : 1;
    const wantFov = (this.baseFov + this.fovKick) * adsFovScale;
    if (Math.abs(this.camera.fov - wantFov) > 0.05) {
      this.camera.fov += (wantFov - this.camera.fov) * Math.min(1, dt * 14);
      this.camera.updateProjectionMatrix();
    }

    // ---- Compose the camera -------------------------------------------------
    const leanOffset = this.leanAmount * MOVE.leanOffset;
    this.euler.set(
      this.pitch + this.dip.x * MOVE.landDipPitchPerM,
      this.yaw,
      this.rollSpring.x - this.leanAmount * MOVE.leanRoll
    );
    this.camera.quaternion.setFromEuler(this.euler);
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.camera.position.set(
      this.position.x + this.right.x * (leanOffset + bobX),
      this.position.y + this.eye + bobY + this.dip.x,
      this.position.z + this.right.z * (leanOffset + bobX)
    );
  }
}
