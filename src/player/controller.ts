import * as THREE from 'three';
import type { System } from '../core/engine';
import type { Input } from '../core/input';
import type { PhysicsWorld } from './physics';

// PUBG-feel first-person movement: walk/sprint/crouch/jump, smooth stance
// transitions, sprint FOV kick, subtle headbob, lean framework (Q/E).

const WALK = 4.3;
const SPRINT = 6.4;
const CROUCH = 2.1;
const ADS_FACTOR = 0.62;
const JUMP_V = 7.2;
const EYE_STAND = 1.68;
const EYE_CROUCH = 1.05;
const RADIUS = 0.38;

export class PlayerController implements System {
  readonly position: THREE.Vector3; // foot position
  yaw = 0;
  pitch = 0;
  private vy = 0;
  private grounded = true;
  private crouched = false;
  private eye = EYE_STAND;
  private bobPhase = 0;
  private baseFov: number;
  private fovKick = 0;
  private leanAmount = 0; // -1..1
  /** Set by the weapon system each frame; slows movement while aiming. */
  ads = false;
  /** Movement state the weapon/audio systems read. */
  speed2D = 0;
  isSprinting = false;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private input: Input,
    private world: PhysicsWorld,
    spawn: THREE.Vector3
  ) {
    this.position = spawn.clone();
    this.baseFov = camera.fov;
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
  }

  fixedUpdate(dt: number): void {
    // Stance
    if (this.input.wasPressed('crouch')) this.crouched = !this.crouched;

    const wishDir = new THREE.Vector3();
    if (this.input.isDown('forward')) wishDir.z -= 1;
    if (this.input.isDown('back')) wishDir.z += 1;
    if (this.input.isDown('left')) wishDir.x -= 1;
    if (this.input.isDown('right')) wishDir.x += 1;

    const movingForward = wishDir.z < 0;
    this.isSprinting =
      this.input.isDown('sprint') && movingForward && !this.crouched && !this.ads && this.grounded;

    let speed = this.crouched ? CROUCH : this.isSprinting ? SPRINT : WALK;
    if (this.ads) speed *= ADS_FACTOR;

    if (wishDir.lengthSq() > 0) {
      wishDir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    }
    const delta = wishDir.multiplyScalar(speed * dt);

    if (this.input.wasPressed('jump') && this.grounded && !this.crouched) {
      this.vy = JUMP_V;
      this.grounded = false;
    }

    const res = this.world.moveCapsule(this.position, delta, this.vy, dt, RADIUS);
    this.position.copy(res.pos);
    this.vy = res.vy;
    this.grounded = res.grounded;
    this.speed2D = delta.length() / dt;

    // Lean
    const leanTarget = (this.input.isDown('leanRight') ? 1 : 0) - (this.input.isDown('leanLeft') ? 1 : 0);
    this.leanAmount += (leanTarget - this.leanAmount) * Math.min(1, dt * 12);
  }

  update(dt: number): void {
    // Mouse look (per render frame for responsiveness)
    const look = this.input.consumeLook();
    const sens = this.ads ? 0.0011 : 0.0021;
    this.yaw -= look.dx * sens;
    this.pitch -= look.dy * sens;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));

    // Eye height + bob
    const targetEye = this.crouched ? EYE_CROUCH : EYE_STAND;
    this.eye += (targetEye - this.eye) * Math.min(1, dt * 10);
    const speedRatio = Math.min(this.speed2D / SPRINT, 1);
    if (this.grounded && this.speed2D > 0.5) {
      this.bobPhase += dt * (6 + speedRatio * 6);
    }
    const bobY = Math.sin(this.bobPhase * 2) * 0.018 * speedRatio * (this.ads ? 0.3 : 1);
    const bobX = Math.cos(this.bobPhase) * 0.012 * speedRatio * (this.ads ? 0.3 : 1);

    // Sprint FOV kick
    const kickTarget = this.isSprinting ? 6 : 0;
    this.fovKick += (kickTarget - this.fovKick) * Math.min(1, dt * 8);
    const adsFovScale = this.ads ? 0.62 : 1;
    const wantFov = (this.baseFov + this.fovKick) * adsFovScale;
    if (Math.abs(this.camera.fov - wantFov) > 0.05) {
      this.camera.fov += (wantFov - this.camera.fov) * Math.min(1, dt * 14);
      this.camera.updateProjectionMatrix();
    }

    // Lean: lateral offset + roll
    const leanOffset = this.leanAmount * 0.32;
    const roll = -this.leanAmount * 0.13;

    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, roll, 'YXZ'));
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.camera.position.set(
      this.position.x + right.x * (leanOffset + bobX),
      this.position.y + this.eye + bobY,
      this.position.z + right.z * (leanOffset + bobX)
    );
  }
}
