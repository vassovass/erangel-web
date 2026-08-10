import * as THREE from 'three';
import type { System } from '../core/engine';
import type { Input } from '../core/input';
import { MOVE, type PlayerController } from '../player/controller';
import { hash2 } from '../gen/noise';
import type { Ballistics } from './ballistics';
import { RecoilState, recoilForShot, type RecoilKick } from './recoil';
import { spreadDeg, type SpreadInputs } from './wpn-spread';
import { AKM, fireInterval, type FireMode, type WeaponProfile } from './wpn-profile';
import { ZONE_MULT, hitsToKill, rangeFalloff } from './wpn-damage';

// The player's rifle: trigger group, magazine, accuracy and recoil.
//
// This class owns almost no numbers. The pattern lives in recoil.ts, the cone
// in wpn-spread.ts, the terminal effect in wpn-damage.ts, and every tunable
// value in wpn-profile.ts. What lives here is the SEQUENCING — what happens on
// a trigger pull, in what order, and how it is written back into the player's
// aim without stealing the mouse from the player.
//
// ---------------------------------------------------------------------------
// TWO THINGS THAT LOOK LIKE ONE THING
//
// CAMERA RECOIL is where you are pointing. It moves the aim, it moves the
// bullets, and it is the thing the player fights. It is split into a bounce
// that returns immediately, a portion that walks back over the second after you
// stop firing, and a portion that is permanently yours to correct (recoil.ts).
//
// WEAPON RECOIL is what the gun does in your hands. It is nearly twice as large
// and gone in a tenth of a second, and it costs the player nothing — no aim, no
// accuracy. It is published here as `viewKickPitch` / `viewKickYaw` /
// `viewPunch01` for the viewmodel to consume.
//
// Conflating the two is the single most common way a shooter ends up feeling
// either weightless or uncontrollable: all camera and it is a fight, all weapon
// and the gun is a laser with a wobble animation.
// ---------------------------------------------------------------------------
//
// WHERE THE BULLET GOES. Not down `camera.quaternion`, which is composed in the
// RENDER frame and is therefore up to one frame stale by the time this runs in
// fixedUpdate — at 30 fps that is a whole 33 ms of recoil and mouse movement
// that the round would not know about, and at 600 rpm it is a third of a shot.
// The authoritative aim is `player.pitch`/`player.yaw`, which this class has
// just written recoil into. The only thing the camera adds on top is the
// landing dip, so that ONE term is sampled per render frame (see `update`) and
// folded back in, and the round leaves the muzzle exactly along the crosshair.

export type WeaponPhase = 'idle' | 'reloading';

export type { FireMode } from './wpn-profile';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
/**
 * Slop on the shot-cooldown comparison, and it is load-bearing.
 *
 * The interval is 0.1 s and the tick is 1/60 s, so six ticks should break the
 * trigger again — but 0.1 - 6/60 evaluates to 1.39e-17 in binary floating
 * point, not 0. Testing `cooldown <= 0` therefore waits a SEVENTH tick and the
 * rifle fires at 60/7 = 514 rpm instead of 600, which is a 17% error in rate of
 * fire, damage per second and the length of a magazine. Measured, not guessed:
 * the numeric harness counted 26 rounds where 30 should have left the muzzle.
 */
const RATE_EPS = 1e-6;
const MODE_LABEL: Record<FireMode, string> = { auto: 'AUTO', single: 'SINGLE' };

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _kick: RecoilKick = { v: 0, h: 0 };
const _applied: RecoilKick = { v: 0, h: 0 };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Deterministic 0..1 from the round counter — no Math.random in the fire path. */
const shotHash = (seq: number, salt: number): number => hash2(seq, salt, 4919);

export class Weapon implements System {
  readonly profile: WeaponProfile;
  phase: WeaponPhase = 'idle';
  ammo: number;
  reserve: number;
  ownerCapsuleId = -1;
  fireMode: FireMode;

