import * as THREE from 'three';
import { Bot, type BotTargetInfo } from '../ai/bot';
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

export class Match {
  readonly bots: Bot[] = [];
  readonly zone: ZoneController;
  readonly wall: ZoneWall;
  readonly loot: LootField;
  state: MatchState = 'playing';
  kills = 0;
  onKillFeed: ((e: KillEvent) => void) | null = null;
  onStateChange: ((s: MatchState) => void) | null = null;
  private playerCapsuleId: number;
  private zoneTick = 0;
  private targetInfo: BotTargetInfo = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    alive: true,
  };

  constructor(
    private scene: THREE.Scene,
    private hf: Heightfield,
    private physics: PhysicsWorld,
    private ballistics: Ballistics,
    private player: PlayerController,
    private playerHealth: Health,
    private camera: THREE.PerspectiveCamera,
    private audio: AudioSystem
  ) {
    this.zone = new ZoneController();
    this.wall = new ZoneWall();
    scene.add(this.wall.mesh);
    this.loot = new LootField(hf);
    scene.add(this.loot.group);

    this.playerCapsuleId = physics.addCapsule(player.position, 0.38, 1.75, 'player');

    // Spawn bots spread across walkable land, away from the player.
    let placed = 0;
    let salt = 500;
    while (placed < BOT_COUNT && salt < 5000) {
      salt++;
      const x = (hash2(salt, 41) - 0.5) * 1050;
      const z = (hash2(salt, 97) - 0.5) * 1050;
      if (!hf.walkable(x, z)) continue;
      if (Math.hypot(x - player.position.x, z - player.position.z) < 130) continue;
      const bot = new Bot(placed, new THREE.Vector3(x, hf.height(x, z), z), physics, ballistics);
      this.bots.push(bot);
      scene.add(bot.rig.root);
      placed++;
    }

    // Route bullet damage.
    const prevTargetHit = ballistics.onTargetHit;
    ballistics.onTargetHit = (bh) => {
      prevTargetHit?.(bh);
      const tag = bh.hit.tag.replace('head:', '');
      if (tag === 'player') {
        this.playerHealth.damage(bh.damage, bh.direction.x, bh.direction.z);
      } else if (tag.startsWith('bot:')) {
        const id = parseInt(tag.slice(4), 10);
        const bot = this.bots[id];
        if (bot && bot.alive) {
          bot.damage(bh.damage);
          if (!bot.alive) this.registerKill(bot, bh.hit.tag.startsWith('head:'));
        }
      }
    };
  }

  private registerKill(bot: Bot, headshot: boolean): void {
    this.kills++;
    this.onKillFeed?.({ text: `You ${headshot ? 'headshot' : 'killed'} Bot_${bot.id + 1}` });
    this.audio.play('headshot', { volume: 0.6 });
    this.checkWin();
  }

  get aliveCount(): number {
    return this.bots.filter((b) => b.alive).length + (this.playerHealth.dead ? 0 : 1);
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
    this.targetInfo.alive = false;
    this.onStateChange?.('dead');
  }

  /** Nearest loot within reach of the player. */
  lootInReach(): LootItem | null {
    return this.loot.nearest(this.player.position);
  }

  fixedUpdate(dt: number): void {
    if (this.state !== 'playing') return;

    // Win detection must not depend on which code path killed the last bot.
    this.checkWin();

    this.zone.update(dt);
    this.wall.set(this.zone.center, this.zone.radius);

    // Player capsule + target info for bots.
    this.physics.updateCapsule(this.playerCapsuleId, this.player.position, !this.playerHealth.dead);
    this.targetInfo.position.copy(this.camera.position);
    this.targetInfo.alive = !this.playerHealth.dead;

    // Bots think at full rate; distant dead ones idle out.
    for (const bot of this.bots) {
      bot.fixedUpdate(dt, this.targetInfo, this.zone.center, this.zone.radius, (from) => {
        // Bot fired: nearby bots + player hear it, positional audio.
        this.audio.playAt(
          'shot-far',
          from.x - this.camera.position.x,
          from.y - this.camera.position.y,
          from.z - this.camera.position.z,
          120
        );
        for (const other of this.bots) {
          if (other !== bot) other.hearShot(from);
        }
      });
    }

    // Bots killing bots keeps the match alive: nothing for now — bots only
    // target the player in this slice (documented scope cut in PROGRESS).

    // Zone damage at 1Hz granularity.
    this.zoneTick += dt;
    if (this.zoneTick >= 0.5) {
      this.zoneTick = 0;
      const pd = this.zone.damageAt(this.player.position.x, this.player.position.z);
      if (pd > 0 && !this.playerHealth.dead) {
        this.playerHealth.damage(pd * 0.5, 0, 0);
      }
      for (const bot of this.bots) {
        if (!bot.alive) continue;
        const bd = this.zone.damageAt(bot.pos.x, bot.pos.z);
        if (bd > 0) {
          bot.damage(bd * 0.5);
          if (!bot.alive) {
            this.onKillFeed?.({ text: `Bot_${bot.id + 1} died to the blue zone` });
            this.checkWin();
          }
        }
      }
    }
  }

  update(dt: number): void {
    this.wall.update(dt);
    this.loot.update(dt);
  }
}
