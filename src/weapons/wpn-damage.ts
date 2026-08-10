// Terminal ballistics: where a round landed on a body, and what that is worth.
//
// The physics raycast resolves a capsule target as either its HEAD SPHERE
// (tag prefixed `head:`) or its body cylinder, and that is the only anatomy the
// collider has. One tag is not a hit-zone model: it makes every round that is
// not a headshot worth exactly the same, so a leg hit at 120 m and a centre-mass
// hit at 12 m read identically and there is nothing to aim AT below the neck.
//
// The body zone is recovered from the HEIGHT of the impact above the ground the
// target is standing on, which needs no change to physics.ts and no per-limb
// colliders. It is an approximation with one honest failure case — a target
// standing on a roof or a vehicle is not standing on the heightfield — so a
// relative height outside human range falls back to the torso rather than
// inventing a headshot out of a bookkeeping error.

export type HitZone = 'head' | 'chest' | 'abdomen' | 'leg';

/**
 * Damage multiplier per zone. Anchored on the 7.62 AR numbers this weapon is
 * modelled from: with a 47-damage round against 100 hp,
 *
 *   head    2.35 -> 110.5  one round, and only inside the falloff-free band,
 *   chest   1.00 ->  47.0  three rounds,
 *   abdomen 0.88 ->  41.4  three rounds (two chest + one abdomen also kills),
 *   leg     0.62 ->  29.1  four rounds.
 *
 * The gap between chest and abdomen is deliberately small: it rewards aiming at
 * the upper chest without making a good hit on the midriff feel like a miss.
 * The leg number is the one with teeth — running someone down by shooting at
 * their feet takes a third longer than putting rounds where it counts.
 */
export const ZONE_MULT: Record<HitZone, number> = {
  head: 2.35,
  chest: 1.0,
  abdomen: 0.88,
  leg: 0.62,
};

/** Human-readable zone, for kill feed / hit feedback text. */
export const ZONE_LABEL: Record<HitZone, string> = {
  head: 'HEAD',
  chest: 'CHEST',
  abdomen: 'BODY',
  leg: 'LIMB',
};

export const BODY = {
  /** Metres above the target's own footing at which the chest starts. */
  chestY: 1.06,
  /** ...and the abdomen. Below this is legs. */
  abdomenY: 0.74,
  /** Above this the impact cannot belong to a body standing on the ground the
   *  sample was taken from (roof, vehicle, bridge): fall back to the torso. */
  plausibleMax: 2.15,
};

export const FALLOFF = {
  /** Full damage out to here. A 7.62 AR does not lose anything worth modelling
   *  inside 60 m. */
  fullRange: 60,
  /** Range at which the floor is reached. */
  farRange: 350,
  /** Fraction of base damage left at farRange and beyond. */
  farScale: 0.65,
};

/**
 * Body zone for a capsule hit.
 * @param headTag  true when the physics ray resolved the head sphere.
 * @param relY     impact height above the ground under the impact, metres.
 */
export function zoneForHit(headTag: boolean, relY: number): HitZone {
  if (headTag) return 'head';
  if (!(relY >= 0) || relY > BODY.plausibleMax) return 'chest';
  if (relY >= BODY.chestY) return 'chest';
  if (relY >= BODY.abdomenY) return 'abdomen';
  return 'leg';
}

/** Distance damage scale, 1 down to FALLOFF.farScale. */
export function rangeFalloff(distance: number): number {
  if (distance <= FALLOFF.fullRange) return 1;
  const t = (distance - FALLOFF.fullRange) / (FALLOFF.farRange - FALLOFF.fullRange);
  return Math.max(FALLOFF.farScale, 1 - t * (1 - FALLOFF.farScale));
}

/** Rounds needed to take `hp` off a target hit only in `zone` at `distance`. */
export function hitsToKill(baseDamage: number, zone: HitZone, distance = 0, hp = 100): number {
  const per = baseDamage * ZONE_MULT[zone] * rangeFalloff(distance);
  return per > 0 ? Math.ceil(hp / per) : Infinity;
}
