import * as THREE from 'three';
import type { System } from '../core/engine';
import type { Input } from '../core/input';
import type { PlayerController } from '../player/controller';
import type { Ballistics } from './ballistics';

// AKM-class automatic rifle: 600rpm, PUBG-style recoil pattern (hard vertical
// early climb settling into horizontal jitter), first-shot accuracy, bloom
// under sustained hip fire, magazine + reload state machine.

export type WeaponPhase = 'idle' | 'reloading';

const RPM = 600;
const FIRE_INTERVAL = 60 / RPM;
const MUZZLE_SPEED = 715;
const BASE_DAMAGE = 47;
const MAG_SIZE = 30;
const RELOAD_S = 2.9;

// Vertical/horizontal recoil per shot (degrees), indexed by burst position.
const RECOIL_V = [0.55, 0.62, 0.68, 0.72, 0.75, 0.75, 0.72, 0.7, 0.68, 0.66];
const RECOIL_H_SPREAD = [0.05, 0.08, 0.12, 0.18, 0.25, 0.3, 0.34, 0.36, 0.38, 0.4];

export class Weapon implements System {
  phase: WeaponPhase = 'idle';
  ammo = MAG_SIZE;
  reserve = 120;
  private cooldown = 0;
  private reloadT = 0;
  private burst = 0;
  private burstDecay = 0;
  private bloom = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private seedT = 0;
  /** Fired this frame — viewmodel/audio hooks. */
  onShot: (() => void) | null = null;
  onReloadStart: (() => void) | null = null;
  onDryFire: (() => void) | null = null;
  ownerCapsuleId = -1;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private input: Input,
    private player: PlayerController,
    private ballistics: Ballistics
  ) {}

  fixedUpdate(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.seedT += dt;

    // ADS state (hold RMB)
    this.player.ads = this.input.mouseDown[2] && this.phase !== 'reloading';

    // Reload
    if (this.phase === 'reloading') {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        const take = Math.min(MAG_SIZE - this.ammo, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this.phase = 'idle';
      }
    } else if ((this.input.wasPressed('reload') && this.ammo < MAG_SIZE && this.reserve > 0)) {
      this.phase = 'reloading';
      this.reloadT = RELOAD_S;
      this.onReloadStart?.();
    }

    // Burst decay + recoil recovery
    this.burstDecay -= dt;
    if (this.burstDecay <= 0) this.burst = Math.max(0, this.burst - 1);
    this.bloom = Math.max(0, this.bloom - dt * 1.8);
    const recover = Math.min(1, dt * 7);
    this.recoilPitch *= 1 - recover;
    this.recoilYaw *= 1 - recover;

    // Trigger
    if (this.input.mouseDown[0] && this.phase === 'idle' && this.cooldown === 0 && this.input.isLocked) {
      if (this.ammo <= 0) {
        this.cooldown = 0.22;
        this.onDryFire?.();
      } else {
        this.fireOnce();
      }
    }
  }

  private fireOnce(): void {
    this.ammo--;
    this.cooldown = FIRE_INTERVAL;

    // Spread: first-shot accurate; hip fire and movement bloom it open.
    const moveFactor = Math.min(this.player.speed2D / 6.4, 1);
    const hipPenalty = this.player.ads ? 0 : 1.6;
    const spreadDeg =
      0.06 + this.bloom * 0.5 + moveFactor * 0.5 + hipPenalty * (0.5 + this.bloom * 0.4);

    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    // Deterministic-ish jitter from a time hash (no Math.random in sim paths).
    const j1 = fract(Math.sin(this.seedT * 991.7) * 43758.5453);
    const j2 = fract(Math.sin(this.seedT * 771.3 + 17.1) * 24634.6345);
    const spread = THREE.MathUtils.degToRad(spreadDeg);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    dir.addScaledVector(right, (j1 - 0.5) * 2 * spread).addScaledVector(up, (j2 - 0.5) * 2 * spread).normalize();

    const origin = this.camera.position.clone().addScaledVector(dir, 0.4);
    this.ballistics.fire(origin, dir, MUZZLE_SPEED, BASE_DAMAGE, this.ownerCapsuleId);

    // Camera recoil kick (applied in update via player yaw/pitch).
    const idx = Math.min(this.burst, RECOIL_V.length - 1);
    const adsScale = this.player.ads ? 0.82 : 1;
    const kickV = THREE.MathUtils.degToRad(RECOIL_V[idx]) * adsScale;
    const kickH = THREE.MathUtils.degToRad(RECOIL_H_SPREAD[idx]) * (j1 > 0.5 ? 1 : -1) * adsScale;
    this.player.pitch += kickV;
    this.player.yaw += kickH;
    this.recoilPitch += kickV;
    this.recoilYaw += kickH;

    this.burst = Math.min(this.burst + 1, RECOIL_V.length - 1);
    this.burstDecay = 0.25;
    this.bloom = Math.min(this.bloom + 0.25, 1.2);
    this.onShot?.();
  }

  get reloadProgress(): number {
    return this.phase === 'reloading' ? 1 - this.reloadT / RELOAD_S : 0;
  }
}

function fract(v: number): number {
  return v - Math.floor(v);
}
