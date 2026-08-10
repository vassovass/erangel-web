import * as THREE from 'three';
import { buildCharacter, poseCharacter, type CharacterRig } from '../gen/charactergen';
import type { PhysicsWorld } from '../player/physics';
import type { LootItem } from '../match/loot';
import {
  chestOf,
  DetRng,
  eyeOf,
  type AiContext,
  type Combatant,
} from './types';
import { PROFILES, profileForBot, tierForBot, type BotProfile, type SkillTier } from './profiles';
import { Perception, type TargetMemory } from './perception';
import { selectTarget, type ThreatChoice } from './threat';
import { findCover, coverStillValid, type CoverSpot } from './cover';
import { BOT_DAMAGE, BULLET_SPEED, Firearm, solveAim } from './firecontrol';
import { Locomotion, pickWanderTarget, zonePlan, RUN, SPRINT, WALK } from './navigation';

// The behaviour layer.
//
// Everything expensive or reusable lives in its own module (perception, threat,
// cover, fire control, navigation); what is left here is the decision: given
// what I know, what am I doing this second. The states are deliberately few and
// each one is something you could narrate while watching:
//
//   patrol      wander toward the circle, pick up anything useful on the way
//   loot        walk to a crate and take it
//   investigate go and look at where that noise came from
//   engage      fight the thing I can see
//   cover       fight it from behind something, peeking, reloading in safety
//   retreat     I am losing this — break contact, patch up, come back
//   heal        stationary, bandaging, interruptible
//   zone        get inside the next circle
//   dead        fall over

export type BotState =
  | 'patrol'
  | 'loot'
  | 'investigate'
  | 'engage'
  | 'cover'
  | 'retreat'
  | 'heal'
  | 'zone'
  | 'dead';

const MAX_HP = 100;
const EYE_HEIGHT = 1.6;

