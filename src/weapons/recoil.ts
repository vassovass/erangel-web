import { hash2 } from '../gen/noise';

// RECOIL AS A PATTERN, NOT A TABLE.
//
// The thing that makes a PUBG-class rifle worth learning is that its recoil is
// a FIXED CURVE: the same magazine walks the muzzle through the same shape
// every single time, so a player who spends an afternoon in the range learns to
// draw that shape in reverse with the mouse and is rewarded for it forever. The
// previous model was ten hard-coded vertical steps that clamped at index 9 and
// a horizontal term whose direction was a coin flip on a time hash — after the
// tenth round it was a constant push with random left/right jitter. There is
// nothing to learn in that. It is a screen shake.
//
// So: one deterministic function of SHOT INDEX (0..29) produces the whole
// magazine, and the only stochastic-looking part of it is a hash of the shot
// index itself, which means it is identical on every magazine, every match and
// every machine.
//
// ---------------------------------------------------------------------------
// THREE POOLS, BECAUSE "CAMERA RECOIL" IS NOT ONE BEHAVIOUR
//
// Every round's kick is split three ways, and the split is what makes the
// weapon controllable rather than merely violent:
//
//   FAST  (fFast)  a sharp bounce that is gone in ~0.1 s. This is the per-shot
//                  snap you see and do not fight; it is the weapon's texture.
//   SLOW  (fSlow)  holds while the trigger is down and then walks the muzzle
//                  back toward where you were aiming over ~0.6 s once you stop.
//                  This is the "recovery" — it is why a controlled burst that
//                  you pull down through ends up BELOW the target if you keep
//                  pulling, and why trigger discipline is a real skill.
//   HELD  (rest)   never comes back. This is the part you must physically
//                  compensate for with the mouse, and it is what a learned
//                  pattern actually buys you.
//
// FAST and SLOW are recovering pools: the state tracks how many degrees it has
// actually injected into the player's aim (`applied`) and each tick writes only
// the DIFFERENCE. That is what makes the mouse stay authoritative — the player
// pulling down subtracts from the aim, recovery subtracts exactly what recoil
// added and no more, and a pitch clamp that swallows part of a kick is recorded
// as swallowed instead of being handed back later as a phantom downward drift.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export interface RecoilProfile {
  /** Rounds in the pattern. Past this the last entry repeats. */
  magSize: number;

  // ---- Vertical envelope, degrees per shot -------------------------------
  /** First round out of a settled weapon: the softest kick in the magazine. */
  vStart: number;
  /** Peak per-shot climb, reached at `peakShot`. */
  vPeak: number;
  /** Per-shot climb on the last round of the magazine. */
  vEnd: number;
  /** Shot index at which the vertical envelope peaks. */
  peakShot: number;

  // ---- Horizontal character ----------------------------------------------
  /** Amplitude of the lateral sway, degrees. */
  hAmp: number;
  /** Shots over which the sway ramps in (early rounds are nearly vertical). */
  hRampShots: number;
  /** Period of the sway in SHOTS. Deliberately non-integer so the pattern does
   *  not fold back onto itself and read as a metronome. */
  hPeriod: number;
  /** Phase offset of the sway, radians — the weapon's handedness. */
  hPhase: number;
  /** Constant lateral bias, degrees per shot. */
  hDrift: number;

  /** Per-shot variation as a fraction, hashed on the SHOT INDEX (so the
   *  pattern stays identical magazine to magazine and remains learnable). */
  jitterV: number;
  jitterH: number;
  seed: number;

  // ---- Split + recovery ---------------------------------------------------
  /** Fraction of each kick in the fast bounce pool. */
  fFast: number;
  /** Fraction in the slow recovering pool. The remainder is permanent. */
  fSlow: number;
  fastTau: number;
  slowTau: number;
  /** Seconds after the last round before the slow pool starts recovering. */
  slowHold: number;

  // ---- Pattern reset ------------------------------------------------------
  /** Seconds of held fire discipline before the pattern starts rewinding. */
  resetDelay: number;
  /** Shots per second the pattern index rewinds once it starts. */
  resetPerSec: number;

  // ---- Situational scales -------------------------------------------------
  adsScale: number;
  crouchScale: number;
  airScale: number;
  /** Multiplier at full sprint speed; interpolated by movement. */
  moveScale: number;

  // ---- Visual (weapon, not camera) ---------------------------------------
  /** Degrees of VISUAL muzzle rise per degree of camera kick. The gun kicks
   *  harder than the view does; that difference is most of what a shot feels
   *  like and none of it costs the player accuracy. */
  viewKick: number;
  viewTau: number;
  /** Seconds for the 0..1 per-shot punch envelope to fall to zero. */
  viewPunchTime: number;
}

export interface RecoilKick {
  /** Vertical, degrees (positive = muzzle up). */
  v: number;
  /** Horizontal, degrees (positive = muzzle left, matching the yaw sign). */
  h: number;
}

/**
 * The pattern itself: pure, deterministic, and a function of the shot index
 * alone. Call it with 0..magSize-1 to plot the whole magazine.
 */
