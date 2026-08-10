import * as THREE from 'three';
import { Bot } from '../ai/bot';
import { BotDirector } from '../ai/director';
import { ShotRegistry } from '../ai/shotregistry';
import { losClear } from '../ai/los';
import { ExternalCombatant, PLAYER_CID, type ZoneInfo } from '../ai/types';
import type { SkillTier } from '../ai/profiles';
import { hash2 } from '../gen/noise';
import type { Heightfield } from '../gen/terraingen';
import type { PhysicsWorld } from '../player/physics';
import type { Ballistics } from '../weapons/ballistics';
import type { PlayerController } from '../player/controller';
import type { Health } from '../player/health';
import type { AudioSystem } from '../gen/audiogen';
import { ZoneController } from './zonecontroller';
import { ZoneWall } from '../world/zone';
import { LootField, type LootItem } from './loot';

export type MatchState = 'playing' | 'won' | 'dead';

const BOT_COUNT = 15;

export interface KillEvent {
  text: string;
}

interface MatchStats {
  botShots: number;
  botHitsOnBots: number;
  botDamageToBots: number;
  botKillsOfBots: number;
  playerKills: number;
  botKillsOfPlayer: number;
  zoneKills: number;
}

export class Match {
  readonly bots: Bot[] = [];
  readonly zone: ZoneController;
  readonly wall: ZoneWall;
  readonly loot: LootField;
  readonly director: BotDirector;
  state: MatchState = 'playing';
  kills = 0;
  onKillFeed: ((e: KillEvent) => void) | null = null;
  onStateChange: ((s: MatchState) => void) | null = null;

  private playerCapsuleId: number;
  private playerCombatant: ExternalCombatant;
  private shots = new ShotRegistry();
  private zoneInfo: ZoneInfo;
  private zoneOverride: ZoneInfo | null = null;
  /** Drill-only LOD reference, so a drill 600 m from the camera still runs at full rate. */
  private focusOverride: THREE.Vector3 | null = null;
  private zoneTick = 0;
  private simPaused = false;
  private playerActive = true;
  private playerDeathReported = false;
  private stats: MatchStats = {
    botShots: 0,
    botHitsOnBots: 0,
    botDamageToBots: 0,
    botKillsOfBots: 0,
    playerKills: 0,
    botKillsOfPlayer: 0,
    zoneKills: 0,
  };

  /** So the player's own weapon can exclude it from its raycasts. */
  get playerCapsule(): number {
    return this.playerCapsuleId;
  }

  constructor(
    private scene: THREE.Scene,
    private hf: Heightfield,
    private physics: PhysicsWorld,
    private ballistics: Ballistics,
    private player: PlayerController,
    private playerHealth: Health,
    private camera: THREE.PerspectiveCamera,
    private audio: AudioSystem,
    lootSpots: THREE.Vector3[] = []
  ) {
    this.zone = new ZoneController();
    this.wall = new ZoneWall();
    scene.add(this.wall.mesh);
    this.loot = new LootField(hf, lootSpots);
    scene.add(this.loot.group);

    this.playerCapsuleId = physics.addCapsule(player.position, 0.38, 1.75, 'player');
    this.playerCombatant = new ExternalCombatant(PLAYER_CID, this.playerCapsuleId, 'You', true);
    this.playerCombatant.sync(player.position, true, playerHealth.hp, 0);

    this.zoneInfo = {
      center: this.zone.center.clone(),
      radius: this.zone.radius,
      nextCenter: this.zone.targetCenter.clone(),
      nextRadius: this.zone.targetRadius,
      countdown: this.zone.countdown,
      shrinking: this.zone.isShrinking,
      dps: this.zone.dps,
    };

    this.director = new BotDirector(physics, hf, ballistics, this.loot, this.zoneInfo, {
      onShoot: (shooter, from) => {
        this.stats.botShots++;
        this.audio.playAt(
          'shot-far',
          from.x - this.camera.position.x,
          from.y - this.camera.position.y,
          from.z - this.camera.position.z,
          120
        );
        // Everyone in earshot gets a bearing. This is the only channel by
        // which one bot learns another exists without seeing it.
        this.director.broadcastShot(from, shooter.cid);
      },
      onLoot: () => {},
    });
    this.director.addCombatant(this.playerCombatant);

    // Spawn bots spread across walkable land, away from the player.
    let placed = 0;
    let salt = 500;
    while (placed < BOT_COUNT && salt < 5000) {
      salt++;
      const x = (hash2(salt, 41) - 0.5) * 1050;
      const z = (hash2(salt, 97) - 0.5) * 1050;
      if (!hf.walkable(x, z)) continue;
      if (Math.hypot(x - player.position.x, z - player.position.z) < 130) continue;
      const bot = new Bot(placed, new THREE.Vector3(x, hf.height(x, z), z), physics);
      this.bots.push(bot);
      this.director.add(bot);
      scene.add(bot.rig.root);
      placed++;
    }

    this.installFireRegistry();
    this.installDamageRouter();
    this.installTestHooks();
  }