const _eye = new THREE.Vector3();
const _aimPoint = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class Bot implements Combatant {
  /**
   * Skeleton posing is presentation only — nothing in the AI reads the rig.
   * The drill harness switches it off so a 90-second brawl is not 80,000
   * pointless skinning solves. Never touched by the game.
   */
  static posing = true;

  readonly rig: CharacterRig;
  readonly id: number;
  readonly cid: number;
  readonly name: string;
  readonly isPlayer = false;
  readonly capsuleId: number;
  readonly perception: Perception;

  state: BotState = 'patrol';
  hp = MAX_HP;
  simEnabled = true;
  lastFiredT = -999;

  profile: BotProfile;
  tier: SkillTier;
  firearm: Firearm;
  medkits = 0;
  bandages = 0;

  private loco: Locomotion;
  private rng: DetRng;
  private now = 0;
  private stateT = 0;
  private aimPitch = 0;
  private deadT = 0;
  private lastHurtT = -999;
  private suppression = 0;
  private targetCid = -1;

  // patrol / navigation
  private wander = new THREE.Vector3();
  private wanderTimer = 0;
  private zoneTarget = new THREE.Vector3();
  private zoneUrgent = false;
  private zoneCheckT = -999;
  private zoneHasPlan = false;

  // cover
  private coverSpot: CoverSpot | null = null;
  private coverArrived = false;
  private coverQueryT = -999;
  private coverCheckT = -999;
  private peeking = false;
  private peekT = 0;
  private peekSide = 1;

  // combat bookkeeping
  private exposedT = 0;
  private retreatT = 0;
  private investigatePos = new THREE.Vector3();

  // heal
  private healLeft = 0;
  private healAmount = 0;

  // loot
  private lootTarget: LootItem | null = null;
  private lootCheckT = -999;

  constructor(
    id: number,
    spawn: THREE.Vector3,
    private world: PhysicsWorld,
    tier?: SkillTier
  ) {
    this.id = id;
    this.cid = id + 1; // 0 is the player
    this.name = `Bot_${id + 1}`;
    this.tier = tier ?? tierForBot(id);
    this.profile = tier ? PROFILES[tier] : profileForBot(id);
    this.rig = buildCharacter(1000 + id * 17);
    this.rng = new DetRng(9001 + id * 7919);
    this.loco = new Locomotion(spawn, this.rng.next() * Math.PI * 2);
    this.perception = new Perception(this.rng.next());
    this.firearm = new Firearm(this.profile, this.startingReserve());
    this.medkits = this.profile.usesHeals ? (this.rng.chance(0.45) ? 1 : 0) : 0;
    this.bandages = this.profile.usesHeals ? 1 + Math.floor(this.rng.next() * 3) : 0;
    this.capsuleId = world.addCapsule(this.loco.pos, 0.36, 1.72, `bot:${id}`);
    // First patrol tick picks a real destination — zone state is not known yet.
    this.wander.copy(spawn);
  }

  // --- Combatant ------------------------------------------------------------

  get pos(): THREE.Vector3 {
    return this.loco.pos;
  }

  get vel(): THREE.Vector3 {
    return this.loco.vel;
  }

  get eyeHeight(): number {
    return EYE_HEIGHT;
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  get yaw(): number {
    return this.loco.yaw;
  }

  /** Test/telemetry surface. */
  get ammo(): number {
    return this.firearm.ammo;
  }

  get reserve(): number {
    return this.firearm.reserve;
  }

  get reloading(): boolean {
    return this.firearm.reloading;
  }

  get reloads(): number {
    return this.firearm.reloadsCompleted;
  }

  get targetId(): number {
    return this.targetCid;
  }

  private startingReserve(): number {
    return Math.round(60 + this.profile.rank * 26 + this.rng.next() * 30);
  }

  // --- external events ------------------------------------------------------

  /**
   * Took a round. `fromCid` and `attackerPos` are what make a firefight
   * two-sided: the victim learns roughly where the shot came from, which is
   * what drives it into cover or onto the attacker.
   */
  damage(amount: number, fromCid = -1, attackerPos: THREE.Vector3 | null = null): void {
    if (!this.alive) return;
    this.hp -= amount;
    this.lastHurtT = this.now;
    this.suppression = Math.min(1, this.suppression + amount / 45);
    if (fromCid >= 0) this.perception.noteDamage(fromCid, amount, attackerPos, this.now);
    if (this.healLeft > 0) this.abortHeal();
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'dead';
      this.stateT = 0;
      this.world.updateCapsule(this.capsuleId, this.loco.pos, false);
    }
  }

  /** A shot was heard from `from`. Defaults to the player, who is combatant 0. */
  hearShot(from: THREE.Vector3, shooterCid = 0): void {
    if (!this.alive || shooterCid === this.cid) return;
    this.perception.noteNoise(shooterCid, from, this.now, this.profile, this.loco.pos);
  }

  // --- drill hooks (used by tools/ai-test.mjs through match.ts) -------------

  setTier(tier: SkillTier): void {
    this.tier = tier;
    this.profile = PROFILES[tier];
    this.firearm = new Firearm(this.profile, this.startingReserve());
  }

  setSimEnabled(on: boolean): void {
    this.simEnabled = on;
    this.world.updateCapsule(this.capsuleId, this.loco.pos, on && this.alive);
  }

  /** Put the bot back on its feet at a known spot with a full magazine. */
  resetTo(pos: THREE.Vector3, yaw: number, hp = MAX_HP): void {
    this.loco.pos.copy(pos);
    this.loco.yaw = yaw;
    this.loco.vel.set(0, 0, 0);
    this.hp = hp;
    this.state = 'patrol';
    this.stateT = 0;
    this.deadT = 0;
    this.suppression = 0;
    this.targetCid = -1;
    this.exposedT = 0;
    this.retreatT = 0;
    // Walk forward, not in a random direction: a drill that begins with the
    // bot spinning on the spot measures the spin, not the behaviour.
    this.wanderTimer = 5;
    this.wander.set(pos.x + Math.sin(yaw) * 20, pos.y, pos.z + Math.cos(yaw) * 20);
    this.zoneHasPlan = false;
    this.zoneCheckT = -999;
    this.lootCheckT = -999;
    this.lastFiredT = -999;
    this.lastHurtT = -999;
    this.perception.memory.clear();
    this.firearm = new Firearm(this.profile, this.startingReserve());
    this.clearCover();
    this.lootTarget = null;
    this.healLeft = 0;
    this.world.updateCapsule(this.capsuleId, this.loco.pos, this.simEnabled);
  }

  // --- main tick ------------------------------------------------------------

  fixedUpdate(dt: number, ctx: AiContext, lod = 0): void {
    this.now = ctx.time;
    if (this.state === 'dead') {
      if (this.deadT < 1) {
        this.deadT = Math.min(1, this.deadT + dt * 1.6);
        this.pose();
      }
      return;
    }
    if (!this.simEnabled) return;

    this.stateT += dt;
    this.suppression *= Math.exp(-dt / 2.6);
    this.firearm.update(dt);
    this.loco.beginTick(dt, this.rng);

    this.perception.update(this, this.loco.yaw, this.profile, ctx, dt, this.targetCid, lod);
    const choice = selectTarget(this, this.perception, this.profile, ctx, this.targetCid);
    this.think(ctx, choice);
    this.act(dt, ctx, choice);

    this.loco.endTick(dt, this.world);
    this.world.updateCapsule(this.capsuleId, this.loco.pos, true);
    this.pose();
  }

  // --- decision -------------------------------------------------------------

  private setState(s: BotState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateT = 0;
    if (s !== 'cover' && s !== 'retreat') this.clearCover();
    if (s !== 'loot') this.lootTarget = null;
  }

  private think(ctx: AiContext, choice: ThreatChoice): void {
    const t = ctx.time;
    const target = choice.target;
    // Fall back to the memory of whoever we were last fighting. Without this,
    // the moment threat selection drops a contact the bot loses the pointer to
    // everything it knew about them and goes back to patrolling — mid duel.
    const mem = target
      ? this.perception.ensure(target.cid)
      : this.targetCid >= 0
        ? this.perception.get(this.targetCid) ?? null
        : null;

    // Healing is a commitment. It ends by finishing, by being shot, or by
    // somebody walking into view.
    if (this.state === 'heal') {
      const hurt = t - this.lastHurtT < 0.6;
      const seen = !!(mem && mem.visible);
      if (!hurt && !seen && this.healLeft > 0) return;
      this.abortHeal();
    }

    // "Hot" = there is a fight on. Gunfire you can hear counts: walking off to
    // patrol while rounds are still cracking overhead is exactly the kind of
    // thing that read as "not very good".
    const hot = !!(
      mem &&
      (mem.visible || t - mem.lastSeenT < 5 || t - mem.damageT < 5 || t - mem.heardT < 3)
    );

    if (hot && target) {
      this.targetCid = target.cid;
      if (this.state === 'retreat') return; // retreat runs to its own exit
      // Out of ammunition entirely is the same emergency as being shot to
      // pieces: get away from whoever still has some.
      const empty = this.firearm.ammo <= 0 && this.firearm.reserve <= 0;
      if (empty || this.hp <= this.profile.retreatHp * MAX_HP) {
        this.setState('retreat');
        this.retreatT = 0;
        return;
      }
      if (this.state !== 'engage' && this.state !== 'cover') this.setState('engage');
      return;
    }

    // Contact lost.
    if (this.state === 'engage' || this.state === 'cover' || this.state === 'retreat') {
      const last = mem && t - mem.lastSeenT < 16 ? mem.lastSeenPos : mem && t - mem.heardT < 16 ? mem.heardPos : null;
      if (last) {
        this.investigatePos.copy(last);
        this.setState('investigate');
      } else {
        this.setState('patrol');
      }
      this.targetCid = -1;
      return;
    }
    this.targetCid = target ? target.cid : -1;

    // Out of contact: survival chores in priority order.
    if (this.wantsHeal() && this.hasHeal()) {
      this.startHeal();
      return;
    }
    if (t - this.zoneCheckT > 2) {
      this.zoneCheckT = t;
      const zp = zonePlan(ctx, this, this.profile);
      this.zoneHasPlan = !!zp;
      if (zp) {
        this.zoneTarget.set(zp.x, 0, zp.z);
        this.zoneUrgent = zp.urgent;
      }
    }
    if (this.zoneHasPlan) {
      this.setState('zone');
      return;
    }
    if (this.state === 'zone') this.setState('patrol');
    if (this.state === 'investigate' && this.stateT > 13) this.setState('patrol');
    if (this.state === 'investigate') return;

    if (this.state === 'loot' && this.lootTarget && !this.lootTarget.taken) return;
    if (this.considerLoot(ctx)) {
      this.setState('loot');
      return;
    }
    if (this.state !== 'patrol') this.setState('patrol');
  }

  // --- action ---------------------------------------------------------------

  private act(dt: number, ctx: AiContext, choice: ThreatChoice): void {
    const target = choice.target;
    const mem = target ? this.perception.ensure(target.cid) : null;
    switch (this.state) {
      case 'engage':
        if (target && mem) this.doEngage(dt, ctx, target, mem);
        else this.setState('patrol');
        break;
      case 'cover':
        if (target && mem) this.doCover(dt, ctx, target, mem);
        else this.setState('patrol');
        break;
      case 'retreat':
        this.doRetreat(dt, ctx, target, mem);
        break;
      case 'heal':
        this.doHeal(dt);
        break;
      case 'investigate':
        this.doInvestigate(dt);
        break;
      case 'loot':
        this.doLoot(dt, ctx);
        break;
      case 'zone':
        this.doZone(dt);
        break;
      default:
        this.doPatrol(dt, ctx);
        break;
    }
  }

  private doPatrol(dt: number, ctx: AiContext): void {
    this.loco.crouch = 0;
    this.wanderTimer -= dt;
    const dist = this.loco.seek(dt, this.wander.x, this.wander.z, WALK * 0.85, this.world);
    if (dist < 2.5 || this.wanderTimer <= 0) {
      this.wanderTimer = 6 + this.rng.next() * 8;
      pickWanderTarget(ctx, this, this.rng, this.wander);
    }
    if (this.firearm.wantsReload(this.profile) || this.firearm.wantsTopUp()) {
      this.firearm.startReload(this.profile);
    }
  }

  private doZone(dt: number): void {
    this.loco.crouch = 0;
    const speed = this.zoneUrgent ? SPRINT : RUN * 0.92;
    const d = this.loco.seek(dt, this.zoneTarget.x, this.zoneTarget.z, speed, this.world);
    if (d < 3) {
      this.zoneHasPlan = false;
      this.zoneCheckT = -999;
      this.setState('patrol');
    }
    if (this.firearm.wantsReload(this.profile) || this.firearm.wantsTopUp()) {
      this.firearm.startReload(this.profile);
    }
  }

  private doInvestigate(dt: number): void {
    this.loco.crouch = 0;
    const d = this.loco.seek(dt, this.investigatePos.x, this.investigatePos.z, RUN * 0.75, this.world);
    if (d < 5) {
      // Arrived: sweep the area rather than standing like a lamp post.
      this.loco.turnTo(dt, this.loco.yaw + Math.sin(this.stateT * 0.9) * 1.4, 1.6);
      this.loco.hold();
    }
    if (this.firearm.wantsReload(this.profile) || this.firearm.wantsTopUp()) {
      this.firearm.startReload(this.profile);
    }
  }

  private doLoot(dt: number, ctx: AiContext): void {
    const item = this.lootTarget;
    if (!item || item.taken || !ctx.loot) {
      this.lootTarget = null;
      this.setState('patrol');
      return;
    }
    this.loco.crouch = 0;
    const d = this.loco.seek(dt, item.pos.x, item.pos.z, RUN * 0.8, this.world);
    if (d < 1.8) {
      ctx.loot.take(item);
      if (item.type === 'ammo') this.firearm.reserve += 30;
      else if (item.type === 'medkit') this.medkits++;
      else this.bandages++;
      ctx.events.onLoot(this, item);
      this.lootTarget = null;
      this.setState('patrol');
    }
    if (this.stateT > 22) {
      this.lootTarget = null;
      this.setState('patrol');
    }
  }

  private considerLoot(ctx: AiContext): boolean {
    if (!ctx.loot) return false;
    if (ctx.time - this.lootCheckT < 1.5) return false;
    this.lootCheckT = ctx.time;
    const needAmmo = this.firearm.reserve < 30;
    const needHeal = this.profile.usesHeals && this.medkits + this.bandages === 0 && this.hp < 85;
    const radius = needAmmo || needHeal ? 90 * this.profile.lootDrive + 25 : 16;
    const item = ctx.loot.nearest(this.loco.pos, radius);
    if (!item) return false;
    // Do not walk 80 m for a bandage you do not need.
    if (!needAmmo && !needHeal && this.rng.next() > this.profile.lootDrive) return false;
    if (item.type === 'ammo' && this.firearm.reserve > 150) return false;
    this.lootTarget = item;
    return true;
  }

  // --- fighting -------------------------------------------------------------

  private doEngage(dt: number, ctx: AiContext, target: Combatant, mem: TargetMemory): void {
    const t = ctx.time;
    const dx = target.pos.x - this.loco.pos.x;
    const dz = target.pos.z - this.loco.pos.z;
    const dist = Math.hypot(dx, dz);
    this.loco.crouch = 0;

    if (mem.visible) this.exposedT += dt;
    else this.exposedT = Math.max(0, this.exposedT - dt * 2);

    // Reloading: WHERE a bot reloads is the clearest tier tell in the game.
    if (this.firearm.wantsReload(this.profile)) {
      if (this.profile.reloadNeedsCover && mem.visible) {
        if (this.seekCover(ctx, mem, 'break')) return;
        // Nowhere to hide: reload anyway rather than clicking an empty gun.
        if (this.firearm.dry) this.firearm.startReload(this.profile);
      } else {
        this.firearm.startReload(this.profile);
      }
    }

    // Fighting from cover, when the bot believes in cover at all.
    //
    // Two ways to feel pressure: standing exposed in front of somebody you can
    // see, or taking rounds from somewhere you cannot. The second used to make
    // bots walk TOWARD the muzzle flash, which is the worst possible answer;
    // an unseen shooter is treated as maximum pressure and the bot gets out of
    // the line first and looks second.
    const underFire = t - mem.damageT < 3;
    // The memory of being shot at outlasts the shooting. Three seconds after
    // the last round the bot was walking back into the open as if nothing had
    // happened; eight seconds is closer to how long a person stays wary, and it
    // is what keeps a bot behind its wall between bursts.
    const pressure = mem.visible ? this.exposedT : t - mem.damageT < 8 ? 3 : 0;
    if (
      this.profile.usesCover &&
      pressure > 0.9 + (1 - this.profile.coverBias) * 2.5 &&
      this.rng.next() < this.profile.coverBias
    ) {
      // Always the NEAREST usable cover here, even when the shooter is
      // unseen: the job is to get out of the line now, not to relocate.
      // 'break' (further, harder cover) belongs to the retreat state.
      if (this.seekCover(ctx, mem, 'fight')) return;
    }

    // Facing.
    const aimAt = mem.visible ? target.pos : mem.lastSeenPos;
    this.loco.faceTowards(dt, aimAt.x, aimAt.z, 5.6);
    eyeOf(this, _eye);
    chestOf(target, _aimPoint);
    this.aimPitch = Math.atan2(_aimPoint.y - _eye.y, Math.max(0.5, dist));

    // Movement. Zone first — a bot that wins the fight and dies to the gas has
    // not won the fight.
    if (t - this.zoneCheckT > 2) {
      this.zoneCheckT = t;
      const zp = zonePlan(ctx, this, this.profile);
      this.zoneHasPlan = !!zp;
      if (zp) {
        this.zoneTarget.set(zp.x, 0, zp.z);
        this.zoneUrgent = zp.urgent;
      }
    }
    if (this.zoneHasPlan && this.zoneUrgent) {
      this.loco.seek(dt, this.zoneTarget.x, this.zoneTarget.z, RUN, this.world);
    } else if (!mem.visible && t - mem.lastSeenT > 1.2) {
      if (underFire && this.profile.usesCover) {
        // Taking fire from somewhere unseen and nowhere to hide: at least stop
        // standing in the beaten zone. Move across it, not into it.
        const ax = this.loco.pos.x - mem.lastSeenPos.x;
        const az = this.loco.pos.z - mem.lastSeenPos.z;
        const l = Math.hypot(ax, az) || 1;
        this.loco.seek(
          dt,
          this.loco.pos.x + ((ax / l) * 0.7 - (az / l) * 0.7) * 16,
          this.loco.pos.z + ((az / l) * 0.7 + (ax / l) * 0.7) * 16,
          RUN,
          this.world
        );
      } else {
        // Lost them: push to the last known position rather than freezing.
        this.loco.seek(dt, mem.lastSeenPos.x, mem.lastSeenPos.z, RUN * 0.8, this.world);
      }
    } else if (dist > this.profile.maxEngageRange * 0.8) {
      this.loco.seek(dt, aimAt.x, aimAt.z, RUN, this.world);
    } else if (this.shouldPush(target, mem, dist)) {
      this.loco.seek(dt, aimAt.x, aimAt.z, RUN * 0.85, this.world);
    } else if (this.profile.strafeSkill > 0.15 && dist < 90) {
      // Strafe, switching sides on a slow deterministic clock.
      const side = Math.sin(t * 0.7 + this.id) > 0 ? 1 : -1;
      this.loco.strafe(dt, side, WALK * (0.5 + this.profile.strafeSkill * 0.6), this.world);
      this.loco.faceTowards(dt, aimAt.x, aimAt.z, 6);
    } else {
      this.loco.hold();
    }

    this.maybeShoot(ctx, target, mem, dist);
  }

  /**
   * Push or hold. Recruits push because they have no plan; elites push because
   * the other side is reloading or bleeding. Veterans mostly hold their angle.
   */
  private shouldPush(target: Combatant, mem: TargetMemory, dist: number): boolean {
    if (!mem.visible) return false;
    const advantage = target.hp < 45 || (this.hp > 70 && target.hp < this.hp - 25);
    if (advantage && this.profile.pushBias > 0.4) return true;
    if (dist > 45 && this.profile.pushBias > 0.6) return true;
    return this.profile.pushBias > 0.7 && dist > 18;
  }

  private doCover(dt: number, ctx: AiContext, target: Combatant, mem: TargetMemory): void {
    const t = ctx.time;
    const spot = this.coverSpot;
    if (!spot) {
      this.setState('engage');
      return;
    }

    const aimAt = mem.visible ? target.pos : mem.lastSeenPos;
    const d = Math.hypot(spot.pos.x - this.loco.pos.x, spot.pos.z - this.loco.pos.z);

    if (!this.coverArrived) {
      this.loco.crouch = 0;
      const moved = this.loco.seek(dt, spot.pos.x, spot.pos.z, RUN, this.world);
      if (moved < 0.55) {
        this.coverArrived = true;
        this.peeking = false;
        this.peekT = this.profile.peekHold * (0.7 + this.rng.next() * 0.6);
        this.coverCheckT = t;
      }
      // Still exposed on the way: return fire if the shot is there.
      if (mem.visible) this.maybeShoot(ctx, target, mem, Math.hypot(target.pos.x - this.loco.pos.x, target.pos.z - this.loco.pos.z));
      if (this.stateT > 9) this.clearCover(); // never reached it; try something else
      return;
    }

    // In cover: reload and patch up in safety, which is the entire point.
    if (this.firearm.wantsReload(this.profile) || this.firearm.wantsTopUp()) {
      this.firearm.startReload(this.profile);
    }
    if (!this.firearm.reloading && this.wantsHeal() && this.hasHeal() && t - this.lastHurtT > 1.5) {
      this.startHeal();
      return;
    }

    this.peekT -= dt;
    const busy = this.firearm.reloading || this.firearm.dry;
    // Peeking at somebody you have SEEN is trading shots. Peeking when all you
    // have is the direction the rounds came from is walking into a sight
    // picture somebody else already has, so a blind bot sits still much longer
    // and shows itself much more briefly.
    const blind = t - mem.lastSeenT > 6;
    if (this.peeking) {
      if (this.peekT <= 0 || busy) {
        this.peeking = false;
        this.peekT =
          this.profile.peekHold * (0.7 + this.rng.next() * 0.6) * (blind ? 2.4 : 1);
        this.firearm.breakBurst(this.rng, this.profile);
      }
    } else if (this.peekT <= 0 && !busy) {
      this.peeking = true;
      this.peekT = this.profile.peekOut * (blind ? 0.55 : 1);
      this.peekSide = this.rng.chance(0.5) ? 1 : -1;
    }

    this.loco.faceTowards(dt, aimAt.x, aimAt.z, 5.2);
    eyeOf(this, _eye);
    chestOf(target, _aimPoint);
    const dist = Math.hypot(target.pos.x - this.loco.pos.x, target.pos.z - this.loco.pos.z);
    this.aimPitch = Math.atan2(_aimPoint.y - _eye.y, Math.max(0.5, dist));

    if (this.peeking) {
      // Lean out sideways WITHOUT turning away from the threat — a peek that
      // spins the body is a bot walking in circles, not a bot taking an angle.
      this.loco.crouch = 0;
      if (d < 2.1) this.loco.strafe(dt, this.peekSide, WALK * 0.75, this.world);
      else this.loco.hold();
      this.maybeShoot(ctx, target, mem, dist);
    } else {
      this.loco.crouch = this.profile.coverBias > 0.6 ? 1 : 0;
      if (d > 0.7) {
        // Slide back behind the wall, still facing the threat: strafe along
        // whichever side the cover point now lies on.
        const lateral =
          (spot.pos.x - this.loco.pos.x) * Math.cos(this.loco.yaw) -
          (spot.pos.z - this.loco.pos.z) * Math.sin(this.loco.yaw);
        this.loco.strafe(dt, lateral >= 0 ? 1 : -1, WALK * 0.9, this.world);
      } else {
        this.loco.hold();
      }
      this.firearm.breakBurst(this.rng, this.profile);
    }

    // Is this still cover?
    //
    // Checked whether or not the threat is currently visible, and that matters:
    // a bot hiding from someone it has only HEARD has no other way to find out
    // that the tree it picked is two metres to the left of the sight line. It
    // used to sit there believing it was safe, which looks exactly like the old
    // AI standing in the open.
    if (!this.peeking && this.coverArrived && t - this.coverCheckT > 1.5) {
      this.coverCheckT = t;
      if (!coverStillValid(ctx, this, aimAt)) {
        this.clearCover();
        this.setState('engage');
      }
    }
  }

  private doRetreat(dt: number, ctx: AiContext, target: Combatant | null, mem: TargetMemory | null): void {
    const t = ctx.time;
    this.retreatT += dt;
    this.loco.crouch = 0;
    const threatPos = mem ? (mem.visible && target ? target.pos : mem.lastSeenPos) : null;

    if (!this.coverSpot && threatPos && t - this.coverQueryT > 1.5 && ctx.coverQueriesLeft > 0) {
      ctx.coverQueriesLeft--;
      this.coverQueryT = t;
      this.coverSpot = findCover(ctx, this, this.profile, this.rng, threatPos, 'break', 8);
      this.coverArrived = false;
    }

    if (this.coverSpot) {
      const d = this.loco.seek(dt, this.coverSpot.pos.x, this.coverSpot.pos.z, SPRINT, this.world);
      if (d < 1.3) this.coverArrived = true;
    } else if (threatPos) {
      // No cover: put ground between us.
      const away = _tmp.set(this.loco.pos.x - threatPos.x, 0, this.loco.pos.z - threatPos.z).normalize();
      this.loco.seek(dt, this.loco.pos.x + away.x * 20, this.loco.pos.z + away.z * 20, SPRINT, this.world);
    } else {
      this.setState('patrol');
      return;
    }

    const safe = !mem || (!mem.visible && t - mem.lastSeenT > 1.6);
    if (safe) {
      if (this.firearm.wantsReload(this.profile) || this.firearm.wantsTopUp()) {
        this.firearm.startReload(this.profile);
      } else if (this.wantsHeal() && this.hasHeal() && t - this.lastHurtT > 1.6) {
        this.startHeal();
        return;
      }
      // Patched up and unhunted: back to the match.
      if (this.retreatT > 3.5 && !this.firearm.reloading && this.hp > this.profile.retreatHp * MAX_HP * 1.15) {
        this.clearCover();
        this.setState('patrol');
      }
    } else if (target && mem && mem.visible) {
      // Cornered: shoot back while backing off. A retreating bot is not a free kill.
      this.loco.faceTowards(dt, target.pos.x, target.pos.z, 4.5);
      this.maybeShoot(ctx, target, mem, Math.hypot(target.pos.x - this.loco.pos.x, target.pos.z - this.loco.pos.z));
    }
    if (this.retreatT > 14) {
      this.clearCover();
      this.setState('patrol');
    }
  }

  /** Ask for cover and commit to it. Returns true when the bot took the job. */
  private seekCover(ctx: AiContext, mem: TargetMemory, intent: 'fight' | 'break'): boolean {
    const t = ctx.time;
    if (this.coverSpot) {
      this.setState('cover');
      return true;
    }
    if (t - this.coverQueryT < 1.2 || ctx.coverQueriesLeft <= 0) return false;
    ctx.coverQueriesLeft--;
    this.coverQueryT = t;
    const spot = findCover(ctx, this, this.profile, this.rng, mem.lastSeenPos, intent, 8);
    if (!spot) return false;
    this.coverSpot = spot;
    this.coverArrived = false;
    this.exposedT = 0;
    this.setState('cover');
    return true;
  }

  private clearCover(): void {
    this.coverSpot = null;
    this.coverArrived = false;
    this.peeking = false;
  }

  private maybeShoot(ctx: AiContext, target: Combatant, mem: TargetMemory, dist: number): void {
    if (!mem.visible) {
      this.firearm.breakBurst(this.rng, this.profile);
      return;
    }
    if (dist > this.profile.maxEngageRange) return;
    // Reaction: awareness climbs at 1/reactionS while the target is in sight.
    // The trigger does not work until it reaches 1.
    if (mem.awareness < 1) return;
    if (!this.firearm.readyToFire) return;
    if (!ctx.governor.tryTake()) return;
    if (!this.firearm.tryFire(this.profile, this.rng, ctx.time)) return;

    eyeOf(this, _eye);
    chestOf(target, _aimPoint);
    const sol = solveAim(_eye, target, _aimPoint, this.profile, this.rng, {
      contactAge: ctx.time - mem.contactT,
      selfSpeed01: this.loco.speed01,
      suppression: this.suppression,
    });
    _muzzle.copy(_eye).addScaledVector(sol.dir, 0.55);
    ctx.ballistics.fire(_muzzle, sol.dir, BULLET_SPEED, BOT_DAMAGE, this.capsuleId);
    this.lastFiredT = ctx.time;
    ctx.events.onShoot(this, _eye, sol.dir, BOT_DAMAGE);
  }

  // --- healing --------------------------------------------------------------

  private wantsHeal(): boolean {
    return this.profile.usesHeals && this.hp < this.profile.healHp * MAX_HP;
  }

  private hasHeal(): boolean {
    return this.medkits > 0 || this.bandages > 0;
  }

  private startHeal(): void {
    if (this.medkits > 0 && this.hp < 55) {
      this.medkits--;
      this.healLeft = 4.2;
      this.healAmount = 75;
    } else if (this.bandages > 0) {
      this.bandages--;
      this.healLeft = 2.6;
      this.healAmount = 18;
    } else if (this.medkits > 0) {
      this.medkits--;
      this.healLeft = 4.2;
      this.healAmount = 75;
    } else {
      return;
    }
    this.setState('heal');
  }

  private abortHeal(): void {
    // The item is spent either way — interrupting a heal has to cost something
    // or breaking contact to heal carries no risk.
    this.healLeft = 0;
    this.healAmount = 0;
    if (this.state === 'heal') this.setState('patrol');
  }

  private doHeal(dt: number): void {
    this.loco.hold();
    this.loco.crouch = 1;
    this.healLeft -= dt;
    if (this.healLeft <= 0) {
      this.hp = Math.min(MAX_HP, this.hp + this.healAmount);
      this.healAmount = 0;
      this.setState('patrol');
    }
  }

  // --- presentation ---------------------------------------------------------

  private pose(): void {
    if (!Bot.posing) return;
    this.rig.root.position.copy(this.loco.pos);
    this.rig.root.rotation.y = this.loco.yaw;
    poseCharacter(this.rig, {
      walkPhase: this.loco.walkPhase,
      speed01: this.loco.speed01,
      aimPitch: this.aimPitch,
      crouch: this.loco.crouch,
      dead: this.deadT,
    });
  }
}
