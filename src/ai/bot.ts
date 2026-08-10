import * as THREE from 'three';
import { buildCharacter, poseCharacter, type CharacterRig } from '../gen/charactergen';
import { hash2 } from '../gen/noise';
import type { PhysicsWorld } from '../player/physics';
import type { Ballistics } from '../weapons/ballistics';

// BR bot: patrol -> alert -> engage -> flee-zone state machine, staggered
// perception raycasts, distance-scaled aim error, burst fire discipline.

export type BotState = 'patrol' | 'alert' | 'engage' | 'fleezone' | 'dead';

const WALK = 3.4;
const RUN = 5.6;
const VIEW_RANGE = 260;
const VIEW_COS = Math.cos(THREE.MathUtils.degToRad(62)); // ~124deg cone
const ENGAGE_RANGE = 190;
const BURST_MIN = 2;
const BURST_MAX = 5;

// --- lethality -------------------------------------------------------------
// A bot that never misses is not difficulty, it is a coin flip the player loses.
// These three numbers are the whole balance: the aim cone, how fast it tightens
// once a fight starts, and how hard a single round lands.
/** Base aim cone, radians (~1.4 deg). */
const ERR_BASE = 0.025;
/** Extra cone per metre of range. */
const ERR_PER_M = 0.00035;
/** Seconds a bot spends acquiring before its aim tightens to ERR_BASE. */
const REACTION_S = 0.55;
/** Per-round damage. 41 meant a 3-round burst killed from full health. */
const BOT_DAMAGE = 24;

export interface BotTargetInfo {
  position: THREE.Vector3; // eye position of the target (player)
  velocity: THREE.Vector3;
  alive: boolean;
}

export class Bot {
  readonly rig: CharacterRig;
  readonly pos: THREE.Vector3;
  state: BotState = 'patrol';
  hp = 100;
  capsuleId: number;
  private vy = 0;
  private yaw: number;
  private walkPhase = 0;
  private speed01 = 0;
  private wanderTarget = new THREE.Vector3();
  private wanderTimer = 0;
  private alertPoint: THREE.Vector3 | null = null;
  private alertTimer = 0;
  private perceptionClock: number;
  private burstLeft = 0;
  private burstCooldown = 0;
  private shotInterval = 0;
  private aimPitch = 0;
  /** Seconds this bot has been continuously engaging; drives aim settling. */
  private engageT = 0;
  private deadT = 0;
  private strafeDir = 1;
  private strafeTimer = 0;
  private lastSeenTarget = new THREE.Vector3();
  private crouch = 0;
  readonly id: number;

  constructor(
    id: number,
    spawn: THREE.Vector3,
    private world: PhysicsWorld,
    private ballistics: Ballistics
  ) {
    this.id = id;
    this.rig = buildCharacter(1000 + id * 17);
    this.pos = spawn.clone();
    this.yaw = hash2(id, 77) * Math.PI * 2;
    this.perceptionClock = hash2(id, 3) * 0.25; // stagger raycasts across bots
    this.capsuleId = world.addCapsule(this.pos, 0.36, 1.72, `bot:${id}`);
    this.pickWanderTarget();
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  damage(amount: number): void {
    if (!this.alive) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.state = 'dead';
      this.world.updateCapsule(this.capsuleId, this.pos, false);
    } else if (this.state === 'patrol') {
      this.state = 'alert';
      this.alertTimer = 8;
    }
  }

  hearShot(from: THREE.Vector3): void {
    if (!this.alive || this.state === 'engage') return;
    if (from.distanceTo(this.pos) < 220) {
      this.alertPoint = from.clone();
      this.alertTimer = 10;
      if (this.state === 'patrol') this.state = 'alert';
    }
  }