  // --- damage routing -------------------------------------------------------

  /**
   * Every muzzle in the match, logged as it fires.
   *
   * Ballistics reports WHAT was hit but not WHO fired, and ballistics.ts is not
   * this lane's file to edit. Wrapping `fire` on the instance is the seam that
   * needs no edits anywhere else: the player's weapon and every bot both go
   * through it, so kill credit works in all four directions (player kills bot,
   * bot kills bot, bot kills player, and the blue zone kills anyone).
   */
  private installFireRegistry(): void {
    const raw = this.ballistics.fire.bind(this.ballistics);
    this.ballistics.fire = (origin, dir, speed, damage, owner = -1) => {
      this.shots.register(owner, origin, dir);
      raw(origin, dir, speed, damage, owner);
    };
  }

  private nameForCapsule(capsuleId: number): string | null {
    if (capsuleId < 0) return null;
    if (capsuleId === this.playerCapsuleId) return 'You';
    return this.director.botByCapsule(capsuleId)?.name ?? null;
  }

  private installDamageRouter(): void {
    const prevTargetHit = this.ballistics.onTargetHit;
    this.ballistics.onTargetHit = (bh) => {
      prevTargetHit?.(bh);
      const headshot = bh.hit.tag.startsWith('head:');
      const tag = bh.hit.tag.replace('head:', '');
      const killerCapsule = this.shots.attribute(bh.hit.point, bh.direction, bh.hit.id);
      const killerBot = killerCapsule >= 0 ? this.director.botByCapsule(killerCapsule) : null;
      const byPlayer = killerCapsule === this.playerCapsuleId;
      const killerCid = byPlayer ? PLAYER_CID : killerBot ? killerBot.cid : -1;
      const killerPos = byPlayer ? this.player.position : killerBot ? killerBot.pos : null;

      if (tag === 'player') {
        this.playerHealth.damage(bh.damage, bh.direction.x, bh.direction.z);
        if (this.playerHealth.dead && !this.playerDeathReported) {
          this.playerDeathReported = true;
          if (killerBot) this.stats.botKillsOfPlayer++;
          this.onKillFeed?.({
            text: `${killerBot ? killerBot.name : 'Someone'} ${headshot ? 'headshot' : 'killed'} you`,
          });
        }
        return;
      }

      if (!tag.startsWith('bot:')) return;
      const id = parseInt(tag.slice(4), 10);
      const bot = this.bots[id];
      if (!bot || !bot.alive) return;
      if (killerBot) {
        this.stats.botHitsOnBots++;
        this.stats.botDamageToBots += bh.damage;
      }
      bot.damage(bh.damage, killerCid, killerPos);
      if (!bot.alive) this.registerKill(bot, headshot, byPlayer, killerBot);
    };
  }

