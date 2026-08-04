import * as THREE from 'three';
import type { System } from '../core/engine';
import type { RayHit } from '../player/physics';
import { vmLink } from './vm-link';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sweep, circleProfile, tintGeo } from './vm-geometry';

// Combat FX pools, all GPU-cheap: instanced-ish pooled quads, no per-shot
// allocation. The muzzle flash is LAYERED rather than one billboard sprite —
// a real flash reads as (a) a blown-out core at the crown, (b) petals thrown
// radially around the BARREL AXIS, (c) a short flare stretched downrange, and
// (d) a backlit smoke puff that outlives all three. One sprite can fake maybe
// one of those; four cheap quads get the whole read for four draw calls that
// only exist while the trigger is down.
//
// THE FLASH IS AN HDR LIGHT SOURCE, NOT A DECAL. Two things follow, and both
// were missing:
//   * Its layers are authored ABOVE 1.0 radiance (THREE.Color takes values > 1)
//     so they clip to white and cross the bloom threshold at 1.12. Authored at
//     or below 1.0 the brightest thing in the game could not bloom, and ACES
//     then compressed it into a dull cream disc.
//   * Its point light has to actually reach the gun. Seated exactly on the
//     crown, N·L is ~0 for every barrel and handguard normal, so the weapon
//     15 cm from a muzzle flash rendered unlit. It now sits back along the bore
//     and above it, and outlives the sprites so the illumination survives more
//     than a frame or two.

const TRACER_COUNT = 24;
const IMPACT_COUNT = 16;
const DECAL_COUNT = 48;
const PARTICLES_PER_IMPACT = 10;
const BILLOW_COUNT = 12;
const SPARK_COUNT = 5;

/** Flash phase held for capture stills (muzzleFlash life > this = hero hold). */
const HOLD_THRESHOLD = 0.5;
const HOLD_PHASE = 0.22;

const UNIT_X = new THREE.Vector3(1, 0, 0);

export class CombatFX implements System {
  readonly group = new THREE.Group();

  private tracers: { mesh: THREE.Mesh; life: number; total: number }[] = [];
  private tracerIdx = 0;

  private flashCore: THREE.Sprite;
  private flashPetals: THREE.Mesh;
  private flashFlare: THREE.Mesh;
  private flashSmoke: THREE.Sprite;
  private casing: THREE.Mesh;
  private sparks: THREE.Points;
  private muzzleLight: THREE.PointLight;
  private bodyLight: THREE.PointLight;
  private muzzleLife = 0;
  private muzzleTotal = 1;
  private muzzlePos = new THREE.Vector3();
  /** Screen-aligned flash origin — see vmLink.flashScale. */
  private flashPos = new THREE.Vector3();
  private muzzleDir = new THREE.Vector3(0, 0, -1);
  private muzzleSpin = 0;
  private holdFor = 0;
  private poseEpoch = 0;
  private _mi = new THREE.Matrix4();

  private impacts: { points: THREE.Points; vels: Float32Array; life: number }[] = [];
  private impactIdx = 0;

  private billows: { sprite: THREE.Sprite; life: number; total: number; spin: number }[] = [];
  private billowIdx = 0;

  private decals: { mesh: THREE.Mesh; life: number }[] = [];
  private decalIdx = 0;

