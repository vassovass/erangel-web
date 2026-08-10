import * as THREE from 'three';
import { chestOf, eyeOf, type AiContext, type Combatant } from './types';
import type { BotProfile } from './profiles';
import { losClear, terrainBlocks } from './los';

// What a bot knows, and how stale it is.
//
// The rule that makes bot-vs-bot fights fair — and makes losing to one feel
// fair — is that there is exactly ONE perception path. A bot learns about the
// player the same way it learns about another bot: view cone, range, a real
// line-of-sight ray, hearing, and being shot. Nothing here reads a position it
// has not earned.

export interface TargetMemory {
  cid: number;
  /** Refreshed by rays; goes stale (false) if nothing confirms it. */
  visible: boolean;
  /** Sim time of the last confirmed sighting. */
  lastSeenT: number;
  lastSeenPos: THREE.Vector3;
  lastSeenVel: THREE.Vector3;
  /** Sim time this perception last spent a ray on this target. */
  checkedT: number;
  /** Sim time continuous sight began — drives reaction and aim settling. */
  contactT: number;
  /** 0..1. Reaches 1 after `reactionS` of sight; the trigger unlocks at 1. */
  awareness: number;
  /** Decaying total of damage received from this target. */
  damage: number;
  damageT: number;
  /** Last audible cue and where it seemed to come from. */
  heardT: number;
  heardPos: THREE.Vector3;
}

const PERCEPTION_DT = [0.25, 0.4, 0.7];

function newMemory(cid: number): TargetMemory {
  return {
    cid,
    visible: false,
    lastSeenT: -999,
    lastSeenPos: new THREE.Vector3(),
    lastSeenVel: new THREE.Vector3(),
    checkedT: -999,
    contactT: -999,
    awareness: 0,
    damage: 0,
    damageT: -999,
    heardT: -999,
    heardPos: new THREE.Vector3(),
  };
}

const _self = new THREE.Vector3();
const _tgt = new THREE.Vector3();

interface Candidate {
  c: Combatant;
  mem: TargetMemory;
  dist: number;
  priority: number;
}

export class Perception {
  readonly memory = new Map<number, TargetMemory>();
  private clock: number;
  private candidates: Candidate[] = [];
  /** Diagnostics. */
  raysThisTick = 0;

  constructor(stagger: number) {
    // Stagger the 4Hz perception tick across bots so fifteen of them never
    // land their rays on the same frame.
    this.clock = stagger * PERCEPTION_DT[0];
  }

  get(cid: number): TargetMemory | undefined {
    return this.memory.get(cid);
  }

  ensure(cid: number): TargetMemory {
    let m = this.memory.get(cid);
    if (!m) {
      m = newMemory(cid);
      this.memory.set(cid, m);
    }
    return m;
  }

  /** A shot, footstep or explosion heard from roughly `pos`. */
  noteNoise(cid: number, pos: THREE.Vector3, t: number, profile: BotProfile, selfPos: THREE.Vector3): void {
    const d = Math.hypot(pos.x - selfPos.x, pos.z - selfPos.z);
    if (d > profile.hearingRange) return;
    const m = this.ensure(cid);
    // Localisation error: a recruit hears "over there", an elite hears the
    // hedgerow. Error grows with distance and shrinks with skill.
    const err = (d / 90) * (1.6 - profile.suppressionResist);
    m.heardT = t;
    m.heardPos.set(pos.x + err * Math.sin(d * 1.7), pos.y, pos.z + err * Math.cos(d * 2.3));
    if (t - m.lastSeenT > 2) m.awareness = Math.max(m.awareness, 0.25);
  }

  /** Took a round from `cid`, which was standing at `attackerPos`. */
  noteDamage(cid: number, amount: number, attackerPos: THREE.Vector3 | null, t: number): void {
    const m = this.ensure(cid);
    m.damage += amount;
    m.damageT = t;
    if (attackerPos) {
      m.heardT = t;
      m.heardPos.copy(attackerPos);
      if (t - m.lastSeenT > 1.5) {
        m.lastSeenPos.copy(attackerPos);
        m.lastSeenVel.set(0, 0, 0);
      }
    }
    // Being hit snaps attention onto the shooter but does NOT hand over aim:
    // awareness still has to climb the rest of the way before the trigger works.
    m.awareness = Math.max(m.awareness, 0.4);
  }

