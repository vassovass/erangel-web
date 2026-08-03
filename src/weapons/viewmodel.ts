import * as THREE from 'three';
import type { System } from '../core/engine';
import type { TextureFactory } from '../gen/texgen';
import type { PlayerController } from '../player/controller';
import type { Weapon } from './weapon';
import { gunMetalRecipe, gunWoodRecipe } from './materials';

// Procedural AKM viewmodel assembled from primitives. The combat-visual
// wow-loop (stream 9) owns making this beautiful; this is the playable base:
// correct proportions, metal/wood split, ADS alignment, fire/reload motion.

export class Viewmodel implements System {
  readonly rig = new THREE.Group();      // attached to camera
  private weaponRoot = new THREE.Group();
  private muzzleAnchor = new THREE.Object3D();
  private hipPose = new THREE.Vector3(0.24, -0.24, -0.55);
  private adsPose = new THREE.Vector3(0, -0.148, -0.42);
  private kick = 0;
  private reloadAnim = 0;
  private swayX = 0;
  private swayY = 0;
  private lastYaw = 0;
  private lastPitch = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    factory: TextureFactory,
    private player: PlayerController,
    private weapon: Weapon
  ) {
    const metal = factory.standard(gunMetalRecipe);
    const wood = factory.standard(gunWoodRecipe);
    metal.envMapIntensity = 0.9;
    wood.envMapIntensity = 0.6;

    const g = this.weaponRoot;

    const box = (
      mat: THREE.Material,
      w: number, h: number, d: number,
      x: number, y: number, z: number,
      rx = 0, ry = 0, rz = 0
    ) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      g.add(m);
      return m;
    };
    const cyl = (mat: THREE.Material, r1: number, r2: number, len: number, x: number, y: number, z: number, alongZ = true) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 14), mat);
      if (alongZ) m.rotation.x = Math.PI / 2;
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };

    // Receiver + dust cover (slightly rounded top via extra thin box)
    box(metal, 0.052, 0.062, 0.30, 0, 0, 0);
    box(metal, 0.048, 0.02, 0.28, 0, 0.04, 0.0);
    // Barrel + front sight + gas tube
    cyl(metal, 0.011, 0.011, 0.34, 0, 0.005, -0.36);
    cyl(metal, 0.016, 0.016, 0.05, 0, 0.005, -0.50);   // muzzle brake
    box(metal, 0.012, 0.05, 0.012, 0, 0.045, -0.44);   // front sight post
    cyl(metal, 0.009, 0.009, 0.22, 0, 0.036, -0.26);   // gas tube
    // Handguards (wood upper + lower)
    box(wood, 0.056, 0.03, 0.16, 0, 0.028, -0.20);
    box(wood, 0.06, 0.045, 0.17, 0, -0.012, -0.205);
    // Magazine: curved via 3 segments
    box(metal, 0.038, 0.1, 0.07, 0, -0.095, -0.028, 0.22);
    box(metal, 0.038, 0.09, 0.065, 0.0, -0.165, 0.005, 0.45);
    box(metal, 0.038, 0.075, 0.06, 0, -0.215, 0.05, 0.7);
    // Pistol grip + trigger guard
    box(wood, 0.034, 0.085, 0.05, 0, -0.075, 0.09, 0.3);
    box(metal, 0.006, 0.03, 0.06, 0, -0.045, 0.03);
    // Stock
    box(wood, 0.04, 0.055, 0.16, 0, -0.01, 0.22, 0.06);
    box(wood, 0.045, 0.085, 0.05, 0, -0.02, 0.30, 0.1);
    // Rear sight + charging handle
    box(metal, 0.03, 0.015, 0.04, 0, 0.052, -0.08);
    box(metal, 0.025, 0.012, 0.012, 0.045, 0.01, -0.05);

    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });

    this.muzzleAnchor.position.set(0, 0.005, -0.53);
    g.add(this.muzzleAnchor);

    this.rig.add(g);
    g.position.copy(this.hipPose);
    camera.add(this.rig);
  }

  /** World-space muzzle position for FX. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzleAnchor.getWorldPosition(out);
  }

  triggerKick(): void {
    this.kick = 1;
  }

  triggerReload(): void {
    this.reloadAnim = 1;
  }

  update(dt: number): void {
    const g = this.weaponRoot;

    // Pose blend hip<->ADS
    const adsT = this.player.ads ? 1 : 0;
    g.position.lerp(adsT ? this.adsPose : this.hipPose, Math.min(1, dt * 12));

    // Look sway: lag behind camera rotation
    const dYaw = this.player.yaw - this.lastYaw;
    const dPitch = this.player.pitch - this.lastPitch;
    this.lastYaw = this.player.yaw;
    this.lastPitch = this.player.pitch;
    const swayScale = this.player.ads ? 0.35 : 1;
    this.swayX = THREE.MathUtils.clamp(this.swayX + dYaw * 1.6, -0.03, 0.03) * (1 - Math.min(1, dt * 8));
    this.swayY = THREE.MathUtils.clamp(this.swayY + dPitch * 1.6, -0.03, 0.03) * (1 - Math.min(1, dt * 8));
    g.position.x += this.swayX * swayScale;
    g.position.y += this.swayY * swayScale;

    // Movement bob
    const speedRatio = Math.min(this.player.speed2D / 6.4, 1);
    const t = performance.now() / 1000;
    if (speedRatio > 0.05) {
      const bobAmp = (this.player.ads ? 0.002 : 0.008) * speedRatio;
      g.position.x += Math.cos(t * 7.5) * bobAmp;
      g.position.y += Math.abs(Math.sin(t * 7.5)) * bobAmp * 1.2;
    }

    // Sprint lower
    if (this.player.isSprinting) {
      g.position.y -= 0.06;
      g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, 0.5, Math.min(1, dt * 8));
      g.rotation.y = THREE.MathUtils.lerp(g.rotation.y, 0.35, Math.min(1, dt * 8));
    } else {
      g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, 0, Math.min(1, dt * 10));
      g.rotation.y = THREE.MathUtils.lerp(g.rotation.y, 0, Math.min(1, dt * 10));
    }

    // Fire kick spring
    if (this.kick > 0) {
      this.kick = Math.max(0, this.kick - dt * 9);
      const k = this.kick;
      g.position.z += k * 0.035;
      g.rotation.x += k * 0.05;
    }

    // Reload dip + tilt
    if (this.reloadAnim > 0) {
      this.reloadAnim = Math.max(0, this.reloadAnim - dt / 2.9);
      const phase = 1 - this.reloadAnim; // 0..1
      const dip = Math.sin(Math.min(phase * 1.6, 1) * Math.PI);
      g.position.y -= dip * 0.09;
      g.rotation.z = dip * 0.5;
      g.rotation.x += dip * 0.25;
    } else {
      g.rotation.z = THREE.MathUtils.lerp(g.rotation.z, 0, Math.min(1, dt * 10));
    }
  }
}
