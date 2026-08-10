import * as THREE from 'three';

// Who fired that?
//
// Ballistics carries an owner capsule id on every bullet but does not report it
// on a hit (BulletHit is {hit, damage, direction}), and ballistics.ts is not
// this lane's file to change. Without an answer to this question a bot killed
// by another bot has no killer, and the kill feed can only ever say "you".
//
// So every shot is registered as it leaves the muzzle and matched back
// geometrically when it lands: a hit belongs to the pending ray whose direction
// agrees with the bullet's and whose line passes through the impact point.
// Gravity bends the path down by ~0.4 m at 200 m, which is why the tolerance is
// metres rather than centimetres, and entries expire after the longest possible
// flight so the table stays a handful of rows.

interface PendingShot {
  owner: number; // shooter capsule id
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  t: number;
}

const LIFETIME = 1.6; // 700 m of flight at 715 m/s, plus slack
const MAX_PERP = 3.0;
const MIN_DOT = 0.985;

export class ShotRegistry {
  private shots: PendingShot[] = [];
  private now = 0;

  register(owner: number, origin: THREE.Vector3, dir: THREE.Vector3): void {
    if (owner < 0) return;
    this.shots.push({
      owner,
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      t: this.now,
    });
    // Hard cap: a runaway list would be a slow leak in a long match.
    if (this.shots.length > 220) this.shots.splice(0, this.shots.length - 220);
  }

  update(dt: number): void {
    this.now += dt;
    const cutoff = this.now - LIFETIME;
    let w = 0;
    for (let i = 0; i < this.shots.length; i++) {
      if (this.shots[i].t >= cutoff) this.shots[w++] = this.shots[i];
    }
    this.shots.length = w;
  }

  /** Capsule id of the most likely shooter for this impact, or -1. */
  attribute(point: THREE.Vector3, dir: THREE.Vector3, victimCapsuleId: number): number {
    let best = -1;
    let bestScore = Infinity;
    for (const s of this.shots) {
      if (s.owner === victimCapsuleId) continue;
      const dot = s.dx * dir.x + s.dy * dir.y + s.dz * dir.z;
      if (dot < MIN_DOT) continue;
      // Perpendicular distance from the impact point to the firing line.
      const px = point.x - s.ox;
      const py = point.y - s.oy;
      const pz = point.z - s.oz;
      const along = px * s.dx + py * s.dy + pz * s.dz;
      if (along <= 0) continue;
      const perp = Math.hypot(px - s.dx * along, py - s.dy * along, pz - s.dz * along);
      if (perp > MAX_PERP) continue;
      const score = perp + (1 - dot) * 60 + (this.now - s.t) * 0.4;
      if (score < bestScore) {
        bestScore = score;
        best = s.owner;
      }
    }
    return best;
  }
}
