import * as THREE from 'three';
import { hash2 } from '../gen/noise';
import type { Heightfield } from '../gen/terraingen';
import type { PhysicsWorld } from '../player/physics';
import type { Ballistics } from '../weapons/ballistics';
import type { LootField, LootItem } from '../match/loot';

// Shared vocabulary for the AI layer. Everything the bots reason about — other
// combatants, the zone, the ray budget, the fire governor — is described here
// so no module has to import another module's class just to read a position.

/** The player is always combatant 0; bots are 1..N. */
export const PLAYER_CID = 0;

/**
 * Anything a bot can shoot at or be shot by. Bots implement this; the player is
 * wrapped by ExternalCombatant. Target selection, perception and threat memory
 * only ever see this interface, which is exactly why bots can now fight each
 * other: nothing in the AI knows what a "player" is.
 */
export interface Combatant {
  /** Stable id inside the AI layer (NOT the bot's display id). */
  readonly cid: number;
  /** Physics capsule id, so LOS rays can identify a hit on this body. */
  readonly capsuleId: number;
  readonly isPlayer: boolean;
  readonly name: string;
  readonly alive: boolean;
  readonly hp: number;
  /** Foot position. */
  readonly pos: THREE.Vector3;
  /** World velocity, m/s. Drives target leading. */
  readonly vel: THREE.Vector3;
  /** Height of the eyes above the feet right now (crouch included). */
  readonly eyeHeight: number;
  /** Sim time this combatant last fired; a fresh shot is a loud cue. */
  readonly lastFiredT: number;
  /** False parks a body out of the simulation (drills only). */
  readonly simEnabled: boolean;
}

export function eyeOf(c: Combatant, out: THREE.Vector3): THREE.Vector3 {
  return out.set(c.pos.x, c.pos.y + c.eyeHeight, c.pos.z);
}

/** Centre of mass — what a bot actually aims at and rays against. */
export function chestOf(c: Combatant, out: THREE.Vector3): THREE.Vector3 {
  return out.set(c.pos.x, c.pos.y + c.eyeHeight * 0.78, c.pos.z);
}

/**
 * A combatant driven from outside the AI layer (the player). Match syncs it
 * once per tick; velocity is differentiated here so leading a strafing player
 * works without the controller having to expose one.
 */
export class ExternalCombatant implements Combatant {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  alive = true;
  hp = 100;
  eyeHeight = 1.68;
  lastFiredT = -99;
  simEnabled = true;
  private prev = new THREE.Vector3();
  private primed = false;

  constructor(
    readonly cid: number,
    readonly capsuleId: number,
    readonly name: string,
    readonly isPlayer = true
  ) {}

  sync(pos: THREE.Vector3, alive: boolean, hp: number, dt: number): void {
    if (!this.primed) {
      this.prev.copy(pos);
      this.primed = true;
    }
    if (dt > 0) this.vel.subVectors(pos, this.prev).divideScalar(dt);
    this.prev.copy(pos);
    this.pos.copy(pos);
    this.alive = alive;
    this.hp = hp;
  }

  noteFired(t: number): void {
    this.lastFiredT = t;
  }
}

/**
 * Deterministic per-agent random stream. Math.random is banned in simulation
 * paths; every draw here is a pure function of (seed, call index), so a replay
 * of the same tick sequence produces the same match.
 */
export class DetRng {
  private n = 0;

  constructor(private seed: number) {}

  next(): number {
    this.n = (this.n + 1) | 0;
    return hash2(this.seed, this.n);
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Symmetric [-1, 1]. */
  signed(): number {
    return this.next() * 2 - 1;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

/**
 * Global line-of-sight ray allowance per fixed tick.
 *
 * A LOS ray is the single most expensive thing this AI does: PhysicsWorld
 * marches ~100 heightfield samples (each one a stack of fBm octaves) and tests
 * every one of ~3000 tree/building AABBs. Fifteen bots each checking fifteen
 * candidates would be ~900 rays/second and would eat the frame on an HD 620.
 * So rays are rationed: perception asks for what it wants, gets what is left,
 * and falls back on memory for the rest. Cheap filters (range, view cone,
 * recency) run first so the rays that are spent are the ones that matter.
 */
export class RayBudget {
  perTick = 3;
  private left = 0;
  /** Diagnostics for the AI test harness. */
  spent = 0;
  denied = 0;

  begin(): void {
    this.left = this.perTick;
  }

  take(n = 1): boolean {
    if (this.left < n) {
      this.denied += n;
      return false;
    }
    this.left -= n;
    this.spent += n;
    return true;
  }

  get remaining(): number {
    return this.left;
  }
}

/**
 * Token bucket over ALL bot muzzles. Every live bullet re-raycasts the world
 * each tick, so an unbounded fifteen-way brawl is a frame-time cliff. Bots that
 * cannot get a token simply hold the trigger a few ticks longer, which reads as
 * fire discipline rather than a stutter.
 */
export class FireGovernor {
  private tokens: number;

  constructor(private ratePerSecond = 26, private capacity = 14) {
    this.tokens = capacity;
  }

  update(dt: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + this.ratePerSecond * dt);
  }

  tryTake(): boolean {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface ZoneInfo {
  center: THREE.Vector3;
  radius: number;
  /** Where the NEXT circle will be — bots move to it before it closes. */
  nextCenter: THREE.Vector3;
  nextRadius: number;
  /** Seconds until the current circle starts shrinking (0 while shrinking). */
  countdown: number;
  shrinking: boolean;
  dps: number;
}

export interface AiEvents {
  /** A bot pulled the trigger: audio, tracers, and noise propagation. */
  onShoot(shooter: Combatant, from: THREE.Vector3, dir: THREE.Vector3, damage: number): void;
  /** A bot picked something up. */
  onLoot(shooter: Combatant, item: LootItem): void;
  /** State transition worth surfacing (audio hooks, debug overlays). */
  onBotEvent?(shooter: Combatant, event: string): void;
}

/** Everything a bot needs from the outside world, assembled once per tick. */
export interface AiContext {
  world: PhysicsWorld;
  hf: Heightfield;
  ballistics: Ballistics;
  loot: LootField | null;
  zone: ZoneInfo;
  /** Every combatant in the match, player included. */
  combatants: Combatant[];
  /** Seconds since match start, accumulated from the fixed step. */
  time: number;
  budget: RayBudget;
  /**
   * Cover searches draw from their OWN pool. Sharing perception's budget meant
   * a cover query could only ever test three or four candidate positions
   * before running dry, which on open farmland is nowhere near enough to find
   * the one tree that breaks the line — bots "looked for cover", failed, and
   * stood in the field. The pool is rationed by the director instead: a cover
   * query is allowed only every third tick, so the worst case is bounded.
   */
  coverBudget: RayBudget;
  /** Cover searches allowed this tick across the WHOLE match. */
  coverQueriesLeft: number;
  governor: FireGovernor;
  /** Camera position — drives update LOD only, never behaviour. */
  focus: THREE.Vector3;
  events: AiEvents;
}
