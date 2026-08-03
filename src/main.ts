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

  await progress(5, 'renderer');
  const renderer = createRenderer(container);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.1, quality.drawDistance);
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

  // Sun shadow volume follows the camera.
  engine.onBeforeRender(() => {
    const p = camera.position;
    atmo.sun.target.position.set(p.x, 0, p.z);
    atmo.sun.position.copy(atmo.sunDir).multiplyScalar(500).add(atmo.sun.target.position);
  });

  await progress(95, 'systems');
  if (params.mode === 'shot' && params.shot) {
    const pose = findPose(params.shot);
    if (!pose) throw new Error(`Unknown shot pose '${params.shot}'`);
    applyPose(camera, hf, pose);
    signalReadyAfter(40, renderer);
  } else if (params.mode === 'bench') {
    engine.add(new BenchFly(engine, hf));
  } else {
    const input = new Input(renderer.domElement);
    camera.position.set(-20, hf.height(-20, 82) + 1.8, 82);
    camera.lookAt(120, hf.height(120, 100) + 3, 100);
    engine.add(new FlyCamera(camera, input));
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