  /**
   * Advance memory, and spend up to a couple of rays on the targets most worth
   * confirming. `lodLevel` slows the tick for bots far from the camera.
   */
  update(
    self: Combatant,
    yaw: number,
    profile: BotProfile,
    ctx: AiContext,
    dt: number,
    engagedCid: number,
    lodLevel: number
  ): void {
    const t = ctx.time;

    // Continuous decay, every tick, so reaction and memory are smooth.
    for (const m of this.memory.values()) {
      if (m.visible) {
        m.awareness = Math.min(1, m.awareness + dt / Math.max(0.05, profile.reactionS));
      } else {
        // Pre-aim: skill buys a slow bleed, so a veteran that loses a target
        // for a second re-acquires almost instantly while a recruit starts over.
        m.awareness = Math.max(0, m.awareness - dt / Math.max(0.4, profile.memoryS * 0.5));
      }
      m.damage *= Math.exp(-dt / 6);
    }

    this.clock -= dt;
    if (this.clock > 0) return;
    this.clock = PERCEPTION_DT[Math.min(lodLevel, PERCEPTION_DT.length - 1)];
    this.raysThisTick = 0;

    eyeOf(self, _self);
    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    const cosFov = Math.cos(THREE.MathUtils.degToRad(profile.fovDeg * 0.5));

    this.candidates.length = 0;
    for (const c of ctx.combatants) {
      if (c.cid === self.cid || !c.alive || !c.simEnabled) continue;
      const dx = c.pos.x - self.pos.x;
      const dz = c.pos.z - self.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > profile.viewRange) continue;

      const mem = this.ensure(c.cid);
      // Anything not re-confirmed within half a second is no longer "visible";
      // memory takes over from here.
      if (t - mem.checkedT > 0.5) mem.visible = false;

      const inv = dist > 0.001 ? 1 / dist : 0;
      const dot = (dx * fwdX + dz * fwdZ) * inv;
      const recentContact = t - mem.lastSeenT < profile.memoryS;
      const recentNoise = t - mem.heardT < 5;
      const recentHurt = t - mem.damageT < 6;
      // Peripheral allowance: a threat you are already fighting stays trackable
      // a little wider than a stranger, and anything inside 14 m is heard as
      // much as seen. Outside that, what is behind you is genuinely unseen —
      // no ray is spent, so a bot cannot "notice" a flank it never looked at.
      const cone = c.cid === engagedCid ? Math.cos(THREE.MathUtils.degToRad(profile.fovDeg * 0.5 + 22)) : cosFov;
      const inCone = dot > cone || dist < 14;
      if (!inCone) continue;

      let priority = 260 - dist * 0.4;
      if (c.cid === engagedCid) priority += 900;
      if (recentContact) priority += 420;
      if (recentHurt) priority += 300;
      if (recentNoise) priority += 160;
      priority += Math.max(0, dot) * 120; // nearer the crosshair, checked first
      // Somebody who just fired is louder than somebody sneaking.
      if (t - c.lastFiredT < 1.2) priority += 140;
      this.candidates.push({ c, mem, dist, priority });
    }

    if (this.candidates.length === 0) return;
    this.candidates.sort((a, b) => b.priority - a.priority);

    const maxChecks = engagedCid >= 0 ? 3 : 2;
    let checks = 0;
    for (const cand of this.candidates) {
      if (checks >= maxChecks) break;
      chestOf(cand.c, _tgt);
      // Ground profile first — it is an order of magnitude cheaper than a full
      // raycast and it settles a large fraction of long sight lines without
      // touching the ray budget at all.
      if (terrainBlocks(ctx.hf, _self, _tgt)) {
        cand.mem.checkedT = t;
        cand.mem.visible = false;
        continue;
      }
      if (!ctx.budget.take(1)) break;
      checks++;
      this.raysThisTick++;

      const seen = losClear(ctx.world, _self, _tgt, self.capsuleId, cand.c.capsuleId, 0.5);
      cand.mem.checkedT = t;
      if (seen) {
        if (!cand.mem.visible) cand.mem.contactT = t;
        cand.mem.visible = true;
        cand.mem.lastSeenT = t;
        cand.mem.lastSeenPos.copy(cand.c.pos);
        cand.mem.lastSeenVel.copy(cand.c.vel);
      } else {
        cand.mem.visible = false;
      }
    }
  }
}