  fixedUpdate(
    dt: number,
    target: BotTargetInfo,
    zoneCenter: THREE.Vector3,
    zoneRadius: number,
    onShoot: (from: THREE.Vector3) => void
  ): void {
    if (this.state === 'dead') {
      this.deadT = Math.min(1, this.deadT + dt);
      this.pose();
      return;
    }

    // Zone pressure overrides everything except an active fight.
    const distToZone = Math.hypot(this.pos.x - zoneCenter.x, this.pos.z - zoneCenter.z);
    if (distToZone > zoneRadius - 12 && this.state !== 'engage') {
      this.state = 'fleezone';
    }

    // Perception tick (4Hz, staggered)
    this.perceptionClock -= dt;
    let seesTarget = false;
    if (this.perceptionClock <= 0) {
      this.perceptionClock = 0.25;
      seesTarget = this.checkVision(target);
      if (seesTarget) {
        if (this.state !== 'engage') this.engageT = 0;   // fresh acquisition
        this.state = 'engage';
        this.lastSeenTarget.copy(target.position);
        this.alertTimer = 6;
      } else if (this.state === 'engage') {
        this.alertTimer -= 0.25;
        if (this.alertTimer <= 0 || !target.alive) {
          this.state = distToZone > zoneRadius - 12 ? 'fleezone' : 'alert';
          this.alertPoint = this.lastSeenTarget.clone();
          this.alertTimer = 8;
        }
      }
    }

    switch (this.state) {
      case 'patrol':
        this.doPatrol(dt);
        break;
      case 'alert':
        this.doAlert(dt);
        break;
      case 'engage':
        this.doEngage(dt, target, onShoot);
        break;
      case 'fleezone':
        this.doFlee(dt, zoneCenter);
        break;
    }

    this.world.updateCapsule(this.capsuleId, this.pos);
    this.pose();
  }

  private checkVision(target: BotTargetInfo): boolean {
    if (!target.alive) return false;
    const eye = this.eye();
    const to = target.position.clone().sub(eye);
    const dist = to.length();
    if (dist > VIEW_RANGE) return false;
    to.normalize();
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    if (this.state !== 'engage' && to.dot(fwd) < VIEW_COS * (dist < 12 ? 0.2 : 1)) return false;
    const hit = this.world.raycast(eye, to, dist - 0.6, this.capsuleId);
    return hit === null || hit.tag === 'player' || hit.tag === 'head:player';
  }

