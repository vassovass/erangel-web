import * as THREE from 'three';
import type { Heightfield } from '../gen/terraingen';

// Named camera poses for the capture harness. Positions are (x, heightAboveGround, z);
// the pose resolves against the heightfield at boot so terrain changes never
// bury a camera. The capture script waits for window.__SHOT_READY__.

export interface ShotPose {
  name: string;
  pos: [number, number, number];
  target: [number, number, number];
  fov?: number;
}

export const POSES: ShotPose[] = [
  // Phase 1 world poses
  { name: 'terrain-vista', pos: [-260, 38, -300], target: [180, 6, 320], fov: 66 },
  { name: 'fields-low', pos: [120, 1.8, 200], target: [-300, 30, -260], fov: 74 },
  { name: 'hill-ridge', pos: [-330, 24, -410], target: [200, 2, 300], fov: 70 },
  { name: 'road-level', pos: [-90, 1.7, 108], target: [200, 4, 115], fov: 74 },
  { name: 'coast-line', pos: [430, 12, 380], target: [-100, 2, 560], fov: 70 },
  { name: 'village-street', pos: [-20, 1.7, 82], target: [120, 3, 100], fov: 74 },
  { name: 'forest-edge', pos: [-150, 2.2, -60], target: [-320, 18, -260], fov: 74 },
  // Vegetation stream poses
  { name: 'meadow-close', pos: [220, 1.5, 260], target: [150, 4, 180], fov: 74 },
  { name: 'treeline', pos: [-120, 2.0, -140], target: [-240, 12, -240], fov: 66 },
  { name: 'grass-ground', pos: [160, 0.9, 300], target: [80, 2, 240], fov: 78 },
  // Buildings stream poses
  { name: 'village-yard', pos: [40, 1.7, 60], target: [-30, 3, 95], fov: 70 },
  { name: 'farm-compound', pos: [-50, 2.2, -100], target: [-75, 3, -122], fov: 70 },
  { name: 'house-close', pos: [18, 1.7, 78], target: [-15, 2.5, 95], fov: 66 },
  // Combat-visual stream poses (weapon-* poses spawn the viewmodel rig)
  { name: 'weapon-hip', pos: [0, 1.68, 95], target: [60, 4, 40], fov: 74 },
  { name: 'weapon-ads', pos: [0, 1.68, 95], target: [60, 4, 40], fov: 74 },
  { name: 'bots-mid', pos: [30, 1.8, 120], target: [90, 2, 150], fov: 66 },
];

declare global {
  interface Window {
    __SHOT_READY__?: boolean;
    __BENCH_RESULT__?: string;
    __INFO__?: () => { calls: number; triangles: number };
  }
}

export function findPose(name: string): ShotPose | undefined {
  return POSES.find((p) => p.name === name);
}

export function applyPose(camera: THREE.PerspectiveCamera, hf: Heightfield, pose: ShotPose): void {
  const [px, py, pz] = pose.pos;
  const [tx, ty, tz] = pose.target;
  camera.position.set(px, hf.height(px, pz) + py, pz);
  camera.lookAt(tx, hf.height(tx, tz) + ty, tz);
  if (pose.fov) {
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
  }
}

/** Flags readiness after `frames` rendered frames (lets shadows/mips settle). */
export function signalReadyAfter(frames: number, renderer: THREE.WebGLRenderer): void {
  let count = 0;
  const tick = () => {
    count++;
    if (count >= frames) {
      window.__INFO__ = () => ({
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      });
      window.__SHOT_READY__ = true;
    } else {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}