  private registerKill(victim: Bot, headshot: boolean, byPlayer: boolean, killerBot: Bot | null): void {
    const verb = headshot ? 'headshot' : 'killed';
    if (byPlayer) {
      this.kills++;
      this.stats.playerKills++;
      this.onKillFeed?.({ text: `You ${verb} ${victim.name}` });
      this.audio.play('headshot', { volume: 0.6 });
    } else if (killerBot) {
      this.stats.botKillsOfBots++;
      this.onKillFeed?.({ text: `${killerBot.name} ${verb} ${victim.name}` });
    } else {
      this.onKillFeed?.({ text: `${victim.name} died` });
    }
    this.checkWin();
  }

  get aliveCount(): number {
    return this.director.aliveBots() + (this.playerHealth.dead ? 0 : 1);
  }

  private checkWin(): void {
    if (this.state !== 'playing') return;
    if (!this.playerHealth.dead && this.bots.every((b) => !b.alive)) {
      this.state = 'won';
      this.onStateChange?.('won');
    }
  }

  playerDied(): void {
    if (this.state !== 'playing') return;
    this.state = 'dead';
    this.playerCombatant.alive = false;
    this.onStateChange?.('dead');
  }

  /** Nearest loot within reach of the player. */
  lootInReach(): LootItem | null {
    return this.loot.nearest(this.player.position);
  }

  // --- tick -----------------------------------------------------------------

  private syncZoneInfo(): void {
    const src = this.zoneOverride;
    if (src) {
      this.zoneInfo.center.copy(src.center);
      this.zoneInfo.radius = src.radius;
      this.zoneInfo.nextCenter.copy(src.nextCenter);
      this.zoneInfo.nextRadius = src.nextRadius;
      this.zoneInfo.countdown = src.countdown;
      this.zoneInfo.shrinking = src.shrinking;
      this.zoneInfo.dps = src.dps;
      return;
    }
    this.zoneInfo.center.copy(this.zone.center);
    this.zoneInfo.radius = this.zone.radius;
    this.zoneInfo.nextCenter.copy(this.zone.targetCenter);
    this.zoneInfo.nextRadius = this.zone.targetRadius;
    this.zoneInfo.countdown = this.zone.countdown;
    this.zoneInfo.shrinking = this.zone.isShrinking;
    this.zoneInfo.dps = this.zone.dps;
  }

  fixedUpdate(dt: number): void {
    if (this.state !== 'playing' || this.simPaused) return;

    // Win detection must not depend on which code path killed the last bot.
    this.checkWin();

    this.zone.update(dt);
    this.wall.set(this.zone.center, this.zone.radius);
    this.syncZoneInfo();

    // Player capsule + combatant record. Eye height is measured rather than
    // assumed so crouching and leaning change what a bot can see of you.
    const alive = !this.playerHealth.dead && this.playerActive;
    this.physics.updateCapsule(this.playerCapsuleId, this.player.position, alive);
    this.playerCombatant.eyeHeight = THREE.MathUtils.clamp(
      this.camera.position.y - this.player.position.y,
      0.9,
      1.9
    );
    this.playerCombatant.sync(this.player.position, alive, this.playerHealth.hp, dt);

    this.director.fixedUpdate(dt, this.camera.position);
    this.shots.update(dt);

    // Zone damage at 0.5s granularity.
    this.zoneTick += dt;
    if (this.zoneTick >= 0.5) {
      this.zoneTick = 0;
      this.applyZoneDamage(0.5);
    }
  }

  private applyZoneDamage(seconds: number): void {
    const pd = this.zone.damageAt(this.player.position.x, this.player.position.z);
    if (pd > 0 && !this.playerHealth.dead && this.playerActive) {
      this.playerHealth.damage(pd * seconds, 0, 0);
    }
    for (const bot of this.bots) {
      if (!bot.alive || !bot.simEnabled) continue;
      const bd = this.zone.damageAt(bot.pos.x, bot.pos.z);
      if (bd > 0) {
        bot.damage(bd * seconds);
        if (!bot.alive) {
          this.stats.zoneKills++;
          this.onKillFeed?.({ text: `${bot.name} died to the blue zone` });
          this.checkWin();
        }
      }
    }
  }