export function recoilForShot(p: RecoilProfile, index: number, out?: RecoilKick): RecoilKick {
  const o = out ?? { v: 0, h: 0 };
  const i = Math.max(0, Math.min(index, p.magSize - 1));
  const k = Math.round(i);

  let v: number;
  if (i <= p.peakShot) {
    v = p.vStart + (p.vPeak - p.vStart) * smooth(p.peakShot > 0 ? i / p.peakShot : 1);
  } else {
    v = p.vPeak + (p.vEnd - p.vPeak) * smooth((i - p.peakShot) / Math.max(1, p.magSize - 1 - p.peakShot));
  }
  v *= 1 + (hash2(k, 19, p.seed) - 0.5) * 2 * p.jitterV;

  // Early rounds are almost pure vertical — that is what makes the first three
  // rounds of an AK a usable burst at range. The sway earns its amplitude.
  const ramp = 0.28 + 0.72 * clamp01(i / Math.max(1, p.hRampShots));
  let h = (Math.sin((i / p.hPeriod) * TAU + p.hPhase) * p.hAmp + p.hDrift) * ramp;
  h += p.hAmp * (hash2(k, 53, p.seed) - 0.5) * 2 * p.jitterH * ramp;

  o.v = v;
  o.h = h;
  return o;
}

/**
 * Cumulative pattern: where the muzzle sits after `count` rounds with NO
 * recovery and no compensation. This is the shape a player memorises, and the
 * function the numeric tests assert against.
 */
export function patternPath(p: RecoilProfile, count = p.magSize): RecoilKick[] {
  const path: RecoilKick[] = [];
  const k: RecoilKick = { v: 0, h: 0 };
  let v = 0;
  let h = 0;
  for (let i = 0; i < count; i++) {
    recoilForShot(p, i, k);
    v += k.v;
    h += k.h;
    path.push({ v, h });
  }
  return path;
}

export class RecoilState {
  /** Fractional position in the pattern; rewinds when fire stops. */
  patternPos = 0;
  /** Seconds since the last round left the muzzle. */
  sinceShot = 999;
  /** Last raw kick produced, degrees — diagnostics only. */
  readonly last: RecoilKick = { v: 0, h: 0 };

  /** Visual weapon kick, degrees. Larger and faster than the camera's. */
  viewPitch = 0;
  viewYaw = 0;
  /** 0..1 envelope of the most recent shot, for the viewmodel's punch. */
  viewPunch = 0;

  private fastP = 0;
  private fastY = 0;
  private slowP = 0;
  private slowY = 0;
  private appliedP = 0;
  private appliedY = 0;

  /** Integer index into the pattern the next round will use. */
  get index(): number {
    return Math.floor(this.patternPos);
  }

  /** Degrees of recovering climb currently injected into the aim. */
  get climbPitch(): number {
    return this.appliedP;
  }
  get climbYaw(): number {
    return this.appliedY;
  }

  /** Back to round one — used when the magazine is replaced. */
  resetPattern(): void {
    this.patternPos = 0;
  }

  /**
   * Fire one round. Mutates the pools and returns the PERMANENT part of the
   * kick, which the caller writes into the aim immediately and never takes
   * back. Degrees.
   */
  shoot(p: RecoilProfile, scale: number, out?: RecoilKick): RecoilKick {
    const o = out ?? { v: 0, h: 0 };
    recoilForShot(p, this.index, this.last);
    const v = this.last.v * scale;
    const h = this.last.h * scale;
    const held = Math.max(0, 1 - p.fFast - p.fSlow);

    this.fastP += v * p.fFast;
    this.fastY += h * p.fFast;
    this.slowP += v * p.fSlow;
    this.slowY += h * p.fSlow;

    this.viewPitch += v * p.viewKick;
    this.viewYaw += h * p.viewKick;
    this.viewPunch = 1;

    this.patternPos = Math.min(this.patternPos + 1, p.magSize - 1);
    this.sinceShot = 0;

    o.v = v * held;
    o.h = h * held;
    return o;
  }

  /**
   * Advance recovery by dt and return the aim delta the caller must apply
   * (degrees). The caller applies it — possibly clamped — and reports back
   * through `commit`, so the pools never claim credit for motion that did not
   * happen.
   */
  step(p: RecoilProfile, dt: number, out?: RecoilKick): RecoilKick {
    const o = out ?? { v: 0, h: 0 };
    this.sinceShot += dt;

    const kFast = Math.exp(-dt / Math.max(1e-4, p.fastTau));
    this.fastP *= kFast;
    this.fastY *= kFast;

    if (this.sinceShot >= p.slowHold) {
      const kSlow = Math.exp(-dt / Math.max(1e-4, p.slowTau));
      this.slowP *= kSlow;
      this.slowY *= kSlow;
    }

    if (this.sinceShot >= p.resetDelay) {
      this.patternPos = Math.max(0, this.patternPos - p.resetPerSec * dt);
    }

    const kView = Math.exp(-dt / Math.max(1e-4, p.viewTau));
    this.viewPitch *= kView;
    this.viewYaw *= kView;
    this.viewPunch = Math.max(0, this.viewPunch - dt / Math.max(1e-4, p.viewPunchTime));

    o.v = this.fastP + this.slowP - this.appliedP;
    o.h = this.fastY + this.slowY - this.appliedY;
    return o;
  }

  /** Record what actually landed in the aim, degrees. */
  commit(dv: number, dh: number): void {
    this.appliedP += dv;
    this.appliedY += dh;
  }

  /** Drop all recoil state. Whatever has already been written into the aim
   *  stays there — it is the player's aim now, not an offset we own. */
  clear(): void {
    this.fastP = this.fastY = 0;
    this.slowP = this.slowY = 0;
    this.appliedP = this.appliedY = 0;
    this.viewPitch = this.viewYaw = 0;
    this.viewPunch = 0;
    this.patternPos = 0;
    this.sinceShot = 999;
  }
}
