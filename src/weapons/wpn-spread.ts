// Accuracy model: the cone a round can leave the muzzle inside, in degrees of
// half-angle. Pure functions — the weapon owns the state, this owns the shape.
//
// The rule the whole model is built around: A PLAYER WHO PLAYS WELL SHOULD BE
// REWARDED WITH A BULLET THAT GOES WHERE THE CROSSHAIR IS. Standing still,
// aimed, first round out of a settled weapon is 0.035 deg — six centimetres at
// 100 m, i.e. exactly on. Everything below is a penalty measured against that,
// and every one of them is something the player chose to do:
//
//   HIP FIRE       the largest single term. A rifle held at the waist is not a
//                  precision instrument, and the ADS button has to be worth
//                  pressing at any range past a doorway.
//   MOVEMENT       scales with ACTUAL ground speed (controller.speed2D reads
//                  the body, not the intent), so walking into a wall is not a
//                  penalty and a full sprint is.
//   AIRBORNE       enormous. Jump-shooting is a movement exploit in every
//                  shooter that permits it; here you cannot hit a building.
//   SPRINT-TO-FIRE rides controller.aimPenalty01, which decays over the 0.35 s
//                  the controller already models as "the weapon is settling".
//                  Stopping for a third of a second before the first round is
//                  the cheapest accuracy in the game.
//   STANCE         crouching multiplies the WHOLE cone, so it stacks with the
//                  others: crouched and aimed is the tightest the weapon gets.
//   BLOOM          sustained fire opens the cone; it recovers in well under a
//                  second. Tapping is tighter than holding, which is the same
//                  lesson the recoil pattern teaches, taught twice.

export interface SpreadProfile {
  /** Half-angle in degrees, first round, standing still. */
  hipBase: number;
  adsBase: number;
  /** Added at full sprint speed. */
  hipMove: number;
  adsMove: number;
  /** Added while both feet are off the ground. */
  hipAir: number;
  adsAir: number;
  /** Added straight out of a sprint, decaying with controller.aimPenalty01. */
  hipSprint: number;
  adsSprint: number;
  /** Added at full bloom (bloom01 = 1). */
  hipBloom: number;
  adsBloom: number;
  /** Whole-cone multiplier when fully crouched. */
  crouchScale: number;
  /** Fraction of the airborne penalty still applied on touchdown. */
  landScale: number;

  /** Bloom added per round, and how fast it bleeds off (units per second). */
  bloomPerShot: number;
  bloomDecay: number;
  bloomMax: number;
}

export interface SpreadInputs {
  /** 0 = hip, 1 = fully aimed. Blended, so ADS accuracy is not free on frame 1. */
  ads01: number;
  /** Ground speed as a fraction of sprint speed. */
  speed01: number;
  /** Both feet off the ground. */
  airborne: boolean;
  /** 1 standing, 0 fully crouched (controller.stance01). */
  stance01: number;
  /** 1 straight out of a sprint, 0 settled (controller.aimPenalty01). */
  aimPenalty01: number;
  /** 0..1 sustained-fire bloom. */
  bloom01: number;
  /** 0..1 residual of a recent landing. */
  landing01: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Cone half-angle in degrees. */
export function spreadDeg(p: SpreadProfile, i: SpreadInputs): number {
  const t = i.ads01 < 0 ? 0 : i.ads01 > 1 ? 1 : i.ads01;
  const air = lerp(p.hipAir, p.adsAir, t);
  let deg =
    lerp(p.hipBase, p.adsBase, t) +
    lerp(p.hipMove, p.adsMove, t) * Math.max(0, Math.min(1, i.speed01)) +
    (i.airborne ? air : air * p.landScale * Math.max(0, Math.min(1, i.landing01))) +
    lerp(p.hipSprint, p.adsSprint, t) * Math.max(0, Math.min(1, i.aimPenalty01)) +
    lerp(p.hipBloom, p.adsBloom, t) * Math.max(0, Math.min(1, i.bloom01));
  // Stance multiplies everything, so it compounds with being aimed and still.
  deg *= lerp(p.crouchScale, 1, Math.max(0, Math.min(1, i.stance01)));
  return deg;
}

/** Metres of radius the cone covers at `distance`. Sanity-check helper. */
export function spreadRadiusAt(deg: number, distance: number): number {
  return Math.tan((deg * Math.PI) / 180) * distance;
}