  private _m = new THREE.Matrix4();
  private _x = new THREE.Vector3();
  private _y = new THREE.Vector3();
  private _z = new THREE.Vector3();
  private _t = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera) {
    // Tracers: crossed quads with a head-bright gradient — a single flat box
    // vanishes edge-on, the cross never does.
    const tracerGeo = crossQuadGeometry(0.07);
    const tracerMat = new THREE.MeshBasicMaterial({
      map: makeTracerTexture(),
      // Authored above 1.0 for the same reason the flash is: an additive quad
      // at or below unit radiance adds nothing visible over a bright Erangel
      // sky, which is why no tracer appeared in any cycle-2 capture.
      color: new THREE.Color().setRGB(1.0, 0.66, 0.26).multiplyScalar(3.0),
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    for (let i = 0; i < TRACER_COUNT; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, life: 0, total: 1 });
    }

    // --- muzzle flash stack ---
    // depthTest is ON for everything but the core: the weapon draws after these
    // (it owns the last depth range in the frame, see viewmodel.ts), so the
    // brake and front-sight ears cut hard silhouettes into the flash envelope
    // instead of the flash washing across the handguard.
    this.flashSmoke = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeSmokeTexture(),
        color: 0xd8c4a6,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        toneMapped: true,
      })
    );
    this.flashSmoke.renderOrder = 996;
    this.flashSmoke.visible = false;
    this.group.add(this.flashSmoke);

    // Axial cone, not a billboard quad: a quad through the barrel axis
    // collapses to a sliver exactly when the player is looking down that axis,
    // which in first person is always. Radii run NARROW at the crown and wide
    // downrange (a flame), so the ring the camera sees head-on is 7 mm across
    // instead of a 10-sided opaque decagon 11 cm across; 32 segments and an
    // alpha that dies before the rim finish the job.
    this.flashFlare = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 0.12, 1, 32, 1, true),
      new THREE.MeshBasicMaterial({
        map: makeFlareTexture(),
        // THE CONE IS THE DOMINANT READ NOW, not the core. Cycle 2 ran the core
        // at 6x and the cone at 2.6x, and the measured flash-core mean RGB came
        // out [254.4, 248.9, 238.9] — a 6% warm bias, i.e. white. All three
        // channels clipped, ACES ate the chroma, and the reference AKM's orange
        // teardrop rendered as a white lens blob. Cone up, core down, so the
        // band that survives tonemapping is the orange one.
        color: new THREE.Color().setRGB(1.0, 0.55, 0.15).multiplyScalar(4.4),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      })
    );
    this.flashFlare.renderOrder = 997;
    this.flashFlare.visible = false;
    this.flashFlare.frustumCulled = false;
    this.group.add(this.flashFlare);

    this.flashPetals = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makePetalTexture(),
        // Re-weighted toward the mid-radiance band that survives ACES: at
        // (1.0, 0.72, 0.34) x 3.2 the green and blue channels clipped too and
        // the petals went cream.
        color: new THREE.Color().setRGB(1.0, 0.46, 0.14).multiplyScalar(3.0),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      })
    );
    this.flashPetals.renderOrder = 998;
    this.flashPetals.visible = false;
    this.flashPetals.frustumCulled = false;
    this.group.add(this.flashPetals);

    this.flashCore = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeCoreTexture(),
        // 2.2x, not 6x. Past ~1.12 a value blooms; past ~3 every channel clips
        // and the layer stops being a hot CORE and becomes a white disc big
        // enough to swallow the cone, the petals and the front sight with it.
        color: new THREE.Color().setRGB(1.0, 0.93, 0.74).multiplyScalar(2.2),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      })
    );
    this.flashCore.renderOrder = 999;
    this.flashCore.visible = false;
    this.group.add(this.flashCore);

    // Ejected case. One small mesh, but a rifle that never throws brass reads
    // as a prop; the reference frames all have one in the air. Cycle 2's was an
    // 8-sided faceted rod with both ends capped flat, no rim, no groove, no
    // mouth, and a saturated leaf-gold albedo that made it the most saturated
    // object in a deliberately desaturated frame.
    this.casing = new THREE.Mesh(
      makeCaseGeometry(),
      new THREE.MeshStandardMaterial({
        color: 0x8d6a30,
        metalness: 0.7,
        roughness: 0.45,
        envMapIntensity: 0.5,
        vertexColors: true,
      })
    );
    this.casing.visible = false;
    this.casing.frustumCulled = false;
    this.group.add(this.casing);

    // Sparks: unburnt powder thrown with the gas. Cheap (one Points draw only
    // while the trigger is down) and it is half of what stops a flash reading
    // as a lens artifact.
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARK_COUNT * 3), 3));
    this.sparks = new THREE.Points(
      sparkGeo,
      new THREE.PointsMaterial({
        // A mapless PointsMaterial draws hard SQUARES, and at 0.018 m a third of
        // a metre from the eye that is a row of 20 px white tiles floating next
        // to the muzzle. Round falloff, and small.
        size: 0.011,
        map: makeSparkTexture(),
        color: new THREE.Color().setRGB(1.0, 0.58, 0.16).multiplyScalar(3.2),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      })
    );
    this.sparks.visible = false;
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 998;
    this.group.add(this.sparks);

    // TWO LIGHTS, NOT ONE, and both AHEAD of the gun.
    //
    // Cycle 2 seated a single decay-2 light 0.14 m back down the bore at
    // intensity 2.9. Under inverse square the handguard sits 0.12-0.2 m from
    // that source, so its irradiance ran 100-200 against a scene sun in single
    // digits — 20-50x — and the measured firing frame clipped barrel, handguard,
    // both hands and the receiver to cream while the identical weapon unfired
    // clipped 0.00%. Worse, the stock 40 cm further away was as blown as the
    // crown, which is physically impossible and is what destroyed weapon
    // readability on every single shot.
    //
    // The crown light stays tight and weak: it exists to make the muzzle device
    // itself glow. The BODY light is seated 0.45 m AHEAD of the crown at decay
    // 1, so the near-far ratio across the 40 cm weapon is ~1.3:1 instead of
    // ~25:1 and the flash lights the gun from downrange, the way it actually
    // does.
    this.muzzleLight = new THREE.PointLight(0xffb070, 0, 0.6, 2);
    this.group.add(this.muzzleLight);
    this.bodyLight = new THREE.PointLight(0xffc08c, 0, 2.6, 1);
    this.group.add(this.bodyLight);

    // Impact particle bursts.
    for (let i = 0; i < IMPACT_COUNT; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PARTICLES_PER_IMPACT * 3), 3));
      const mat = new THREE.PointsMaterial({
        size: 0.04,
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

    // Impact dust billows — the part that sells a hit at distance.
    const billowTex = makeSmokeTexture();
    for (let i = 0; i < BILLOW_COUNT; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: billowTex,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
      );
      sprite.visible = false;
      this.group.add(sprite);
      this.billows.push({ sprite, life: 0, total: 1, spin: 0 });
    }

    // Decals: small dark quads.
    const decalGeo = new THREE.PlaneGeometry(0.14, 0.14);
    const decalTex = makeDecalTexture();
    for (let i = 0; i < DECAL_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: decalTex,
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
    // Never start a tracer inside the viewmodel's own volume: a segment that
    // begins at the muzzle is only 0.3 m from the eye and slices a hairline
    // across the receiver on its way out.
    this._t.subVectors(to, from);
    const total = this._t.length();
    if (total > 5) from = this._t.normalize().multiplyScalar(2).add(from);
    const len = from.distanceTo(to);
    t.mesh.position.copy(from).add(to).multiplyScalar(0.5);
    t.mesh.scale.set(1, 1, len);
    t.mesh.lookAt(to);
    t.mesh.visible = true;
    t.total = Math.max(0.07, this.holdFor);
    t.life = t.total;
  }

  muzzleFlash(worldPos: THREE.Vector3, life = 0.045, worldDir?: THREE.Vector3): void {
    this.muzzlePos.copy(worldPos);
    // Aim along the BORE, not the camera axis. They differ by 3-4 degrees in
    // the hip pose, which is the difference between a flame that has a
    // direction and a cone seen exactly end-on every single shot.
    if (worldDir) this.muzzleDir.copy(worldDir).normalize();
    else if (vmLink.active) this.muzzleDir.copy(vmLink.dir);
    else this.camera.getWorldDirection(this.muzzleDir);
    this.muzzleSpin = (worldPos.x * 7919 + worldPos.z * 104729) % 6.28;
    this.muzzleLife = life;
    this.muzzleTotal = life;
    this.holdFor = life > HOLD_THRESHOLD ? life : 0;
    this.updateFlash(life > HOLD_THRESHOLD ? HOLD_PHASE : 0);
  }

  /** Re-projects the muzzle so a flash drawn in the WORLD projection lands on
   *  the muzzle of a weapon drawn in the VIEWMODEL projection. */
  private alignFlash(): void {
    this.flashPos.copy(this.muzzlePos);
    const k = vmLink.flashScale;
    if (Math.abs(k - 1) < 0.002) return;
    this.camera.updateMatrixWorld();
    this._mi.copy(this.camera.matrixWorld).invert();
    this.flashPos.applyMatrix4(this._mi);
    this.flashPos.x *= k;
    this.flashPos.y *= k;
    this.flashPos.applyMatrix4(this.camera.matrixWorld);
  }

  /** Lays the flash layers out for a normalised phase 0..1. */
  private updateFlash(phase: number): void {
    const p = Math.min(1, Math.max(0, phase));
    const dir = this.muzzleDir;
    this.alignFlash();
    const pos = this.flashPos;
    // Everything the flash measures in world metres has to scale with the
    // projection it is being matched into, or it reads too small next to the
    // gun (and, in ADS, half the size it should be).
    const k = vmLink.flashScale;

    // Cylindrical billboard basis around the barrel axis. Built from a STABLE
    // reference (the camera's up), not from the camera-to-muzzle vector: in the
    // ADS pose those two subtend about 3 degrees and the cross product's
    // direction is numerically arbitrary, which made the petal roll flicker.
    this._x.crossVectors(dir, this.camera.up);
    if (this._x.lengthSq() < 1e-6) this._x.crossVectors(dir, UNIT_X);
    this._x.normalize();
    this._z.crossVectors(this._x, dir).normalize();

    // ALONG-BORE OFFSETS ARE NOT SCALED BY k. k is a SCREEN-SPACE correction —
    // alignFlash multiplies camera-space x and y by it so a world-projection
    // effect lands on a viewmodel-projection barrel. Applying it to distances
    // measured down the bore is a category error, and at k = 1.3 it pushed the
    // cone's -0.015 seating offset back to -0.020, i.e. into the barrel, where
    // depthTest clipped the near half of the plume away. Sizes still scale
    // (they are screen-size quantities); positions along dir do not.

    // (a) core: hot crown point, dies first. Small on purpose — see the colour
    // note in the constructor.
    const coreK = Math.pow(1 - p, 1.7);
    this.flashCore.visible = coreK > 0.02;
    this.flashCore.position.copy(pos).addScaledVector(dir, 0.022);
    this.flashCore.scale.setScalar((0.043 + 0.03 * (1 - coreK) + coreK * 0.035) * k);
    this.flashCore.material.opacity = coreK;
    this.flashCore.material.rotation = this.muzzleSpin;

    // (b) petals: the gas plume square to the bore, spun per shot
    const petalK = Math.pow(1 - p, 1.25) * Math.min(1, 0.45 + p * 2.6);
    this.flashPetals.visible = petalK > 0.02;
    this.flashPetals.position.copy(pos).addScaledVector(dir, 0.042);
    this._m.makeBasis(this._x, this._z, this._t.copy(dir).negate());
    this.flashPetals.quaternion.setFromRotationMatrix(this._m);
    this.flashPetals.rotateZ(this.muzzleSpin);
    this.flashPetals.scale.setScalar((0.13 + p * 0.22) * k);
    (this.flashPetals.material as THREE.MeshBasicMaterial).opacity = petalK * 0.55;

    // (c) flare cone: narrow at the crown, opening downrange. Longer than
    // cycle 2 so the forward teardrop, not the core, is what the eye reads.
    const flareK = Math.pow(1 - p, 2.2);
    const flareLen = (0.34 + p * 0.2) * k;
    const flareR = (0.058 + p * 0.028) * k;
    this._m.makeBasis(this._x, dir, this._z);
    this.flashFlare.quaternion.setFromRotationMatrix(this._m);
    this.flashFlare.position.copy(pos).addScaledVector(dir, flareLen * 0.5 - 0.012);
    this.flashFlare.scale.set(flareR, flareLen, flareR);
    // Seen straight down the bore a cone has no flame to show, only its rings.
    // Fade it there and let the core and petals carry the read.
    this._t.subVectors(this.camera.position, pos).normalize();
    const endOn = Math.abs(this._t.dot(dir));
    const coneVis = flareK * (0.34 + 0.66 * (1 - THREE.MathUtils.smoothstep(endOn, 0.86, 0.995)));
    this.flashFlare.visible = coneVis > 0.02;
    (this.flashFlare.material as THREE.MeshBasicMaterial).opacity = coneVis * 0.85;

    // (d) smoke: lit from inside early, drifts and fades last. Ramped ON from
    // the first frame (cycle 2's sine started near zero and never reached a
    // visible opacity in any capture) and authored DARKER than the sky it sits
    // against — a pale puff over a bright Erangel sky subtracts nothing and is
    // simply not there.
    const smokeK = Math.min(1, 0.35 + p * 1.6) * Math.pow(1 - p * 0.85, 1.2);
    this.flashSmoke.visible = smokeK > 0.01;
    this.flashSmoke.position
      .copy(pos)
      .addScaledVector(dir, 0.06 + p * 0.14)
      .addScaledVector(this._z, p * 0.045);
    this.flashSmoke.scale.setScalar((0.15 + p * 0.46) * k);
    this.flashSmoke.material.opacity = smokeK * 0.72;
    this.flashSmoke.material.rotation = this.muzzleSpin * 0.7;
    this.flashSmoke.material.color.setRGB(0.62 - p * 0.14, 0.57 - p * 0.14, 0.5 - p * 0.13);

    // (e) sparks: a short stream of embers down the bore, 20-40 ms.
    const sparkK = Math.pow(Math.max(0, 1 - p * 2.4), 1.3);
    this.sparks.visible = sparkK > 0.02;
    if (this.sparks.visible) {
      const sp = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < SPARK_COUNT; i++) {
        const h = fract(Math.sin((i + 1) * 78.233 + this.muzzleSpin * 13.7) * 43758.5);
        const h2 = fract(Math.sin((i + 1) * 12.9898 + this.muzzleSpin * 7.1) * 24634.6);
        const along = 0.05 + h * 0.9 * (0.25 + p * 3.0);
        this._t
          .copy(pos)
          .addScaledVector(dir, along)
          .addScaledVector(this._x, (h2 - 0.5) * 0.07 * (0.3 + p * 2.0))
          .addScaledVector(this._z, (h - 0.5) * 0.06 * (0.3 + p * 2.0) - p * 0.05);
        sp.setXYZ(i, this._t.x, this._t.y, this._t.z);
      }
      sp.needsUpdate = true;
      (this.sparks.material as THREE.PointsMaterial).opacity = sparkK;
    }

    // (f) ejected case: ballistic arc out of the right of the receiver, with a
    // real tumble about a fixed axis. Fades out rather than sitting crisp and
    // motionless at the end of the arc.
    const ct = p * 0.4;
    this.casing.visible = p < 0.98;
    this.casing.position
      .copy(pos)
      .addScaledVector(dir, -0.4)
      .addScaledVector(this._x, 0.03 + 0.95 * ct)
      .addScaledVector(this._z, 0.012 + 0.72 * ct - 4.9 * ct * ct);
    this.casing.rotation.set(ct * 17.0 + 1.2, ct * 21.0, this.muzzleSpin + ct * 9.0);
    // Early-flight stretch along the case's own long axis (+Z), which is close
    // enough to the velocity vector in the first frames to read as smear.
    const stretch = 1 + Math.max(0, 1 - p * 9) * 0.8;
    this.casing.scale.set(1, 1, stretch);

    // Lights. Both are AHEAD of the weapon; see the constructor for why. The
    // crown light is a glow on the muzzle device, the body light is the key.
    this.muzzleLight.position.copy(this.muzzlePos).addScaledVector(dir, 0.03);
    this.muzzleLight.intensity = 0.07 * Math.pow(1 - p, 1.1);
    this.bodyLight.position.copy(this.muzzlePos).addScaledVector(dir, 0.45);
    this.bodyLight.intensity = 0.95 * Math.pow(1 - p, 1.1);
    // Duck the viewmodel's own fixed key rig while the flash is up, or the two
    // keys add and the weapon goes to a flat white band regardless of material.
    vmLink.flashKey = Math.pow(1 - p, 1.1);
  }

  private hideFlash(): void {
    this.flashCore.visible = false;
    this.flashPetals.visible = false;
    this.flashFlare.visible = false;
    this.flashSmoke.visible = false;
    this.sparks.visible = false;
    this.casing.visible = false;
    this.muzzleLight.intensity = 0;
    this.bodyLight.intensity = 0;
    vmLink.flashKey = 0;
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
    const terrain = hit.kind === 'terrain';
    const mat = imp.points.material as THREE.PointsMaterial;
    mat.color.setHex(terrain ? 0xa8977a : 0x9a9a94);
    mat.opacity = 1;
    imp.points.visible = true;
    imp.life = 0.5;

    // Dust billow: short-lived, surface-tinted, offset out along the normal.
    const b = this.billows[this.billowIdx];
    this.billowIdx = (this.billowIdx + 1) % BILLOW_COUNT;
    b.sprite.position.copy(hit.point).addScaledVector(hit.normal, 0.06);
    b.sprite.material.color.setHex(terrain ? 0xb6a488 : 0xa9a9a2);
    b.spin = fract(Math.sin(hit.point.x * 12.9898 + hit.point.z * 78.233) * 43758.5) * 6.28;
    b.sprite.material.rotation = b.spin;
    b.total = 0.45;
    b.life = b.total;
    b.sprite.visible = true;

    // Decal on stable surfaces only.
    if (hit.kind !== 'capsule') {
      const d = this.decals[this.decalIdx];
      this.decalIdx = (this.decalIdx + 1) % DECAL_COUNT;
      d.mesh.position.copy(hit.point).addScaledVector(hit.normal, 0.012);
      d.mesh.lookAt(this._t.copy(hit.point).add(hit.normal));
      d.mesh.visible = true;
      (d.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
      d.life = 14;
    }
  }

  update(dt: number): void {
    // Held FX (capture stills) do not age out. Headless frame times under load
    // run into whole seconds, so a wall-clock hold expires before the harness
    // takes its screenshot; only gameplay lifetimes are time-based.
    // A held (capture) flash never ages out, so a re-pose has to retire it or
    // the hero frame's flash sits in every later shot.
    if (vmLink.poseEpoch !== this.poseEpoch) {
      this.poseEpoch = vmLink.poseEpoch;
      this.muzzleLife = 0;
      this.muzzleTotal = 1;
      this.holdFor = 0;
      this.hideFlash();
      for (const t of this.tracers) {
        t.mesh.visible = false;
        t.total = 0;
      }
    }
    const held = this.muzzleTotal > HOLD_THRESHOLD;
    for (const t of this.tracers) {
      if (!t.mesh.visible) continue;
      if (t.total > HOLD_THRESHOLD) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
    if (this.muzzleLife > 0 && !held) {
      this.muzzleLife -= dt;
      if (this.muzzleLife <= 0) {
        this.muzzleLife = 0;
        this.holdFor = 0;
        this.hideFlash();
      } else if (this.muzzleTotal > HOLD_THRESHOLD) {
        this.updateFlash(HOLD_PHASE); // capture hold: freeze on the hero frame
      } else {
        this.updateFlash(1 - this.muzzleLife / this.muzzleTotal);
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
    for (const b of this.billows) {
      if (!b.sprite.visible) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.sprite.visible = false;
        continue;
      }
      const p = 1 - b.life / b.total;
      b.sprite.scale.setScalar(0.16 + p * 0.44);
      b.sprite.material.opacity = Math.sin(Math.min(1, p * 1.4) * Math.PI * 0.85) * 0.5;
      b.sprite.material.rotation = b.spin + p * 0.5;
      b.sprite.position.y += dt * 0.25;
    }
    for (const d of this.decals) {
      if (!d.mesh.visible) continue;
      d.life -= dt;
      if (d.life <= 0) d.mesh.visible = false;
      else if (d.life < 2) (d.mesh.material as THREE.MeshBasicMaterial).opacity = d.life * 0.42;
    }
  }
}

/** Two perpendicular quads along local +Z, unit length, so a tracer never
 *  disappears edge-on. UV v = 0 at the head (+Z). */
function crossQuadGeometry(w: number): THREE.BufferGeometry {
  const h = w / 2;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const quad = (ax: number, ay: number) => {
    const base = pos.length / 3;
    // (-h..h) across, z from +0.5 (head) to -0.5 (tail)
    pos.push(-h * ax, -h * ay, 0.5, h * ax, h * ay, 0.5, h * ax, h * ay, -0.5, -h * ax, -h * ay, -0.5);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad(1, 0);
  quad(0, 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * 7.62x39 case, built on the viewmodel's own sweep primitive so it gets the
 * same analytic normals and vertex-colour channel as the gun.
 *
 * The read at 40-60 screen pixels is entirely SILHOUETTE: a rim step, the
 * extractor groove behind it, the shoulder where the body necks down, and an
 * open mouth. Cycle 2's 8-sided rod with two flat caps had none of those, and
 * its facets were countable. 14 segments, length 0.039 (a real 7.62x39 case),
 * and the head end carries a dark primer disc in the vertex colours rather than
 * a second draw call.
 */
function makeCaseGeometry(): THREE.BufferGeometry {
  const body = sweep(
    circleProfile(0.0056, 14),
    [
      { z: 0, sx: 0.98, sy: 0.98 }, // rim
      { z: 0.0014, sx: 1.0, sy: 1.0 },
      { z: 0.0022, sx: 0.85, sy: 0.85 }, // extractor groove
      { z: 0.0042, sx: 0.86, sy: 0.86 },
      { z: 0.0055, sx: 0.98, sy: 0.98 },
      { z: 0.026, sx: 0.94, sy: 0.94 }, // body taper
      { z: 0.0305, sx: 0.8, sy: 0.8 }, // shoulder
      { z: 0.0335, sx: 0.6, sy: 0.6 }, // neck
      { z: 0.039, sx: 0.585, sy: 0.585 }, // open mouth
    ],
    { uPerM: 26, vPerM: 26, wear: 0.3, caps: [true, false] }
  );
  // Primer: a darker disc standing 0.5 mm proud of the head face. Modelling it
  // as a recess instead needs stations that run BACKWARD in z, and the sweep's
  // cap-orientation probe assumes the neighbouring station lies into the solid,
  // so a reversed run flips the cap's normal and the head renders as a hole.
  const primer = tintGeo(
    sweep(
      circleProfile(0.0024, 12),
      [{ z: -0.0005 }, { z: 0.0002 }],
      { uPerM: 26, vPerM: 26, caps: [true, false] }
    ),
    0.5
  );
  const merged = mergeGeometries([body, primer], false);
  if (!merged) throw new Error('fx: case merge failed');
  body.dispose();
  primer.dispose();
  // Centre it on its own length so the tumble spins about the middle.
  merged.translate(0, 0, -0.0195);
  return merged;
}

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

function makeCoreTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  // The white part is deliberately TINY (out to 12% of the radius) and the
  // gradient falls into amber immediately. Cycle 2 held white out to 22% and
  // cream to 45% of a sprite three times this size, which is how the whole
  // plume measured a 6% warm bias — i.e. white with a hint.
  const g = ctx.createRadialGradient(64, 64, 1, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,252,236,1)');
  g.addColorStop(0.12, 'rgba(255,228,158,0.92)');
  g.addColorStop(0.34, 'rgba(255,168,66,0.55)');
  g.addColorStop(0.66, 'rgba(255,110,26,0.16)');
  g.addColorStop(1, 'rgba(230,80,16,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Round ember falloff for the spark Points. */
function makeSparkTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(32);
  const g = ctx.createRadialGradient(16, 16, 0.5, 16, 16, 15);
  g.addColorStop(0, 'rgba(255,246,220,1)');
  g.addColorStop(0.35, 'rgba(255,180,70,0.7)');
  g.addColorStop(1, 'rgba(255,120,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/**
 * The gas plume seen square to the bore. Deliberately NOT a symmetric star:
 * evenly spaced straight radial spikes are anamorphic LENS FLARE vocabulary,
 * and at 5x they read as hairlines drawn across the receiver. Combustion throws
 * a few irregular teardrops at uneven angles around a hot asymmetric core.
 * Deterministic (no Math.random in an FX asset).
 */
function makePetalTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256);
  ctx.translate(128, 128);
  ctx.globalCompositeOperation = 'lighter';

  // Four lobes at uneven angles, uneven length, each a fat teardrop rather
  // than a ray: half-width at the base is ~55% of its length.
  const lobes: [number, number, number][] = [
    // angle, length, half-width (radians of arc at the root)
    [0.35, 104, 0.62],
    [1.72, 78, 0.78],
    [3.15, 92, 0.55],
    [4.62, 66, 0.85],
  ];
  for (const [a, len, wide] of lobes) {
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, len);
    g.addColorStop(0, 'rgba(255,226,150,0.9)');
    g.addColorStop(0.3, 'rgba(255,164,58,0.6)');
    g.addColorStop(0.72, 'rgba(252,116,26,0.22)');
    g.addColorStop(1, 'rgba(220,80,14,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a - wide) * 26, Math.sin(a - wide) * 26);
    // Two off-centre control points make the lobe lean; a symmetric quad here
    // is what produced the "ray" read.
    ctx.quadraticCurveTo(
      Math.cos(a - wide * 0.35) * len * 0.85,
      Math.sin(a - wide * 0.35) * len * 0.85,
      Math.cos(a + 0.06) * len,
      Math.sin(a + 0.06) * len
    );
    ctx.quadraticCurveTo(
      Math.cos(a + wide * 0.5) * len * 0.7,
      Math.sin(a + wide * 0.5) * len * 0.7,
      Math.cos(a + wide) * 26,
      Math.sin(a + wide) * 26
    );
    ctx.closePath();
    ctx.fill();
  }

  // Hot core, offset a touch so the plume is not radially symmetric. Authored
  // AMBER rather than white: this hub is what was bleaching the whole petal
  // layer to cream before ACES ever saw it.
  const hub = ctx.createRadialGradient(4, -3, 1, 0, 0, 52);
  hub.addColorStop(0, 'rgba(255,244,206,0.95)');
  hub.addColorStop(0.28, 'rgba(255,204,120,0.72)');
  hub.addColorStop(0.62, 'rgba(255,150,58,0.3)');
  hub.addColorStop(1, 'rgba(240,104,24,0)');
  ctx.fillStyle = hub;
  ctx.beginPath();
  ctx.arc(0, 0, 52, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(c);
}

/** Cone skin: v = 0 is the crown, v = 1 the tip. Tongue variation runs around
 *  u and must stay periodic or the cone shows a seam. */
function makeFlareTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  const img = ctx.createImageData(128, 128);
  for (let x = 0; x < 128; x++) {
    const u = x / 128;
    const tongue =
      0.62 +
      0.24 * (0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 5)) +
      0.14 * (0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 11 + 1.7));
    for (let y = 0; y < 128; y++) {
      const v = y / 127;
      const along = Math.max(0, 1 - v / tongue);
      // Taper the crown ring's alpha to nothing over the first 10% of v. The
      // cone's silhouette must be ALPHA-driven; an opaque ring on the end
      // segment draws its own polygon edge, which is exactly what the camera
      // sees when it looks down the bore.
      const a = Math.pow(along, 1.35) * 0.95 * (0.22 + 0.78 * Math.min(1, v / 0.1));
      const hot = Math.pow(along, 5);
      const i = (y * 128 + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 172 + hot * 78;
      img.data[i + 2] = 74 + hot * 150;
      img.data[i + 3] = Math.min(255, a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false; // v must run crown -> downrange, matching the cone
  return tex;
}

/** Soft billow — seeded lobes, deterministic (no Math.random in FX assets). */
function makeSmokeTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  const lobes = 9;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < lobes; i++) {
    const h1 = fract(Math.sin((i + 1) * 12.9898) * 43758.5453);
    const h2 = fract(Math.sin((i + 1) * 78.233) * 12345.6789);
    const h3 = fract(Math.sin((i + 1) * 39.425) * 24634.6345);
    const a = h1 * Math.PI * 2;
    const r = 10 + h2 * 26;
    const x = 64 + Math.cos(a) * r;
    const y = 64 + Math.sin(a) * r;
    const rad = 22 + h3 * 26;
    const g = ctx.createRadialGradient(x, y, 1, x, y, rad);
    g.addColorStop(0, 'rgba(255,255,255,0.30)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.13)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  // Circular falloff so the sprite never shows its square edge.
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(64, 64, 8, 64, 64, 63);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.7, 'rgba(0,0,0,0.85)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function makeTracerTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64);
  const img = ctx.createImageData(64, 64);
  for (let y = 0; y < 64; y++) {
    const v = y / 63; // 0 = head
    const along = Math.pow(1 - v, 0.7);
    for (let x = 0; x < 64; x++) {
      const u = Math.abs((x - 31.5) / 31.5);
      const core = Math.pow(Math.max(0, 1 - u), 3.5);
      const glow = Math.pow(Math.max(0, 1 - u), 1.3) * 0.45;
      const a = (core + glow) * along;
      const i = (y * 64 + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 200 + core * 55;
      img.data[i + 2] = 120 + core * 110;
      img.data[i + 3] = Math.min(255, a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false; // v = 0 must land on the tracer head
  return tex;
}

function makeDecalTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64);
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
