import * as THREE from 'three';
import { Engine } from './core/engine';
import { createRenderer } from './core/renderer';
import { Input } from './core/input';
import { parseBootParams, quality } from './core/settings';
import { TextureFactory } from './gen/texgen';
import { Heightfield } from './gen/terraingen';
import { Terrain } from './world/terrain';
import { createAtmosphere, createFog } from './world/sky';
import { createWater } from './world/water';
import { FlyCamera } from './debug/flycam';
import { findPose, applyPose, signalReadyAfter } from './debug/shots';
import { BenchFly } from './debug/bench';
import { WORLD_SEED } from './gen/noise';
import { PhysicsWorld } from './player/physics';
import { PlayerController } from './player/controller';
import { Health } from './player/health';
import { Footsteps } from './player/footsteps';
import { Ballistics } from './weapons/ballistics';
import { Weapon } from './weapons/weapon';
import { CombatFX } from './weapons/fx';
import { Viewmodel } from './weapons/viewmodel';
import { AudioSystem } from './gen/audiogen';
import { Hud } from './ui/hud';
import { Match } from './match/match';
import { buildSettlements } from './world/buildings';
import { Vegetation } from './world/vegetation';
import { PostPipeline } from './post/pipeline';

const loadbar = document.getElementById('loadbar')!;
const loadstep = document.getElementById('loadstep')!;
const loading = document.getElementById('loading')!;

function progress(pct: number, label: string): Promise<void> {
  (loadbar as HTMLElement).style.width = `${pct}%`;
  loadstep.textContent = label;
  return new Promise((r) => requestAnimationFrame(() => r()));
}