  update(dt: number): void {
    this.wall.update(dt);
    this.loot.update(dt);
  }

  // --- AI test harness ------------------------------------------------------
  //
  // These hooks drive tools/ai-test.mjs. They step the SAME director and the
  // SAME ballistics the live game runs — a drill is the real AI on a controlled
  // stage, not a parallel model of it. main.ts is not this lane's file to edit,
  // so they hang off their own global rather than extending __TEST__.

  /**
   * One fixed simulation step without the match-state machinery: the director
   * thinks, bullets fly, shots age out. Drills call this thousands of times in
   * a single blocking call, which is why a 90-second brawl takes a second.
   */
  private simStep(dt: number): void {
    if (!this.zoneOverride) {
      this.zone.update(dt);
      this.wall.set(this.zone.center, this.zone.radius);
    }
    this.syncZoneInfo();
    const alive = !this.playerHealth.dead && this.playerActive;
    this.physics.updateCapsule(this.playerCapsuleId, this.player.position, alive);
    this.playerCombatant.sync(this.player.position, alive, this.playerHealth.hp, dt);
    this.director.fixedUpdate(dt, this.focusOverride ?? this.camera.position);
    this.ballistics.fixedUpdate(dt);
    this.shots.update(dt);
    if (!this.zoneOverride) {
      this.zoneTick += dt;
      if (this.zoneTick >= 0.5) {
        this.zoneTick = 0;
        this.applyZoneDamage(0.5);
      }
    }
  }

  private walkableSpot(salt: number): THREE.Vector3 | null {
    for (let s = 0; s < 600; s++) {
      const x = (hash2(salt * 977 + s, 71) - 0.5) * 880;
      const z = (hash2(salt * 977 + s, 131) - 0.5) * 880;
      if (!this.hf.walkable(x, z)) continue;
      return new THREE.Vector3(x, this.hf.height(x, z), z);
    }
    return null;
  }

  /**
   * Two walkable points `dist` apart with clear line of sight between them.
   *
   * `needCoverNear` additionally requires something solid within 16 m of point
   * A. The cover drill needs that: "does a bot use cover" is only a question
   * where cover exists, and staging the experiment in the middle of an empty
   * field would measure the map, not the AI.
   */
  private openPair(
    dist: number,
    salt: number,
    needCoverNear = false
  ): { a: THREE.Vector3; b: THREE.Vector3 } | null {
    const eyeA = new THREE.Vector3();
    const eyeB = new THREE.Vector3();
    const probe = new THREE.Vector3();
    for (let s = 0; s < 900; s++) {
      const x = (hash2(salt * 613 + s, 17) - 0.5) * 860;
      const z = (hash2(salt * 613 + s, 53) - 0.5) * 860;
      if (!this.hf.walkable(x, z)) continue;
      for (let k = 0; k < 6; k++) {
        const ang = hash2(s, k * 31 + 7) * Math.PI * 2;
        const bx = x + Math.sin(ang) * dist;
        const bz = z + Math.cos(ang) * dist;
        if (!this.hf.walkable(bx, bz)) continue;
        eyeA.set(x, this.hf.height(x, z) + 1.6, z);
        eyeB.set(bx, this.hf.height(bx, bz) + 1.6, bz);
        if (!losClear(this.physics, eyeA, eyeB, -1, -1, 0.4)) continue;
        if (needCoverNear) {
          let solid = false;
          for (let d = 0; d < 10 && !solid; d++) {
            const a2 = (d / 10) * Math.PI * 2;
            probe.set(Math.sin(a2), 0, Math.cos(a2));
            const hit = this.physics.raycast(eyeA, probe, 16, -1);
            if (hit && hit.kind === 'box') solid = true;
          }
          if (!solid) continue;
        }
        return {
          a: new THREE.Vector3(x, this.hf.height(x, z), z),
          b: new THREE.Vector3(bx, this.hf.height(bx, bz), bz),
        };
      }
    }
    return null;
  }

