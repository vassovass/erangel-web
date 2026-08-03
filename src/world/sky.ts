import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// Analytic sky + sun + atmosphere. The sky gets rendered once into a PMREM
// environment map so every PBR material receives plausible ambient and
// reflections without any HDRI download.

export interface Atmosphere {
  sky: Sky;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sunDir: THREE.Vector3;
  /** Re-renders the environment map (call once after setup or on tod change). */
  bakeEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void;
}

export function createAtmosphere(timeOfDay: number): Atmosphere {
  const sky = new Sky();
  sky.scale.setScalar(45000);

  // 16.5 -> late-afternoon PUBG glow; noon is flatter, dusk more dramatic.
  const dayT = (timeOfDay - 6) / 12; // 0 at 06:00, 1 at 18:00
  const elevation = Math.sin(Math.PI * Math.min(Math.max(dayT, 0.02), 0.98)) * 62;
  const azimuth = 180 + (dayT - 0.5) * 130;

  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);

  const u = sky.material.uniforms;
  u.sunPosition.value.copy(sunDir);
  u.turbidity.value = 6.5;
  u.rayleigh.value = 1.7;
  u.mieCoefficient.value = 0.0045;
  u.mieDirectionalG.value = 0.82;

  // Sun colour cools as it climbs.
  const warmth = 1 - Math.min(elevation / 55, 1);
  const sunColor = new THREE.Color().setHSL(0.095 - warmth * 0.03, 0.55 + warmth * 0.3, 0.62 - warmth * 0.1);
  const sun = new THREE.DirectionalLight(sunColor, 3.1);
  sun.position.copy(sunDir).multiplyScalar(600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 1200;
  const s = 150;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;

  const hemi = new THREE.HemisphereLight(0xb6c8dd, 0x8a7a58, 0.35);

  return {
    sky,
    sun,
    hemi,
    sunDir,
    bakeEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const skyScene = new THREE.Scene();
      const skyClone = new Sky();
      skyClone.scale.setScalar(45000);
      const cu = skyClone.material.uniforms;
      cu.sunPosition.value.copy(sunDir);
      cu.turbidity.value = u.turbidity.value;
      cu.rayleigh.value = u.rayleigh.value;
      cu.mieCoefficient.value = u.mieCoefficient.value;
      cu.mieDirectionalG.value = u.mieDirectionalG.value;
      skyScene.add(skyClone);
      const envRT = pmrem.fromScene(skyScene, 0.0);
      scene.environment = envRT.texture;
      pmrem.dispose();
    },
  };
}

/** Height fog tinted toward the horizon haze; sky mesh itself is unaffected. */
export function createFog(): THREE.FogExp2 {
  return new THREE.FogExp2(0xc3cfd9, 0.00075);
}