  private eye(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x, this.pos.y + 1.6 - this.crouch * 0.5, this.pos.z);
  }

  private moveToward(dt: number, tx: number, tz: number, speed: number): number {
    const dx = tx - this.pos.x;
    const dz = tz - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.5) {
      this.speed01 = 0;
      return dist;
    }
    const targetYaw = Math.atan2(dx, dz);
    let dYaw = targetYaw - this.yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.yaw += THREE.MathUtils.clamp(dYaw, -3.2 * dt, 3.2 * dt);

    const step = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(speed * dt);
    const res = this.world.moveCapsule(this.pos, step, this.vy, dt, 0.36);
    if (res.blocked) {
      // Obstacle: veer using a deterministic side preference.
      this.yaw += (hash2(this.id, Math.floor(this.pos.x)) > 0.5 ? 1 : -1) * 1.8 * dt;
    }
    this.pos.copy(res.pos);
    this.vy = res.vy;
    this.speed01 = Math.min(speed / RUN, 1);
    this.walkPhase += dt * (5 + this.speed01 * 6);
    return dist;
  }

  private pickWanderTarget(): void {
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = hash2(this.id, this.wanderTimer * 31 + attempt) * Math.PI * 2;
      const r = 30 + hash2(this.id + 5, this.wanderTimer * 17 + attempt) * 90;
      const x = this.pos.x + Math.sin(a) * r;
      const z = this.pos.z + Math.cos(a) * r;
      if (this.world.hf.walkable(x, z)) {
        this.wanderTarget.set(x, 0, z);
        return;
      }
    }
    this.wanderTarget.set(this.pos.x, 0, this.pos.z);
  }

  private doPatrol(dt: number): void {
    this.wanderTimer -= dt;
    const dist = this.moveToward(dt, this.wanderTarget.x, this.wanderTarget.z, WALK * 0.8);
    if (dist < 2 || this.wanderTimer <= 0) {
      this.wanderTimer = 6 + hash2(this.id, this.pos.x + this.pos.z) * 8;
      this.pickWanderTarget();
    }
  }

  private doAlert(dt: number): void {
    this.alertTimer -= dt;
    if (this.alertPoint) {
      const dist = this.moveToward(dt, this.alertPoint.x, this.alertPoint.z, WALK);
      if (dist < 6) this.alertPoint = null;
    } else {
      // Scan around.
      this.yaw += dt * 0.9;
      this.speed01 = 0;
    }
    if (this.alertTimer <= 0) this.state = 'patrol';
  }

  private doEngage(dt: number, target: BotTargetInfo, onShoot: (from: THREE.Vector3) => void): void {
    this.engageT += dt;
    const eye = this.eye();
    const toTarget = target.position.clone().sub(eye);
    const dist = toTarget.length();

    // Face the target.
    this.yaw = Math.atan2(toTarget.x, toTarget.z);
    this.aimPitch = Math.atan2(toTarget.y, Math.hypot(toTarget.x, toTarget.z));

    // Positioning: close if far, strafe if in range, crouch sometimes.
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 1.2 + hash2(this.id, Math.floor(this.pos.z * 3)) * 1.6;
      this.strafeDir = hash2(this.id, Math.floor(this.pos.x * 7)) > 0.5 ? 1 : -1;
      this.crouch = dist > 60 && hash2(this.id + 9, Math.floor(this.pos.z)) > 0.6 ? 1 : 0;
    }
    if (dist > ENGAGE_RANGE * 0.85) {
      this.moveToward(dt, target.position.x, target.position.z, RUN);
    } else if (this.crouch < 0.5) {
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const step = right.multiplyScalar(this.strafeDir * WALK * 0.7 * dt);
      const res = this.world.moveCapsule(this.pos, step, this.vy, dt, 0.36);
      this.pos.copy(res.pos);
      this.vy = res.vy;
      this.speed01 = 0.4;
      this.walkPhase += dt * 7;
    } else {
      this.speed01 = 0;
    }

    // Fire discipline: bursts with cooldowns, error scaled by distance+motion.
    this.burstCooldown -= dt;
    this.shotInterval -= dt;
    // Human reaction time before the first round of an engagement. Without it a
    // bot that rounds a corner fires on the same frame it acquires.
    if (dist < ENGAGE_RANGE && this.engageT > REACTION_S && this.burstCooldown <= 0) {
      if (this.burstLeft <= 0) {
        this.burstLeft = BURST_MIN + Math.floor(hash2(this.id, this.walkPhase) * (BURST_MAX - BURST_MIN + 1));
      }
      if (this.shotInterval <= 0 && this.burstLeft > 0) {
        this.shotInterval = 0.1;
        this.burstLeft--;
        if (this.burstLeft === 0) this.burstCooldown = 0.7 + hash2(this.id + 3, this.walkPhase) * 1.1;

        // Aim error in RADIANS: a base cone, widened with range and by the
        // bot's own movement, and widened hard for the first moments of an
        // engagement so a fight opens with suppressing fire rather than an
        // instant kill. Tuned so a competent player can win a 1v1 at 20 m.
        const settle = 1 + 2.4 * Math.max(0, 1 - this.engageT / 1.6);
        const err = (ERR_BASE + dist * ERR_PER_M) * (1 + this.speed01 * 1.2) * settle;
        const h1 = hash2(this.id * 3, Math.floor(this.walkPhase * 100));
        const h2 = hash2(this.id * 5 + 1, Math.floor(this.walkPhase * 100));
        const aim = toTarget.normalize().clone();
        const right = new THREE.Vector3(aim.z, 0, -aim.x).normalize();
        const up = new THREE.Vector3().crossVectors(right, aim);
        // ANGULAR error, applied to a unit aim vector. The old form multiplied
        // by `dist * 0.02`, which at 14 m collapsed the spread to about two
        // MILLIMETRES: every bot was a perfect shot and killed the player in a
        // single burst before they could react. A radian offset here is a real
        // cone — at ERR_BASE it is roughly a 0.5 m spread at 25 m.
        aim.addScaledVector(right, (h1 - 0.5) * 2 * err)
          .addScaledVector(up, (h2 - 0.5) * 2 * err)
          .normalize();
        const muzzle = eye.clone().addScaledVector(aim, 0.5);
        this.ballistics.fire(muzzle, aim, 715, BOT_DAMAGE, this.capsuleId);
        onShoot(eye);
      }
    }
  }

  private doFlee(dt: number, zoneCenter: THREE.Vector3): void {
    const dist = this.moveToward(dt, zoneCenter.x, zoneCenter.z, RUN);
    const distToZone = Math.hypot(this.pos.x - zoneCenter.x, this.pos.z - zoneCenter.z);
    if (dist < 20 || distToZone < 40) this.state = 'patrol';
  }

  private pose(): void {
    this.rig.root.position.copy(this.pos);
    this.rig.root.rotation.y = this.yaw;
    poseCharacter(this.rig, {
      walkPhase: this.walkPhase,
      speed01: this.speed01,
      aimPitch: this.aimPitch,
      crouch: this.crouch,
      dead: this.deadT,
    });
  }
}
