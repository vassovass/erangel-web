import type { RecoilProfile } from './recoil';
import type { SpreadProfile } from './wpn-spread';

// EVERY NUMBER THAT DECIDES HOW THE GUN FEELS IS IN THIS FILE, and every one of
// them carries what it means in the world. Same contract as MOVE in
// player/controller.ts: `AKM` is a plain mutable object published on
// `window.__WEAPON__`, so a value can be poked from the devtools console and
// the next round fired uses it, with no rebuild.
//
// The reference weapon is a 7.62x39 AKM, and the headline figures are the real
// ones: 600 rpm cyclic, 715 m/s at the muzzle, 30-round magazine. Everything
// derived from them is checked against that:
//
//   * 600 rpm  = 100 ms between rounds = a 30-round magazine empties in 2.9 s.
//   * 715 m/s  = 14 ms to 10 m, 140 ms to 100 m, 0.56 s to 400 m. Bullet drop
//                over that last flight is 1.5 m, which is why ballistics.ts
//                integrates gravity instead of drawing a straight line.
//   * 47 dmg   against 100 hp is three rounds centre mass, one round to the
//                head inside 60 m, four to the legs (see wpn-damage.ts). Three
//                is the number the whole game is balanced around: it is short
//                enough that being shot first usually loses the fight, and long
//                enough that a single lucky round does not.
//   * 2.9 s    to reload from empty is the real AKM number and it is meant to
//                hurt; topping up a partial magazine keeps the round in the
//                chamber and costs 2.45 s.

export type FireMode = 'auto' | 'single';

export interface WeaponProfile {
  id: string;
  name: string;
  calibre: string;
  /** Cyclic rate, rounds per minute. */
  rpm: number;
  /** Muzzle velocity, m/s. */
  muzzleSpeed: number;
  /** Damage before zone multiplier and range falloff. */
  baseDamage: number;
  magSize: number;
  reserveStart: number;
  /** Seconds to replace a partially spent magazine (round still chambered). */
  reloadTactical: number;
  /** Seconds to reload from empty — includes working the bolt. */
  reloadEmpty: number;
  /** Cooldown after a dry trigger pull, so the click is not a machine gun. */
  dryFireDelay: number;
  /** Seconds for the sight picture to settle; ADS accuracy ramps over it. */
  adsBlendTime: number;
  /** Selector positions, in toggle order. */
  modes: FireMode[];
  /** Seconds a semi-auto trigger pull is buffered for. Long enough that a pull
   *  landing inside the 100 ms cycle still fires when the bolt comes home;
   *  short enough that it can never become a second round. */
  semiBufferTime: number;
  /** Physical key code that cycles the selector. Not routed through
   *  core/input.ts because that file belongs to another lane; see weapon.ts. */
  selectorKey: string;
  /** Optional input action name, used if a binding is ever added upstream. */
  selectorAction: string;
  recoil: RecoilProfile;
  spread: SpreadProfile;
}

