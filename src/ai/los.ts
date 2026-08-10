import * as THREE from 'three';
import type { PhysicsWorld } from '../player/physics';
import type { Heightfield } from '../gen/terraingen';

// The one place a line-of-sight ray is cast. Everything that wants to know
// whether A can see B goes through here so the cost is visible in one file and
// the semantics (what counts as "blocked") never drift between perception and
// the cover query.

const _dir = new THREE.Vector3();

/**
 * Cheap terrain-only occlusion test: does the ground rise through this line?
 *
 * A full PhysicsWorld.raycast marches the heightfield AND tests every one of
 * ~3000 tree and building AABBs, which is roughly ten times the cost of walking
 * the ground profile alone. On this map a large share of long sight lines are
 * blocked by terrain, so asking the cheap question first and only paying for
 * the expensive one when the ground is clear is most of the AI's ray budget
 * back.
 *
 * One-sided on purpose: `true` means definitely blocked, `false` means "the
 * ground did not stop it, go and check properly". Sampling can step over a
 * knife-edge ridge, and that costs a ray, not a wrong answer.
 */
export function terrainBlocks(hf: Heightfield, from: THREE.Vector3, to: THREE.Vector3): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 3) return false;
  const n = Math.min(20, Math.max(5, Math.round(dist / 11)));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (hf.height(from.x + dx * t, from.z + dz * t) > from.y + dy * t + 0.25) return true;
  }
  return false;
}

/**
 * True when nothing solid stands between `from` and `to`.
 *
 * The ray stops `slack` metres short of the destination so the target's own
 * capsule cannot block the shot to itself, and so a phantom aim point (the
 * cover query's "would I be seen from here") works without a body to hit.
 * A capsule hit belonging to `allowCapsuleId` also counts as clear — that is
 * the target standing in its own doorway.
 */
export function losClear(
  world: PhysicsWorld,
  from: THREE.Vector3,
  to: THREE.Vector3,
  skipCapsuleId = -1,
  allowCapsuleId = -1,
  slack = 0.55
): boolean {
  _dir.subVectors(to, from);
  const dist = _dir.length();
  if (dist < 0.001) return true;
  _dir.divideScalar(dist);
  const hit = world.raycast(from, _dir, Math.max(0.1, dist - slack), skipCapsuleId);
  if (hit === null) return true;
  return hit.kind === 'capsule' && hit.id === allowCapsuleId;
}

/**
 * What is between `from` and `to`, or null when the path is clear. Used by the
 * cover query, which cares about the DIFFERENCE between "a tree blocks this"
 * (concealment worth standing behind) and "the ground blocks this" (a fold in
 * the terrain, equally good and much more common on this map).
 */
export function losBlocker(
  world: PhysicsWorld,
  from: THREE.Vector3,
  to: THREE.Vector3,
  skipCapsuleId = -1,
  slack = 0.55
): string | null {
  _dir.subVectors(to, from);
  const dist = _dir.length();
  if (dist < 0.001) return null;
  _dir.divideScalar(dist);
  const hit = world.raycast(from, _dir, Math.max(0.1, dist - slack), skipCapsuleId);
  if (hit === null) return null;
  if (hit.kind === 'capsule') return null; // bodies do not stop bullets reliably
  return hit.tag;
}