  /** Fired this frame — viewmodel/audio hooks. */
  onShot: (() => void) | null = null;
  onReloadStart: (() => void) | null = null;
  /** Magazine seated and the pattern reset. */
  onReloadEnd: (() => void) | null = null;
  onDryFire: (() => void) | null = null;
  /** Selector moved — HUD readout and a selector click. */
  onFireModeChange: ((mode: FireMode) => void) | null = null;

  private readonly recoil = new RecoilState();
  private cooldown = 0;
  private reloadT = 0;
  private reloadTotal: number;
  private bloom = 0;
  private adsBlend = 0;
  private landPenalty = 0;
  private wasAirborne = false;
  /** Monotone round counter — the only entropy source in the fire path. */
  private shotSeq = 0;
  private triggerWasDown = false;
  /** Seconds left of the semi-auto input buffer. */
  private semiBuffer = 0;
  private modeTogglePending = false;
  /** Camera pitch the controller adds on top of player.pitch (landing dip). */
  private dipPitch = 0;
  private spreadCache = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private input: Input,
    private player: PlayerController,
    private ballistics: Ballistics,
    profile: WeaponProfile = AKM
  ) {
    this.profile = profile;
    this.ammo = profile.magSize;
    this.reserve = profile.reserveStart;
    this.reloadTotal = profile.reloadEmpty;
    this.fireMode = profile.modes[0];
    this.installSelectorKey();
    this.publishDebugHooks();
  }

  // --- public readouts (HUD / viewmodel) -----------------------------------

  get reloadProgress(): number {
    return this.phase === 'reloading' ? 1 - this.reloadT / this.reloadTotal : 0;
  }
  /** Seconds the reload in flight will take (2.45 tactical / 2.9 from empty). */
  get reloadDuration(): number {
    return this.reloadTotal;
  }
  /** Live cone half-angle in degrees. The reticle gap should be this, not a
   *  copy of the formula: see the note in `spreadRadiusAt`. */
  get spreadDeg(): number {
    return this.spreadCache;
  }
  /** Cone radius in metres at `distance`. */
  spreadRadiusAt(distance: number): number {
    return Math.tan(this.spreadCache * DEG) * distance;
  }
  /** 0..1 sustained-fire bloom. */
  get bloom01(): number {
    return this.bloom;
  }
  /** 0..1 aim blend; 1 is a settled sight picture. */
  get ads01(): number {
    return this.adsBlend;
  }
  /** Round of the recoil pattern the next shot will use. */
  get patternIndex(): number {
    return this.recoil.index;
  }
  /** Degrees of recovering recoil currently in the aim (positive = muzzle up). */
  get recoilClimbDeg(): number {
    return this.recoil.climbPitch;
  }
  /** Visual weapon kick, degrees — the viewmodel's, not the camera's. */
  get viewKickPitch(): number {
    return this.recoil.viewPitch;
  }
  get viewKickYaw(): number {
    return this.recoil.viewYaw;
  }
  /** 0..1 envelope of the most recent round, for the viewmodel punch. */
  get viewPunch01(): number {
    return this.recoil.viewPunch;
  }
  get fireModeLabel(): string {
    return MODE_LABEL[this.fireMode];
  }
  /** Magazine fill, 0..1. */
  get ammo01(): number {
    return this.ammo / this.profile.magSize;
  }
  get canReload(): boolean {
    return this.phase !== 'reloading' && this.ammo < this.profile.magSize && this.reserve > 0;
  }

  /** Cycle the selector. Safe to call from anywhere (HUD button, keybind). */
  toggleFireMode(): void {
    const modes = this.profile.modes;
    if (modes.length < 2) return;
    const next = modes[(modes.indexOf(this.fireMode) + 1) % modes.length];
    if (next === this.fireMode) return;
    this.fireMode = next;
    this.semiBuffer = 0;
    this.onFireModeChange?.(next);
  }

  // --- simulation ----------------------------------------------------------

  fixedUpdate(dt: number): void {
    const p = this.profile;
    this.cooldown = Math.max(0, this.cooldown - dt);

    // Selector. Two channels into one edge so neither can double-toggle: the
    // DOM listener installed below, and an input action that only exists if a
    // binding is ever added to core/input.ts (another lane's file).
    if (this.input.isLocked && this.input.wasPressed(p.selectorAction)) this.modeTogglePending = true;
    if (this.modeTogglePending) {
      this.modeTogglePending = false;
      this.toggleFireMode();
    }

    // Aim state. Deliberately NOT gated on sprinting: the controller reads
    // `ads` to decide whether a sprint may continue, so pressing aim has to be
    // able to END a sprint rather than be refused by one.
    const wantAds = this.input.mouseDown[2] && this.phase !== 'reloading';
    this.player.ads = wantAds;
    this.adsBlend =
      p.adsBlendTime <= 0
        ? wantAds
          ? 1
          : 0
        : clamp01(this.adsBlend + (wantAds ? dt / p.adsBlendTime : -dt / p.adsBlendTime));

    this.stepReload(dt);
    this.stepRecoil(dt);

    this.bloom = Math.max(0, this.bloom - p.spread.bloomDecay * dt);
    this.landPenalty = Math.max(0, this.landPenalty - dt / 0.35);
    if (this.wasAirborne && this.player.grounded) this.landPenalty = 1;
    this.wasAirborne = !this.player.grounded;

    this.spreadCache = spreadDeg(p.spread, this.spreadInputs());

    this.stepTrigger(dt);
  }

  /** Render-frame pass: sample the one aim term the controller owns. */
  update(): void {
    // player.update() composed the camera earlier in this same pass (it is
    // registered ahead of the weapon), so the difference between the camera's
    // pitch and the player's IS the landing dip and nothing else.
    _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    const dip = _euler.x - this.player.pitch;
    this.dipPitch = dip > 0.14 ? 0.14 : dip < -0.14 ? -0.14 : dip;
  }

  private spreadInputs(): SpreadInputs {
    const pl = this.player;
    return {
      ads01: this.adsBlend,
      speed01: clamp01(pl.speed2D / Math.max(0.1, MOVE.sprintSpeed)),
      airborne: !pl.grounded,
      stance01: pl.stance01,
      aimPenalty01: pl.aimPenalty01,
      bloom01: this.bloom,
      landing01: this.landPenalty,
    };
  }

  private stepReload(dt: number): void {
    const p = this.profile;
    if (this.phase === 'reloading') {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        const take = Math.min(p.magSize - this.ammo, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this.phase = 'idle';
        // A fresh magazine is a fresh pattern. Nothing else in the game gives
        // the player a guaranteed reset, and it is what makes reloading behind
        // cover a tactical choice rather than a chore.
        this.recoil.resetPattern();
        this.bloom = 0;
        this.onReloadEnd?.();
      }
      return;
    }
    if (this.input.wasPressed('reload') && this.canReload) this.startReload();
  }

  /** Begin a reload. Public so an out-of-ammo prompt or a bot proxy can call it. */
  startReload(): boolean {
    if (!this.canReload) return false;
    this.phase = 'reloading';
    // An empty gun costs the bolt as well as the magazine.
    this.reloadTotal = this.ammo <= 0 ? this.profile.reloadEmpty : this.profile.reloadTactical;
    this.reloadT = this.reloadTotal;
    this.semiBuffer = 0;
    this.onReloadStart?.();
    return true;
  }

  /**
   * Recoil recovery, written back into the player's aim as a DELTA.
   *
   * The pools in RecoilState know how many degrees they have injected; this
   * writes only the difference and then reports what actually landed. That is
   * what keeps the mouse authoritative (the player pulling down is not undone
   * by recovery) and what stops the pitch clamp at +-86 deg from handing back a
   * phantom downward drift after firing at the sky.
   */
  private stepRecoil(dt: number): void {
    this.recoil.step(this.profile.recoil, dt, _kick);
    if (_kick.v === 0 && _kick.h === 0) return;
    const applied = this.addAim(_kick.v * DEG, _kick.h * DEG);
    this.recoil.commit(applied.v / DEG, applied.h / DEG);
  }

  /** Adds to the aim, respecting the controller's pitch limit. Returns what
   *  actually landed, radians, in the same struct (do not retain). */
  private addAim(dPitch: number, dYaw: number): RecoilKick {
    const before = this.player.pitch;
    const want = before + dPitch;
    this.player.pitch = want > MOVE.pitchLimit ? MOVE.pitchLimit : want < -MOVE.pitchLimit ? -MOVE.pitchLimit : want;
    this.player.yaw += dYaw;
    _applied.v = this.player.pitch - before;
    _applied.h = dYaw;
    return _applied;
  }

  private stepTrigger(dt: number): void {
    const p = this.profile;
    const locked = this.input.isLocked;
    const down = locked && this.input.mouseDown[0];

    // TWO EDGE SOURCES, AND THE PRESS FLAG IS CONSUMED UNCONDITIONALLY.
    //
    // `wasMousePressed` is a consume-on-read latch that Input clears at the end
    // of each RENDER frame, while this runs up to five times per frame (fixed
    // step). Written as `(down && !wasDown) || wasMousePressed(0)` the `||`
    // short-circuits on the first step, so the latch survives into the second
    // step of the same frame and reads as a fresh trigger pull — measured, that
    // put TWO rounds downrange for one click in semi. Reading it into a local
    // first means exactly one fixed step can ever see a given press.
    //
    // The mouseDown edge is still needed as well: at 15 fps a click can begin
    // and end inside one frame and `mouseDown` never reads true in any tick.
    const pressed = locked ? this.input.wasMousePressed(0) : false;
    const edge = pressed || (down && !this.triggerWasDown);
    this.triggerWasDown = down;

    // Short input buffer rather than a boolean latch: a trigger pull that lands
    // during the 100 ms cycle still fires when the bolt comes home, so fast
    // semi-auto clicking is limited by the weapon and not by the player's luck
    // with frame boundaries.
    this.semiBuffer = edge ? p.semiBufferTime : Math.max(0, this.semiBuffer - dt);

    // You cannot fire at a run. The weapon is across your chest and the
    // viewmodel already shows it there; the controller's 0.35 s settle then
    // governs how accurate the first round out of it is.
    const ready =
      this.phase === 'idle' && this.cooldown <= RATE_EPS && locked && !this.player.isSprinting;
    if (!ready) return;

    const wantFire = this.fireMode === 'auto' ? down : this.semiBuffer > 0;
    if (!wantFire) return;

    if (this.ammo <= 0) {
      this.cooldown = p.dryFireDelay;
      this.semiBuffer = 0;
      this.onDryFire?.();
      return;
    }
    this.semiBuffer = 0;
    this.fireOnce();
  }

  private fireOnce(): void {
    const p = this.profile;
    const pl = this.player;
    this.ammo--;
    this.shotSeq++;
    this.cooldown = fireInterval(p);

    // ---- where the round is pointed ---------------------------------------
    // Sim-authoritative aim plus the camera's landing dip; see the header.
    _euler.set(pl.pitch + this.dipPitch, pl.yaw, 0, 'YXZ');
    _q.setFromEuler(_euler);
    _dir.set(0, 0, -1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);

    // Uniform disc inside the cone, hashed on the round counter — deterministic
    // and allocation-free. The old model sampled a SQUARE from a float that
    // accumulated dt, which both biased the corners and drifted with frame rate.
    const spread = this.spreadCache * DEG;
    if (spread > 0) {
      const ang = shotHash(this.shotSeq, 3) * TAU;
      const rad = Math.sqrt(shotHash(this.shotSeq, 5)) * spread;
      _dir.addScaledVector(_right, Math.cos(ang) * rad).addScaledVector(_up, Math.sin(ang) * rad).normalize();
    }

    _origin.copy(this.camera.position).addScaledVector(_dir, 0.4);
    // Signature is fixed at five arguments on purpose: match.ts wraps
    // ballistics.fire to log who fired, and a sixth argument would be dropped
    // by that wrapper. Per-weapon behaviour goes in the four values it does
    // carry, never in a new parameter.
    this.ballistics.fire(_origin, _dir, p.muzzleSpeed, p.baseDamage, this.ownerCapsuleId);

    // ---- what the shot does to the shooter --------------------------------
    const r = p.recoil;
    const speed01 = clamp01(pl.speed2D / Math.max(0.1, MOVE.sprintSpeed));
    const scale =
      (1 + (r.adsScale - 1) * this.adsBlend) *
      (r.crouchScale + (1 - r.crouchScale) * clamp01(pl.stance01)) *
      (pl.grounded ? 1 : r.airScale) *
      (1 + (r.moveScale - 1) * speed01);

    this.recoil.shoot(r, scale, _kick);
    // The permanent share goes straight in and is never taken back — this is
    // the part the player learns to pull down against.
    this.addAim(_kick.v * DEG, _kick.h * DEG);

    this.bloom = Math.min(p.spread.bloomMax, this.bloom + p.spread.bloomPerShot);
    this.onShot?.();
  }

  // --- selector binding ----------------------------------------------------

  /**
   * core/input.ts has no spare action and belongs to another lane, so the
   * selector listens for its own key the same way ui/hud.ts listens for its
   * review keys. If a `firemode` binding is ever added upstream, fixedUpdate
   * picks it up through the normal channel and this stays harmless — both
   * routes set one pending flag that is consumed once per tick.
   */
  private installSelectorKey(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', (e) => {
      if (e.code !== this.profile.selectorKey) return;
      if (!this.input.isLocked) return;
      this.modeTogglePending = true;
    });
  }

  /**
   * Live tuning and a numeric probe, on their own global rather than in
   * main.ts's `__TEST__` (not this lane's file). `__WEAPON__.tune` is the same
   * contract as `__MOVE__`: poke a value, the next round uses it.
   */
  private publishDebugHooks(): void {
    if (typeof window === 'undefined') return;
    const w = globalThis as unknown as Record<string, unknown>;
    w.__WEAPON__ = {
      tune: this.profile,
      weapon: this,
      /** Cumulative pattern in degrees, the shape a player memorises. */
      pattern: (n = this.profile.magSize) => {
        const out: { shot: number; v: number; h: number }[] = [];
        let v = 0;
        let h = 0;
        const k: RecoilKick = { v: 0, h: 0 };
        for (let i = 0; i < n; i++) {
          recoilForShot(this.profile.recoil, i, k);
          v += k.v;
          h += k.h;
          out.push({ shot: i, v: +v.toFixed(3), h: +h.toFixed(3) });
        }
        return out;
      },
      /** Cone in degrees for a hypothetical player state. */
      cone: (over: Partial<SpreadInputs> = {}) =>
        spreadDeg(this.profile.spread, { ...this.spreadInputs(), ...over }),
      /** Rounds to kill by zone at a range. */
      ttk: (dist = 0, hp = 100) => ({
        head: hitsToKill(this.profile.baseDamage, 'head', dist, hp),
        chest: hitsToKill(this.profile.baseDamage, 'chest', dist, hp),
        abdomen: hitsToKill(this.profile.baseDamage, 'abdomen', dist, hp),
        leg: hitsToKill(this.profile.baseDamage, 'leg', dist, hp),
        falloff: +rangeFalloff(dist).toFixed(3),
        mult: ZONE_MULT,
      }),
      state: () => ({
        ammo: this.ammo,
        reserve: this.reserve,
        phase: this.phase,
        mode: this.fireMode,
        spreadDeg: +this.spreadCache.toFixed(4),
        bloom: +this.bloom.toFixed(3),
        ads: +this.adsBlend.toFixed(3),
        pattern: this.recoil.index,
        climbDeg: +this.recoil.climbPitch.toFixed(3),
        pitchDeg: +(this.player.pitch / DEG).toFixed(3),
        yawDeg: +(this.player.yaw / DEG).toFixed(3),
      }),
      setMode: (m: FireMode) => {
        this.fireMode = m;
        this.onFireModeChange?.(m);
        return this.fireMode;
      },
    };
  }
}
