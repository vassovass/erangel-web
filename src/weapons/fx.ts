import * as THREE from 'three';
import type { System } from '../core/engine';
import type { RayHit } from '../player/physics';

// Combat FX pools, all GPU-cheap: instanced tracers, muzzle flash sprite +
// brief point light, surface-matched impact particles, fading decals.

const TRACER_COUNT = 24;
const IMPACT_COUNT = 16;
const DECAL_COUNT = 48;
const PARTICLES_PER_IMPACT = 10;

export class CombatFX implements System {
  readonly group = new THREE.Group();

  private tracers: { mesh: THREE.Mesh; life: number }[] = [];
  private tracerIdx = 0;

  private muzzleSprite: THREE.Sprite;
  private muzzleLight: THREE.PointLight;
  private muzzleLife = 0;

  private impacts: { points: THREE.Points; vels: Float32Array; life: number }[] = [];
  private impactIdx = 0;

  private decals: { mesh: THREE.Mesh; life: number }[] = [];
  private decalIdx = 0;

  constructor(private camera: THREE.PerspectiveCamera) {
    // Tracers: thin stretched boxes, additive.
    const tracerGeo = new THREE.BoxGeometry(0.012, 0.012, 1);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    for (let i = 0; i < TRACER_COUNT; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }

    // Muzzle flash: canvas-drawn star sprite + light.
    this.muzzleSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeFlashTexture(),
        color: 0xffe0a0,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      })
    );
    this.muzzleSprite.scale.setScalar(0.55);
    this.muzzleSprite.visible = false;
    this.muzzleSprite.renderOrder = 999;
    this.group.add(this.muzzleSprite);
    this.muzzleLight = new THREE.PointLight(0xffb45e, 0, 9, 2);
    this.group.add(this.muzzleLight);

    // Impact particle bursts.
    for (let i = 0; i < IMPACT_COUNT; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PARTICLES_PER_IMPACT * 3), 3));
      const mat = new THREE.PointsMaterial({
        size: 0.05,
        color: 0xbfae94,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const points = new THREE.Points(geo, mat);
      points.visible = false;
      points.frustumCulled = false;
      this.group.add(points);
      this.impacts.push({ points, vels: new Float32Array(PARTICLES_PER_IMPACT * 3), life: 0 });
    }

    // Decals: small dark quads.
    const decalGeo = new THREE.PlaneGeometry(0.14, 0.14);
    for (let i = 0; i < DECAL_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: makeDecalTexture(),
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      const mesh = new THREE.Mesh(decalGeo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.decals.push({ mesh, life: 0 });
    }
  }

  /** Tracer along a segment (called from ballistics onTrace, throttled). */
  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const t = this.tracers[this.tracerIdx];
    this.tracerIdx = (this.tracerIdx + 1) % TRACER_COUNT;
    const len = from.distanceTo(to);
    t.mesh.position.copy(from).add(to).multiplyScalar(0.5);
    t.mesh.scale.set(1, 1, len);
    t.mesh.lookAt(to);
    t.mesh.visible = true;
    t.life = 0.07;
  }

  muzzleFlash(worldPos: THREE.Vector3, life = 0.045): void {
    this.muzzleSprite.position.copy(worldPos);
    this.muzzleSprite.material.rotation = (worldPos.x * 7919 + worldPos.z * 104729) % 6.28;
    this.muzzleSprite.visible = true;
    this.muzzleLight.position.copy(worldPos);
    this.muzzleLight.intensity = 14;
    this.muzzleLife = life;
  }

  impact(hit: RayHit): void {
    const imp = this.impacts[this.impactIdx];
    this.impactIdx = (this.impactIdx + 1) % IMPACT_COUNT;
    const pos = imp.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < PARTICLES_PER_IMPACT; i++) {
      pos.setXYZ(i, hit.point.x, hit.point.y, hit.point.z);
      const h1 = fract(Math.sin((i + 1) * 127.1 + hit.point.x * 311.7) * 43758.5);
      const h2 = fract(Math.sin((i + 1) * 269.5 + hit.point.z * 183.3) * 24634.6);
      const h3 = fract(Math.sin((i + 1) * 419.2 + hit.point.y * 371.9) * 31415.9);
      const dir = new THREE.Vector3(h1 - 0.5, h2 * 0.9 + 0.2, h3 - 0.5).normalize();
      dir.addScaledVector(hit.normal, 1.4).normalize();
      const speed = 1.5 + h1 * 2.5;
      imp.vels[i * 3] = dir.x * speed;
      imp.vels[i * 3 + 1] = dir.y * speed;
      imp.vels[i * 3 + 2] = dir.z * speed;
    }
    pos.needsUpdate = true;
    const mat = imp.points.material as THREE.PointsMaterial;
    mat.color.setHex(hit.kind === 'terrain' ? 0xa8977a : 0x9a9a94);
    mat.opacity = 1;
    imp.points.visible = true;
    imp.life = 0.5;

    // Decal on stable surfaces only.
    if (hit.kind !== 'capsule') {
      const d = this.decals[this.decalIdx];
      this.decalIdx = (this.decalIdx + 1) % DECAL_COUNT;
      d.mesh.position.copy(hit.point).addScaledVector(hit.normal, 0.012);
      d.mesh.lookAt(hit.point.clone().add(hit.normal));
      d.mesh.visible = true;
      (d.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
      d.life = 14;
    }
  }

  update(dt: number): void {
    for (const t of this.tracers) {
      if (!t.mesh.visible) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
    if (this.muzzleSprite.visible) {
      this.muzzleLife -= dt;
      if (this.muzzleLife <= 0) {
        this.muzzleSprite.visible = false;
        this.muzzleLight.intensity = 0;
      }
    }
    for (const imp of this.impacts) {
      if (!imp.points.visible) continue;
      imp.life -= dt;
      if (imp.life <= 0) {
        imp.points.visible = false;
        continue;
      }
      const pos = imp.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < PARTICLES_PER_IMPACT; i++) {
        imp.vels[i * 3 + 1] -= 9.8 * dt;
        pos.setXYZ(
          i,
          pos.getX(i) + imp.vels[i * 3] * dt,
          pos.getY(i) + imp.vels[i * 3 + 1] * dt,
          pos.getZ(i) + imp.vels[i * 3 + 2] * dt
        );
      }
      pos.needsUpdate = true;
      (imp.points.material as THREE.PointsMaterial).opacity = imp.life * 2;
    }
    for (const d of this.decals) {
      if (!d.mesh.visible) continue;
      d.life -= dt;
      if (d.life <= 0) d.mesh.visible = false;
      else if (d.life < 2) (d.mesh.material as THREE.MeshBasicMaterial).opacity = d.life * 0.42;
    }
  }
}

function makeFlashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,240,200,1)');
  g.addColorStop(0.25, 'rgba(255,190,110,0.9)');
  g.addColorStop(0.6, 'rgba(255,140,50,0.25)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  // Star spikes
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = 'rgba(255,220,160,0.8)';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(64, 64);
    ctx.lineTo(64 + Math.cos(a) * 60, 64 + Math.sin(a) * 60);
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  return new THREE.CanvasTexture(c);
}

function makeDecalTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(20,16,12,0.95)');
  g.addColorStop(0.5, 'rgba(30,26,20,0.6)');
  g.addColorStop(1, 'rgba(30,26,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function fract(v: number): number {
  return v - Math.floor(v);
}