async function boot(): Promise<void> {
  const params = parseBootParams();
  const container = document.getElementById('app')!;
  const urlqEarly = new URLSearchParams(location.search);

  await progress(5, 'renderer');
  const renderer = createRenderer(container);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.08, quality.drawDistance);
  scene.add(camera); // viewmodel rig renders as a camera child
  const engine = new Engine(renderer, scene, camera);

  await progress(15, 'baking materials');
  const factory = new TextureFactory(renderer);

  await progress(30, 'generating terrain');
  const hf = new Heightfield(params.seedOverride ?? WORLD_SEED);
  const terrain = new Terrain(hf, factory);
  await terrain.build((done, total) => progress(30 + (done / total) * 40, `terrain ${done}/${total}`));
  scene.add(terrain.group);

  await progress(75, 'atmosphere');
  const atmo = createAtmosphere(params.timeOfDay);
  scene.add(atmo.sky, atmo.sun, atmo.sun.target, atmo.hemi);
  scene.fog = createFog();
  atmo.bakeEnvironment(renderer, scene);

  await progress(85, 'sea');
  scene.add(createWater());

  await progress(88, 'settlements');
  const physics = new PhysicsWorld(hf);
  const built = buildSettlements(hf, factory, physics);
  scene.add(built.group);

  await progress(92, 'vegetation');
  const vegetation = new Vegetation(hf, camera, physics, (params.seedOverride ?? WORLD_SEED) + 5000);
  scene.add(vegetation.group);
  engine.add(vegetation);

  // Post pipeline (SMAA/bloom/grade). ?nopost=1 for raw A/B comparison.
  if (!urlqEarly.has('nopost')) {
    const post = new PostPipeline(renderer, scene, camera);
    post.setSize(window.innerWidth, window.innerHeight);
    engine.pipeline = post;
  }

  // Sun shadow volume follows the camera.
  engine.onBeforeRender(() => {
    const p = camera.position;
    atmo.sun.target.position.set(p.x, 0, p.z);
    atmo.sun.position.copy(atmo.sunDir).multiplyScalar(500).add(atmo.sun.target.position);
  });

  await progress(95, 'systems');
  const urlq = new URLSearchParams(location.search);

  if (params.mode === 'shot' && params.shot) {
    const pose = findPose(params.shot);
    if (!pose) throw new Error(`Unknown shot pose '${params.shot}'`);
    applyPose(camera, hf, pose);
    signalReadyAfter(40, renderer);
    // Re-pose without a reload: capture.mjs boots once per cycle and calls this.
    (window as unknown as Record<string, unknown>).__APPLY_POSE__ = (name: string) => {
      const p = findPose(name);
      if (!p) return false;
      window.__SHOT_READY__ = undefined;
      applyPose(camera, hf, p);
      signalReadyAfter(30, renderer);
      return true;
    };
  } else if (params.mode === 'bench') {
    engine.add(new BenchFly(engine, hf));
  } else if (urlq.has('fly')) {
    const input = new Input(renderer.domElement);
    camera.position.set(-20, hf.height(-20, 82) + 1.8, 82);
    camera.lookAt(120, hf.height(120, 100) + 3, 100);
    engine.add(new FlyCamera(camera, input));
  } else {
    // ---- Game mode: player + weapon + FX + audio + HUD ----
    const input = new Input(renderer.domElement);
    const audio = new AudioSystem();

    const spawnX = 10, spawnZ = 95;
    const spawn = new THREE.Vector3(spawnX, hf.height(spawnX, spawnZ), spawnZ);
    const player = new PlayerController(camera, input, physics, spawn);
    const health = new Health();
    const ballistics = new Ballistics(physics);
    const fx = new CombatFX(camera);
    scene.add(fx.group);
    const weapon = new Weapon(camera, input, player, ballistics);
    const viewmodel = new Viewmodel(camera, factory, player, weapon);

    // Feedback hook FIRST — Match wraps it with the damage router.
    ballistics.onTargetHit = (bh) => {
      const tag = bh.hit.tag.replace('head:', '');
      if (tag.startsWith('bot:')) {
        hudRef?.showHitmarker();
        audio.play(bh.hit.tag.startsWith('head:') ? 'headshot' : 'hit', { volume: 0.5 });
      }
    };

    const match = new Match(scene, hf, physics, ballistics, player, health, camera, audio, built.lootSpots);
    const hud = new Hud(weapon, health, match, player);
    let hudRef: Hud | null = hud;

    match.onKillFeed = (e) => hud.addFeedLine(e.text);
    match.onStateChange = (s) => {
      if (s === 'won' || s === 'dead') hud.showEnd(s, match.kills, match.aliveCount);
    };
    health.onDamage = () => hud.showDamage();
    health.onDeath = () => match.playerDied();
    const _muzzle = new THREE.Vector3();

    weapon.onShot = () => {
      viewmodel.triggerKick();
      viewmodel.muzzleWorld(_muzzle);
      fx.muzzleFlash(_muzzle);
      audio.play('shot', { volume: 0.9, detuneJitter: 0.04 });
      for (const bot of match.bots) bot.hearShot(player.position);
    };
    weapon.onReloadStart = () => {
      viewmodel.triggerReload();
      audio.play('mag-out');
      setTimeout(() => audio.play('mag-in'), 1400);
      setTimeout(() => audio.play('bolt'), 2300);
    };
    weapon.onDryFire = () => audio.play('dry');
    ballistics.onImpact = (hit) => {
      fx.impact(hit);
      audio.playAt('step-dirt', hit.point.x - camera.position.x, hit.point.y - camera.position.y, hit.point.z - camera.position.z, 10);
    };
    // Match installs the damage router on top of this feedback hook.
    ballistics.onTargetHit = (bh) => {
      const tag = bh.hit.tag.replace('head:', '');
      if (tag.startsWith('bot:')) {
        hud.showHitmarker();
        audio.play(bh.hit.tag.startsWith('head:') ? 'headshot' : 'hit', { volume: 0.5 });
      }
    };
    ballistics.onTrace = (from, to) => {
      if (from.distanceToSquared(camera.position) > 25) fx.tracer(from, to);
    };
    ballistics.listenerPos = camera.position;
    ballistics.onWhiz = () => audio.play('whiz', { volume: 0.55, detuneJitter: 0.25 });

    engine.add(player);
    engine.add(weapon);
    engine.add({ fixedUpdate: (dt) => ballistics.fixedUpdate(dt) });
    engine.add({ fixedUpdate: (dt) => match.fixedUpdate(dt), update: (dt) => match.update(dt) });
    engine.add(viewmodel);
    engine.add(fx);
    engine.add(new Footsteps(player, hf, audio));
    engine.add({
      fixedUpdate: () => {
        if (input.wasPressed('interact') && match.state === 'playing') {
          const item = match.lootInReach();
          if (item) {
            match.loot.take(item);
            if (item.type === 'ammo') {
              weapon.reserve += 30;
              audio.play('pickup', { volume: 0.7 });
            } else {
              health.heal(item.type === 'medkit' ? 75 : 15);
              audio.play('heal', { volume: 0.7 });
            }
          }
        }
      },
    });
    engine.add({ update: (dt) => hud.update(dt) });
    engine.add({
      update: () => {
        const d = Math.hypot(player.position.x - match.zone.center.x, player.position.z - match.zone.center.z);
        audio.setZoneProximity(match.zone.radius - d);
      },
    });
    engine.add({ update: () => input.endFrame() });

    // Scripted-playtest hooks (tools/playtest.mjs). Read-only state plus two
    // levers the harness needs; harmless if untouched in normal play.
    (window as unknown as Record<string, unknown>).__TEST__ = {
      state: () => ({
        playerPos: player.position.toArray(),
        playerHp: health.hp,
        playerDead: health.dead,
        ammo: weapon.ammo,
        reserve: weapon.reserve,
        kills: match.kills,
        alive: match.aliveCount,
        botsAlive: match.bots.filter((b) => b.alive).length,
        zoneRadius: match.zone.radius,
        zonePhase: match.zone.phaseIndex,
        matchState: match.state,
        lootNearby: match.lootInReach()?.type ?? null,
      }),
      damageBot: (i: number, amt: number) => {
        const b = match.bots[i];
        if (b && b.alive) {
          b.damage(amt);
          if (!b.alive) match.kills++;
        }
      },
      ffwdZone: (seconds: number) => {
        for (let s = 0; s < seconds * 2; s++) match.zone.update(0.5);
      },
      teleport: (x: number, z: number) => {
        player.position.set(x, hf.height(x, z), z);
      },
    };
  }

  engine.start();
  await progress(100, 'ready');
  loading.classList.add('done');
}

boot().catch((err) => {
  loadstep.textContent = `BOOT FAILED: ${err instanceof Error ? err.message : String(err)}`;
  (loadstep as HTMLElement).style.color = '#e05a4e';
  console.error(err);
});
