import * as THREE from 'three';
import type { PhysicsWorld } from '../player/physics';
import type { Heightfield } from '../gen/terraingen';
import type { Ballistics } from '../weapons/ballistics';
import type { LootField } from '../match/loot';
import { Bot } from './bot';
import {
  FireGovernor,
  RayBudget,
  type AiContext,
  type AiEvents,
  type Combatant,
  type ZoneInfo,
} from './types';

// The director owns everything shared between bots: the combatant list, the
// per-tick ray budget, the global fire governor and the simulation clock. Bots
// know nothing about each other except through the combatant list, so adding a
// second player or a third faction later is a list entry, not a rewrite.

/**
 * Update fidelity by distance from the camera: 60 Hz inside 140 m, 30 Hz out to
 * 380 m, 15 Hz beyond. It scales the TICK RATE only — never accuracy, never
 * damage, never whether a bot can see you. A fight happening 500 m away still
 * resolves properly, it just thinks less often, and nobody can see it anyway.
 */
function lodFor(distSq: number): number {
  if (distSq < 140 * 140) return 0;
  if (distSq < 380 * 380) return 1;
  return 2;
}

export class BotDirector {
  readonly bots: Bot[] = [];
  readonly budget = new RayBudget();
  /** Separate pool: a cover search needs to test enough places to find one. */
  readonly coverBudget = new RayBudget();
  readonly governor = new FireGovernor();
  time = 0;
  private tick = 0;

  private ctx: AiContext;
  private combatants: Combatant[] = [];

  constructor(
    world: PhysicsWorld,
    hf: Heightfield,
    ballistics: Ballistics,
    loot: LootField | null,
    zone: ZoneInfo,
    events: AiEvents
  ) {
    this.ctx = {
      world,
      hf,
      ballistics,
      loot,
      zone,
      combatants: this.combatants,
      time: 0,
      budget: this.budget,
      coverBudget: this.coverBudget,
      coverQueriesLeft: 1,
      governor: this.governor,
      focus: new THREE.Vector3(),
      events,
    };
  }

  add(bot: Bot): void {
    this.bots.push(bot);
    this.combatants.push(bot);
  }

  /** Register a non-bot fighter (the player, or a drill stand-in). */
  addCombatant(c: Combatant): void {
    this.combatants.push(c);
  }

  removeCombatant(c: Combatant): void {
    const i = this.combatants.indexOf(c);
    if (i >= 0) this.combatants.splice(i, 1);
  }

  get context(): AiContext {
    return this.ctx;
  }

  /** Broadcast a gunshot: every bot in earshot gets a bearing, nobody gets a name. */
  broadcastShot(from: THREE.Vector3, shooterCid: number): void {
    for (const bot of this.bots) {
      if (!bot.alive || !bot.simEnabled || bot.cid === shooterCid) continue;
      bot.hearShot(from, shooterCid);
    }
  }

  fixedUpdate(dt: number, focus: THREE.Vector3): void {
    this.time += dt;
    this.ctx.time = this.time;
    this.ctx.focus.copy(focus);
    this.budget.begin();
    // One cover search every fourth tick, worth six rays, across the whole
    // match. Terrain candidates cost no ray at all (profile test), so a search
    // now examines every candidate position and only pays for the ones
    // standing in open ground.
    this.tick++;
    this.coverBudget.perTick = 6;
    this.coverBudget.begin();
    this.ctx.coverQueriesLeft = this.tick % 4 === 0 ? 1 : 0;
    this.governor.update(dt);

    for (const bot of this.bots) {
      if (!bot.simEnabled) continue;
      const dx = bot.pos.x - focus.x;
      const dz = bot.pos.z - focus.z;
      const lod = lodFor(dx * dx + dz * dz);
      // A bot's whole update, not just its perception, runs at the LOD rate.
      // The
      // measured cost of one bot tick is dominated by a single moveCapsule
      // (~0.4 ms on the target machine, because the collider list is a linear
      // walk of 3000 trees), so thinning the tick rate for bots nobody can see
      // is worth more than any micro-optimisation inside the AI. Ticks are
      // staggered by bot id so the cheap frames stay cheap.
      const stride = lod === 0 ? 1 : lod === 1 ? 2 : 4;
      if (stride > 1 && (this.tick + bot.id) % stride !== 0) continue;
      bot.fixedUpdate(dt * stride, this.ctx, lod);
    }
  }

  aliveBots(): number {
    let n = 0;
    for (const b of this.bots) if (b.alive) n++;
    return n;
  }

  botByCapsule(capsuleId: number): Bot | null {
    for (const b of this.bots) if (b.capsuleId === capsuleId) return b;
    return null;
  }
}
