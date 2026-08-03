import * as THREE from 'three';
import { hash2 } from '../gen/noise';
import { HALF } from '../gen/terraingen';

// PUBG-style phased circle: wait, then shrink toward a target circle chosen
// inside the current one. Compressed pacing for ~7 minute matches.

interface Phase {
  wait: number;
  shrink: number;
  factor: number; // next radius = current * factor
  dps: number;
}

const PHASES: Phase[] = [
  { wait: 50, shrink: 80, factor: 0.62, dps: 0.6 },
  { wait: 35, shrink: 55, factor: 0.58, dps: 1.5 },
  { wait: 28, shrink: 40, factor: 0.55, dps: 3.5 },
  { wait: 22, shrink: 30, factor: 0.5, dps: 6 },
  { wait: 18, shrink: 22, factor: 0.45, dps: 9 },
  { wait: 14, shrink: 18, factor: 0.0, dps: 14 },
];

export class ZoneController {
  center = new THREE.Vector3(0, 0, 0);
  radius = HALF * 1.15;
  targetCenter = new THREE.Vector3();
  targetRadius = 0;
  phaseIndex = 0;
  private t = 0;
  private shrinking = false;
  private startCenter = new THREE.Vector3();
  private startRadius = 0;
  finished = false;

  constructor(seed = 7) {
    this.pickTarget(seed);
  }

  private pickTarget(salt: number): void {
    const p = PHASES[this.phaseIndex];
    this.targetRadius = this.radius * p.factor;
    // Deterministic offset inside the current circle, biased to stay on land.
    const maxOff = Math.max(0, this.radius - this.targetRadius) * 0.7;
    const a = hash2(this.phaseIndex * 13 + salt, 1) * Math.PI * 2;
    const r = hash2(this.phaseIndex * 13 + salt, 2) * maxOff;
    this.targetCenter.set(
      THREE.MathUtils.clamp(this.center.x + Math.sin(a) * r, -HALF * 0.5, HALF * 0.5),
      0,
      THREE.MathUtils.clamp(this.center.z + Math.cos(a) * r, -HALF * 0.5, HALF * 0.5)
    );
  }

  get dps(): number {
    return PHASES[Math.min(this.phaseIndex, PHASES.length - 1)].dps;
  }

  /** Seconds until the current wait ends (0 while shrinking). */
  get countdown(): number {
    if (this.shrinking) return 0;
    return Math.max(0, PHASES[this.phaseIndex].wait - this.t);
  }

  get isShrinking(): boolean {
    return this.shrinking;
  }

  update(dt: number): void {
    if (this.finished) return;
    const p = PHASES[this.phaseIndex];
    this.t += dt;
    if (!this.shrinking) {
      if (this.t >= p.wait) {
        this.shrinking = true;
        this.t = 0;
        this.startCenter.copy(this.center);
        this.startRadius = this.radius;
      }
    } else {
      const k = Math.min(1, this.t / p.shrink);
      this.center.lerpVectors(this.startCenter, this.targetCenter, k);
      this.radius = THREE.MathUtils.lerp(this.startRadius, this.targetRadius, k);
      if (k >= 1) {
        this.shrinking = false;
        this.t = 0;
        this.phaseIndex++;
        if (this.phaseIndex >= PHASES.length) {
          this.finished = true;
        } else {
          this.pickTarget(this.phaseIndex * 31);
        }
      }
    }
  }

  /** Damage per second applied to something at (x, z), 0 if inside. */
  damageAt(x: number, z: number): number {
    const d = Math.hypot(x - this.center.x, z - this.center.z);
    return d > this.radius ? this.dps : 0;
  }
}