export const AKM: WeaponProfile = {
  id: 'akm',
  name: 'AKM',
  calibre: '7.62',
  rpm: 600,
  muzzleSpeed: 715,
  baseDamage: 47,
  magSize: 30,
  reserveStart: 120,
  reloadTactical: 2.45,
  reloadEmpty: 2.9,
  dryFireDelay: 0.24,
  adsBlendTime: 0.16,
  modes: ['auto', 'single'],
  semiBufferTime: 0.14,
  selectorKey: 'KeyB',
  selectorAction: 'firemode',

  recoil: {
    magSize: 30,

    // Vertical envelope. The shape is the AK's signature: a soft first round,
    // a hard ramp over rounds 2-6 as the buffer stacks up, a peak around the
    // sixth, then a long decay as the magazine lightens and the shooter's
    // shoulder has absorbed the pattern. Integrated over a full magazine it is
    // ~23 deg of climb, which at the default look sensitivity is about 190 px
    // of mouse pulled down across 2.9 s — a real forearm movement, learnable,
    // and comfortably inside one mousepad.
    vStart: 0.42,
    vPeak: 1.02,
    vEnd: 0.56,
    peakShot: 5,

    // Horizontal character. The early rounds are almost pure vertical (that is
    // what makes a three-round burst usable at 150 m); the sway ramps in over
    // the first eight and then swings on an 11-round period, so a full magazine
    // draws roughly three lateral swings with a steady rightward lean. Period
    // is deliberately not a round number: an integer period lands every swing
    // on the same phase and the pattern reads as a metronome.
    hAmp: 0.55,
    hRampShots: 8,
    hPeriod: 11,
    hPhase: 0.55,
    hDrift: -0.05,

    // Hashed on the SHOT INDEX, so it is the same wobble on every magazine.
    // This is texture, not randomness — the pattern stays memorisable.
    jitterV: 0.1,
    jitterH: 0.25,
    seed: 8123,

    // 26% snaps back in a tenth of a second, 16% walks back over the following
    // second once you stop, 58% is yours to fix. See recoil.ts for why the
    // split is the whole design.
    //
    // The slow share is what the muzzle SETTLES by when you release, and it is
    // deliberately proportional to how long you held the trigger: 0.4 deg after
    // a three-round burst, 1.3 deg after ten, 3.8 deg after a full magazine.
    // That is the settle you feel; push the share much past this and a player
    // who correctly compensated for the whole climb gets yanked several degrees
    // below the target the instant they stop, which reads as the game taking
    // the mouse away rather than as the weapon calming down.
    fFast: 0.26,
    fSlow: 0.16,
    fastTau: 0.1,
    slowTau: 0.42,
    slowHold: 0.22,

    // Trigger discipline rewinds the pattern: a third of a second off the
    // trigger and it starts walking back at 14 rounds per second, so a
    // double-tap keeps its place and a two-second pause starts you at round one.
    resetDelay: 0.32,
    resetPerSec: 14,

    // Aiming braces the weapon (22% less), crouching gives it a base (14%),
    // firing in mid-air gives it nothing to push against (40% worse), and
    // running while firing costs another 18%.
    adsScale: 0.78,
    crouchScale: 0.86,
    airScale: 1.4,
    moveScale: 1.18,

    // The GUN kicks nearly twice as hard as the VIEW does, and recovers in
    // under a tenth of a second. This is pure feel: it costs the player no
    // accuracy at all and is most of what a round feels like.
    viewKick: 1.9,
    viewTau: 0.085,
    viewPunchTime: 0.11,
  },

  spread: {
    // 0.035 deg is 6 cm at 100 m: aimed, standing still, settled, the first
    // round goes exactly where the crosshair is. That is the promise the rest
    // of the model measures penalties against.
    adsBase: 0.035,
    // 1.15 deg is 30 cm at 15 m — a rifle at the waist is a room-clearing tool,
    // not a marksman's. This single number is what makes the aim button matter.
    hipBase: 1.15,

    // Movement rides ACTUAL ground speed. At a walk (4.3 of 6.4 m/s) aimed
    // fire opens to 0.74 deg — 1.3 m at 100 m, i.e. you will miss a torso at
    // range while walking, and you will hit one at 25 m.
    adsMove: 1.05,
    hipMove: 1.9,

    // Airborne is deliberately hopeless: 2.8 deg aimed is 1.5 m of scatter at
    // 30 m. Jump-shooting is not a mechanic here.
    adsAir: 2.8,
    hipAir: 4.0,
    // A landing keeps 45% of that for as long as the weapon is unsteady.
    landScale: 0.45,

    // Straight out of a sprint, decaying over the controller's 0.35 s settle.
    // Stopping for a third of a second before the first round is the cheapest
    // accuracy in the game.
    adsSprint: 1.6,
    hipSprint: 2.4,

    // Sustained fire opens the cone on top of the recoil pattern. Aimed, a
    // held magazine adds 0.55 deg; hip fire adds 1.35. Both recover in ~0.65 s.
    //
    // THE TWO RATES ARE A PAIR AND ONE HAS TO WIN. At 600 rpm the weapon adds
    // 10 x bloomPerShot per second and bleeds off bloomDecay per second; if the
    // decay is the larger of the two, bloom pins at one round's worth and
    // sustained fire never opens the cone at all. Measured in the live game at
    // 0.085/round: five hundred milliseconds of held fire produced a bloom of
    // 0.085 — exactly one round, eaten as fast as it arrived. At 0.24 the net
    // rise is +0.85/s, so the cone saturates after ~1.2 s of held fire and
    // recovers from full in 0.65 s.
    adsBloom: 0.55,
    hipBloom: 1.35,
    bloomPerShot: 0.24,
    bloomDecay: 1.55,
    bloomMax: 1,

    // Crouching multiplies the WHOLE cone, so it stacks: crouched, aimed and
    // still is the tightest this weapon gets.
    crouchScale: 0.7,
  },
};

/** Seconds between rounds at the cyclic rate. */
export function fireInterval(p: WeaponProfile): number {
  return 60 / p.rpm;
}