  private setZoneOverride(center: THREE.Vector3, radius: number): void {
    // Every drill routes through here, so this is also where the LOD focus and
    // the posing switch get set: a drill runs at full think-rate and skips the
    // skinning solve.
    this.focusOverride = center.clone();
    Bot.posing = false;
    this.zoneOverride = {
      center: center.clone(),
      radius,
      nextCenter: center.clone(),
      nextRadius: radius,
      countdown: 999,
      shrinking: false,
      dps: 0,
    };
    this.syncZoneInfo();
  }

  private installTestHooks(): void {
    if (typeof window === 'undefined') return;
    const yawTo = (from: THREE.Vector3, to: THREE.Vector3): number =>
      Math.atan2(to.x - from.x, to.z - from.z);

    const hooks = {
      /** Whole-field snapshot: tiers, states, ammo, budgets. */
      info: () => ({
        time: this.director.time,
        rays: { spent: this.director.budget.spent, denied: this.director.budget.denied },
        stats: { ...this.stats },
        alive: this.aliveCount,
        bots: this.bots.map((b) => ({
          id: b.id,
          tier: b.tier,
          state: b.state,
          hp: Math.round(b.hp * 10) / 10,
          ammo: b.ammo,
          reserve: b.reserve,
          reloading: b.reloading,
          reloads: b.reloads,
          target: b.targetId,
          enabled: b.simEnabled,
          pos: [Math.round(b.pos.x), Math.round(b.pos.z)],
        })),
      }),

      /** Tier histogram for the distribution assertion. */
      tiers: () => {
        const counts: Record<string, number> = { recruit: 0, regular: 0, veteran: 0, elite: 0 };
        for (const b of this.bots) counts[b.tier]++;
        return counts;
      },

      /** Stop the live loop so a drill owns the simulation. */
      pause: (on: boolean) => {
        this.simPaused = on;
        return this.simPaused;
      },

      /** Take the player out of the world entirely (bots cannot see or hit it). */
      setPlayerActive: (on: boolean) => {
        this.playerActive = on;
        this.playerCombatant.alive = on && !this.playerHealth.dead;
        this.physics.updateCapsule(this.playerCapsuleId, this.player.position, this.playerCombatant.alive);
        return this.playerActive;
      },

      /** Advance the AI + ballistics by n fixed ticks. */
      step: (n: number) => {
        for (let i = 0; i < n; i++) this.simStep(1 / 60);
        return this.director.time;
      },

      enableAllBots: () => {
        for (const b of this.bots) b.setSimEnabled(true);
        this.zoneOverride = null;
        this.focusOverride = null;
        Bot.posing = true;
        this.syncZoneInfo();
        return this.bots.length;
      },

      /**
       * Drop `count` bots into a ring around one walkable point, healed and
       * loaded, with a private no-shrink circle around them so the drill
       * measures fighting rather than zone routing.
       */
      cluster: (count = 10, radius = 45, tiers: SkillTier[] | null = null) => {
        const spot = this.walkableSpot(3);
        if (!spot) return { ok: false, placed: 0 };
        let placed = 0;
        for (const b of this.bots) {
          if (placed >= count) {
            b.setSimEnabled(false);
            continue;
          }
          let put: THREE.Vector3 | null = null;
          for (let k = 0; k < 24; k++) {
            const a = ((placed / count) * Math.PI * 2) + k * 0.21;
            const r = radius * (0.55 + hash2(placed, k) * 0.45);
            const x = spot.x + Math.sin(a) * r;
            const z = spot.z + Math.cos(a) * r;
            if (!this.hf.walkable(x, z)) continue;
            put = new THREE.Vector3(x, this.hf.height(x, z), z);
            break;
          }
          if (!put) {
            b.setSimEnabled(false);
            continue;
          }
          if (tiers) b.setTier(tiers[placed % tiers.length]);
          b.setSimEnabled(true);
          b.resetTo(put, yawTo(put, spot));
          placed++;
        }
        this.setZoneOverride(spot, Math.max(90, radius * 2.4));
        this.stats.botHitsOnBots = 0;
        this.stats.botDamageToBots = 0;
        this.stats.botKillsOfBots = 0;
        this.stats.botShots = 0;
        return { ok: true, placed, center: [spot.x, spot.z] };
      },

      /**
       * Controlled 1v1. Two forced tiers, equal distance, mutual line of sight,
       * everyone else parked. Returns per-trial winners.
       */
      duel: (tierA: SkillTier, tierB: SkillTier, dist = 34, trials = 8, maxSeconds = 40) => {
        const a = this.bots[0];
        const b = this.bots[1];
        if (!a || !b) return { ok: false };
        for (const other of this.bots) other.setSimEnabled(other === a || other === b);
        a.setTier(tierA);
        b.setTier(tierB);
        const out = { ok: true, a: tierA, b: tierB, winsA: 0, winsB: 0, draws: 0, seconds: [] as number[], hp: [] as number[] };
        for (let i = 0; i < trials; i++) {
          const pair = this.openPair(dist, i + 1);
          if (!pair) {
            out.draws++;
            continue;
          }
          this.setZoneOverride(
            new THREE.Vector3((pair.a.x + pair.b.x) / 2, 0, (pair.a.z + pair.b.z) / 2),
            400
          );
          a.setSimEnabled(true);
          b.setSimEnabled(true);
          a.resetTo(pair.a, yawTo(pair.a, pair.b));
          b.resetTo(pair.b, yawTo(pair.b, pair.a));
          const t0 = this.director.time;
          let steps = 0;
          const limit = Math.round(maxSeconds * 60);
          while (steps < limit && a.alive && b.alive) {
            this.simStep(1 / 60);
            steps++;
          }
          out.seconds.push(Math.round((this.director.time - t0) * 10) / 10);
          if (a.alive && !b.alive) {
            out.winsA++;
            out.hp.push(Math.round(a.hp));
          } else if (b.alive && !a.alive) {
            out.winsB++;
            out.hp.push(-Math.round(b.hp));
          } else {
            out.draws++;
            out.hp.push(0);
          }
        }
        return out;
      },

      /**
       * Shot at from a known position: does the bot break line of sight to it?
       * Each trial runs twice from the SAME spot — once with incoming fire,
       * once without — so the control is the same bot on the same ground, and
       * "more often than chance" means something.
       */
      coverDrill: (tier: SkillTier = 'veteran', trials = 16, dist = 42, seconds = 7) => {
        const bot = this.bots[0];
        if (!bot) return { ok: false };
        for (const other of this.bots) other.setSimEnabled(other === bot);
        bot.setTier(tier);
        const ghost = new ExternalCombatant(9000, -1, 'Ghost', false);
        const eyeA = new THREE.Vector3();
        const eyeB = new THREE.Vector3();
        let brokeShot = 0;
        let brokeControl = 0;
        let used = 0;
        const stateHist: Record<string, number> = {};
        const limit = Math.round(seconds * 60);

        for (let i = 0; i < trials; i++) {
          const pair = this.openPair(dist, 500 + i, true);
          if (!pair) continue;
          used++;
          this.setZoneOverride(pair.a, 400);

          for (const shot of [true, false]) {
            // The control run has NO attacker at all — the bot is dropped on
            // the same ground with the same orientation and left to its own
            // devices. Whatever fraction of those runs happens to end with the
            // line broken IS chance, measured rather than assumed.
            this.director.removeCombatant(ghost);
            bot.setSimEnabled(true);
            bot.resetTo(pair.a, yawTo(pair.a, pair.b) + Math.PI * 0.55);
            if (shot) {
              ghost.sync(pair.b, true, 100, 0);
              ghost.alive = true;
              this.director.addCombatant(ghost);
              // One burst lands. The bot learns a direction, not a position it
              // could not have earned.
              bot.damage(22, ghost.cid, pair.b);
              bot.hearShot(pair.b, ghost.cid);
            }
            // Measure the FRACTION OF TIME the line is broken, not a single
            // snapshot at the end: a bot that dives behind a wall, waits, and
            // then leaves to look for the shooter has still taken cover, and
            // one lucky sample either way would call it wrong.
            let samples = 0;
            let hiddenSamples = 0;
            for (let s = 0; s < limit; s++) {
              this.simStep(1 / 60);
              if (shot && s % 90 === 0) {
                // The attacker keeps firing: audible whether or not it connects.
                bot.hearShot(pair.b, ghost.cid);
                eyeA.set(bot.pos.x, bot.pos.y + 1.6, bot.pos.z);
                eyeB.set(pair.b.x, pair.b.y + 1.6, pair.b.z);
                if (bot.alive && bot.hp > 45 && losClear(this.physics, eyeA, eyeB, bot.capsuleId, -1, 0.4)) {
                  bot.damage(9, ghost.cid, pair.b);
                }
              }
              // Sample from 1 s in (the first second is reaction time, not tactics).
              if (s >= 60 && s % 15 === 0) {
                samples++;
                if (shot) stateHist[bot.state] = (stateHist[bot.state] ?? 0) + 1;
                eyeA.set(bot.pos.x, bot.pos.y + 1.6, bot.pos.z);
                eyeB.set(pair.b.x, pair.b.y + 1.6, pair.b.z);
                if (!losClear(this.physics, eyeA, eyeB, bot.capsuleId, -1, 0.4)) hiddenSamples++;
              }
            }
            const frac = samples ? hiddenSamples / samples : 0;
            if (shot) brokeShot += frac;
            else brokeControl += frac;
          }
        }
        this.director.removeCombatant(ghost);
        return {
          ok: true,
          tier,
          trials: used,
          underFireBroken: Math.round(brokeShot * 100) / 100,
          controlBroken: Math.round(brokeControl * 100) / 100,
          underFireRate: used ? brokeShot / used : 0,
          controlRate: used ? brokeControl / used : 0,
          stateHist,
        };
      },

      /**
       * Put one bot in a sustained firefight against a phantom and watch the
       * magazine: it must run down and come back up.
       */
      reloadDrill: (tier: SkillTier = 'regular', seconds = 26, dist = 30) => {
        const bot = this.bots[0];
        if (!bot) return { ok: false };
        for (const other of this.bots) other.setSimEnabled(other === bot);
        bot.setTier(tier);
        const pair = this.openPair(dist, 77);
        if (!pair) return { ok: false };
        this.setZoneOverride(pair.a, 400);
        const ghost = new ExternalCombatant(9001, -1, 'Ghost', false);
        this.director.addCombatant(ghost);
        ghost.sync(pair.b, true, 100, 0);
        bot.setSimEnabled(true);
        bot.resetTo(pair.a, yawTo(pair.a, pair.b));

        let minAmmo = bot.ammo;
        let reloads = 0;
        let prev = bot.ammo;
        let sawReloadingFlag = false;
        const trace: number[] = [];
        const states: string[] = [];
        const eyeA = new THREE.Vector3();
        const eyeB = new THREE.Vector3();
        const limit = Math.round(seconds * 60);
        for (let s = 0; s < limit; s++) {
          ghost.sync(pair.b, true, 100, 1 / 60);
          this.simStep(1 / 60);
          const now = bot.ammo;
          if (bot.reloading) sawReloadingFlag = true;
          if (now > prev) reloads++;
          minAmmo = Math.min(minAmmo, now);
          prev = now;
          if (s % 30 === 0) {
            trace.push(now);
            eyeA.set(bot.pos.x, bot.pos.y + 1.6, bot.pos.z);
            eyeB.set(pair.b.x, pair.b.y + 1.31, pair.b.z);
            const sees = losClear(this.physics, eyeA, eyeB, bot.capsuleId, -1, 0.5);
            states.push(
              `${bot.state}${sees ? '+' : '-'}${Math.round(
                Math.hypot(bot.pos.x - pair.b.x, bot.pos.z - pair.b.z)
              )}`
            );
          }
        }
        this.director.removeCombatant(ghost);
        return {
          ok: true,
          tier,
          minAmmo,
          endAmmo: bot.ammo,
          reserve: bot.reserve,
          reloads,
          sawReloadingFlag,
          trace,
          states,
        };
      },

      /**
       * Wall-clock cost of one simulation tick with every bot alive and
       * thinking: director + perception rays + cover queries + ballistics.
       * This is the number that decides whether fifteen bots are affordable on
       * an HD 620, and it is measured rather than asserted.
       */
      perf: (n = 900) => {
        for (const b of this.bots) b.setSimEnabled(true);
        const alive = this.director.aliveBots();
        // Measure the way the game actually runs: LOD keyed off the camera,
        // bots scattered across the island. Then measure the pathological case
        // — every survivor inside the near band at once — so the ceiling is a
        // number and not a hope.
        this.focusOverride = null;
        Bot.posing = false;
        let t0 = performance.now();
        for (let i = 0; i < n; i++) this.simStep(1 / 60);
        const spread = (performance.now() - t0) / n;
        const centre = new THREE.Vector3();
        let live = 0;
        for (const b of this.bots) {
          if (!b.alive) continue;
          centre.add(b.pos);
          live++;
        }
        if (live > 0) centre.divideScalar(live);
        this.focusOverride = centre;
        t0 = performance.now();
        for (let i = 0; i < n; i++) this.simStep(1 / 60);
        const worst = (performance.now() - t0) / n;
        this.focusOverride = null;
        Bot.posing = true;
        return {
          msPerTick: Math.round(spread * 1000) / 1000,
          msPerTickAllNear: Math.round(worst * 1000) / 1000,
          aliveBots: alive,
          ticks: n,
        };
      },

      /**
       * Unit cost of the three primitives the AI is built out of. Every tuning
       * decision about ray budgets and think rates should be made against
       * these numbers rather than against a guess about which is expensive.
       */
      costProbe: (n = 300) => {
        const p = this.player.position;
        const dir = new THREE.Vector3(1, 0, 0.3).normalize();
        const from = new THREE.Vector3(p.x, p.y + 1.6, p.z);
        const delta = new THREE.Vector3(0.05, 0, 0.03);
        let acc = 0;
        let t0 = performance.now();
        for (let i = 0; i < n * 10; i++) acc += this.hf.height(p.x + i * 0.37, p.z + i * 0.11);
        const heightUs = ((performance.now() - t0) / (n * 10)) * 1000;
        t0 = performance.now();
        for (let i = 0; i < n; i++) this.physics.raycast(from, dir, 60, -1);
        const ray60Us = ((performance.now() - t0) / n) * 1000;
        t0 = performance.now();
        for (let i = 0; i < n; i++) this.physics.raycast(from, dir, 200, -1);
        const ray200Us = ((performance.now() - t0) / n) * 1000;
        t0 = performance.now();
        const tmp = p.clone();
        for (let i = 0; i < n; i++) this.physics.moveCapsule(tmp, delta, 0, 1 / 60, 0.36);
        const moveUs = ((performance.now() - t0) / n) * 1000;
        return {
          heightUs: Math.round(heightUs * 100) / 100,
          ray60Us: Math.round(ray60Us * 100) / 100,
          ray200Us: Math.round(ray200Us * 100) / 100,
          moveCapsuleUs: Math.round(moveUs * 100) / 100,
          acc,
        };
      },

      /** Reset the drill scaffolding and hand the match back to the game loop. */
      finish: () => {
        for (const b of this.bots) b.setSimEnabled(true);
        this.zoneOverride = null;
        this.focusOverride = null;
        Bot.posing = true;
        this.playerActive = true;
        this.simPaused = false;
        this.syncZoneInfo();
        return true;
      },
    };

    (window as unknown as Record<string, unknown>).__AI_TEST__ = hooks;
  }
}
