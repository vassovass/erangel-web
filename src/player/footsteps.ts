import type { System } from '../core/engine';
import type { AudioSystem } from '../gen/audiogen';
import type { Heightfield } from '../gen/terraingen';
import type { PlayerController } from './controller';

// Surface-aware footstep audio, driven by the controller's GAIT rather than by
// its own distance accumulator.
//
// The controller advances a gait phase by metres travelled and increments
// `stepCount` on each footfall, and its head bob is at its lowest point at
// exactly that moment. Reading the same counter here is what puts the sound on
// the footfall instead of near it: two accumulators with different thresholds
// drift apart within a few seconds and the result is a body whose head dips
// between its own steps.

/** Loudness by stance. Crouching is the whole point of crouching. */
const VOL_SPRINT = 0.78;
const VOL_WALK = 0.45;
const VOL_CROUCH = 0.17;
/** Aiming keeps you slow and deliberate; the sound follows. */
const VOL_ADS_SCALE = 0.7;

/** Landing thud: the same surface sample, pitched down and hit harder. */
const LAND_RATE = 0.62;
const LAND_VOL_MIN = 0.35;
const LAND_VOL_MAX = 1.0;
/** Below this impact speed (m/s) a touchdown is just a step, not a thud.
 *  7.2 m/s is exactly what a standing jump lands at, so hopping on the spot
 *  gives one soft thud rather than silence or a crash. */
const LAND_MIN_SPEED = 5.0;
/** Impact speed at which the thud is at full volume: 20 m/s ~= a 9 m drop. */
const LAND_FULL_SPEED = 20.0;

export class Footsteps implements System {
  private lastStep = 0;

  constructor(
    private player: PlayerController,
    private hf: Heightfield,
    private audio: AudioSystem
  ) {
    this.lastStep = player.stepCount;
    // WRAP the existing handler rather than assigning over it — the same rule
    // that ballistics.onTargetHit is documented under in main.ts. Anything
    // wired before us keeps working.
    const prev = player.onLand;
    player.onLand = (impactSpeed, severity01) => {
      prev?.(impactSpeed, severity01);
      this.playLanding(impactSpeed);
    };
  }

  /** Surface name under the player's feet. */
  private surface(): string {
    const w = this.hf.splat(this.player.position.x, this.player.position.z);
    if (w.road > 0.5) return 'step-road';
    return w.dirt > Math.max(w.grass, w.rock) ? 'step-dirt' : 'step-grass';
  }

  private playLanding(impactSpeed: number): void {
    if (impactSpeed < LAND_MIN_SPEED) return;
    const t = Math.min(1, (impactSpeed - LAND_MIN_SPEED) / (LAND_FULL_SPEED - LAND_MIN_SPEED));
    this.audio.play(this.surface(), {
      volume: LAND_VOL_MIN + (LAND_VOL_MAX - LAND_VOL_MIN) * t,
      rate: LAND_RATE,
      detuneJitter: 0.1,
    });
  }

  fixedUpdate(): void {
    if (this.player.stepCount === this.lastStep) return;
    this.lastStep = this.player.stepCount;

    let volume = this.player.isSprinting
      ? VOL_SPRINT
      : this.player.crouched
        ? VOL_CROUCH
        : VOL_WALK;
    if (this.player.ads) volume *= VOL_ADS_SCALE;

    this.audio.play(this.surface(), { volume, detuneJitter: 0.18 });
  }
}
