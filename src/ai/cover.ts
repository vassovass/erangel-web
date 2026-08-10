import * as THREE from 'three';
import { losBlocker, terrainBlocks } from './los';
import type { AiContext, Combatant, DetRng } from './types';
import type { BotProfile } from './profiles';

// Cover.
//
// PhysicsWorld keeps its collider list private, so there is no "give me the
// boxes near this bot" call to make — and that turns out to be the better
// design anyway. Cover is not a list of objects, it is a set of PLACES from
// which a specific threat cannot see you, and the only honest way to ask that
// question is to stand there (virtually) and cast the ray. Terrain folds,
// building walls and tree trunks all answer it the same way, which is why bots
// use dead ground on the open farmland as readily as they use a barn.
//
// Cost is the whole design constraint: each candidate is one ray, so candidates
// are filtered hard (walkable, away from the threat, inside the circle, not
// through the enemy) and ranked before a single ray is spent, and the director
// allows one cover query per tick across the entire match.

export interface CoverSpot {
  pos: THREE.Vector3;
  /** 0..1 — how much this spot is worth walking to. */
  quality: number;
  /** What breaks the line: 'building' | 'tree' | 'terrain'. */
  blocker: string;
}

export type CoverIntent = 'fight' | 'break';

const BLOCKER_VALUE: Record<string, number> = {
  building: 1.0,
  terrain: 0.9,
  tree: 0.78,
};

const RADII = [4.5, 9, 15];
const DIRS = 12;
const _candPos = new THREE.Vector3();
const _candEye = new THREE.Vector3();
const _threatEye = new THREE.Vector3();
// One eye height for both ends of every cover ray, a shade TALLER than the real
// 1.60 m. Testing cover with a lower eye than the bot actually has is how a bot
// ends up hidden on paper and visible in the game.
const COVER_EYE = 1.66;

interface Cand {
  x: number;
  z: number;
  y: number;
  score: number;
  travel: number;
}

const _cands: Cand[] = [];

/**
 * Find somewhere near `self` that breaks line of sight to `threatPos`.
 *
 * `intent` changes the shape of the search: 'fight' wants close cover the bot
 * can peek from, 'break' wants distance and hard cover so it can reload, heal
 * or leave. Returns null when nothing within reach helps, which is a real
 * answer — a bot caught in the open on a plain should have to run.
 */
export function findCover(
  ctx: AiContext,
  self: Combatant,
  profile: BotProfile,
  rng: DetRng,
  threatPos: THREE.Vector3,
  intent: CoverIntent,
  maxRays: number
): CoverSpot | null {
  const tx = threatPos.x - self.pos.x;
  const tz = threatPos.z - self.pos.z;
  const tLen = Math.hypot(tx, tz) || 1;
  const tDirX = tx / tLen;
  const tDirZ = tz / tLen;
  const phase = rng.next() * Math.PI * 2;

  _cands.length = 0;
  for (let ri = 0; ri < RADII.length; ri++) {
    const r = RADII[ri] * (intent === 'break' ? 1.35 : 1);
    for (let i = 0; i < DIRS; i++) {
      const a = phase + (i / DIRS) * Math.PI * 2;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      // Never solve a problem by walking into the muzzle. Anything that is not
      // straight up the sight line is fair game though: the tree twenty metres
      // to your flank is cover, and refusing lateral moves was throwing away
      // most of the real answers.
      const towardThreat = dx * tDirX + dz * tDirZ;
      if (towardThreat > 0.4) continue;

      const x = self.pos.x + dx * r;
      const z = self.pos.z + dz * r;
      if (!ctx.hf.walkable(x, z)) continue;
      const dZone = Math.hypot(x - ctx.zone.center.x, z - ctx.zone.center.z);
      if (dZone > ctx.zone.radius - 6) continue;

      const y = ctx.hf.height(x, z);
      // Prefer: away from the threat, close enough to reach, slightly downhill
      // (a bot that drops behind a shoulder of ground is genuinely hidden).
      let score = -towardThreat * 100 - r * 2.2 + (self.pos.y - y) * 6;
      if (intent === 'break') score += r * 1.4;
      _cands.push({ x, z, y, score, travel: r });
    }
  }
  if (_cands.length === 0) return null;
  _cands.sort((a, b) => b.score - a.score);

  _threatEye.set(threatPos.x, threatPos.y + COVER_EYE, threatPos.z);
  let best: CoverSpot | null = null;
  let rays = 0;
  for (const c of _cands) {
    _candPos.set(c.x, c.y, c.z);
    // Eye height of a bot standing there; if a standing man is hidden, so is a
    // crouching one.
    _candEye.set(c.x, c.y + COVER_EYE, c.z);
    // Dead ground is FREE to find: the terrain profile answers it without a
    // ray. So every candidate gets tested for it, and only the ones standing
    // in clear ground cost anything from the budget.
    let blocker: string | null = terrainBlocks(ctx.hf, _candEye, _threatEye) ? 'terrain' : null;
    if (!blocker) {
      if (rays >= maxRays) continue;
      if (!ctx.coverBudget.take(1)) break;
      rays++;
      blocker = losBlocker(ctx.world, _candEye, _threatEye, self.capsuleId, 0.4);
    }
    if (!blocker) continue;
    const value = BLOCKER_VALUE[blocker] ?? 0.7;
    const quality = value * (1 - Math.min(0.6, c.travel / 40)) * (0.6 + profile.coverBias * 0.4);
    if (!best || quality > best.quality) {
      best = { pos: _candPos.clone(), quality, blocker };
      // Good hard cover close by is worth taking immediately rather than
      // spending the rest of the budget looking for perfection.
      if (quality > 0.75) break;
    }
  }
  return best;
}

/**
 * Is this spot still doing its job? One ray, used when a bot has been sitting
 * behind something while the fight moved.
 */
export function coverStillValid(
  ctx: AiContext,
  self: Combatant,
  threatPos: THREE.Vector3
): boolean {
  _candEye.set(self.pos.x, self.pos.y + COVER_EYE, self.pos.z);
  _threatEye.set(threatPos.x, threatPos.y + COVER_EYE, threatPos.z);
  if (terrainBlocks(ctx.hf, _candEye, _threatEye)) return true;
  if (!ctx.coverBudget.take(1)) return true; // no budget: assume it holds, re-check later
  return losBlocker(ctx.world, _candEye, _threatEye, self.capsuleId, 0.4) !== null;
}
