import * as THREE from 'three';
import type { System } from '../core/engine';
import type { TextureFactory } from '../gen/texgen';
import type { PlayerController } from '../player/controller';
import type { Weapon } from './weapon';
import { gunMetalRecipe, gunWoodRecipe, gunGloveRecipe, applyViewmodelSurface } from './materials';
import { buildAkm, BORE_Y, MUZZLE_Z } from './vm-akm';
import { buildHands } from './vm-hands';
import { bakeVertexAO } from './vm-ao';
import { vmLink } from './vm-link';

// Procedural AKM viewmodel. Geometry lives in vm-akm.ts / vm-hands.ts /
// vm-geometry.ts and merges into exactly three draw calls (metal, wood, glove).
//
// POSE FRAME: the model is authored in sight-line space — the rear sight notch
// is the origin and y = 0 is the line of sight — so the ADS pose is literally
// (0, 0, -eyeRelief) and the front post lands dead centre of the rear notch on
// the screen centre with no fudge factors.
//
// ---------------------------------------------------------------------------
// THE VIEWMODEL OWNS ITS OWN PROJECTION AND ITS OWN DEPTH RANGE.
//
// Both of those used to be shared with the world camera, and both were doing
// visible damage:
//
//   * Projection. At the world's vfov 74 the near plane sits at 0.08, which is
//     a 16 cm ADS eye relief before the camera starts slicing the buttstock
//     open — four times a real cheek weld — and the sight picture that comes
//     out of that is a 10 px front post inside an unreadable notch. The wide
//     frustum also stretches the stock into a trapezoid, and a world FOV change
//     (ADS zoom) would rescale the weapon, which no shipped shooter does.
//     So the rig renders with its OWN perspective matrix: near 0.01, and a
//     fixed vfov that lerps 60 (hip) -> 45 (ADS) for the magnification step.
//     The swap is done per-frame around the rig's own draws (see `beginPass`),
//     which costs nothing and needs no second render pass — everything else in
//     the frame, post included, sees the untouched world projection.
//
//   * Depth. World foliage grows through the shooter's own weapon: grass right
//     at the camera is physically nearer than the handguard, so it composited
//     over the gun. The rig therefore draws LAST in the frame (transparent
//     queue, renderOrder 5000+) and clears the depth buffer first, so nothing
//     in the world can ever intersect it, and it still self-occludes correctly.
//     The muzzle flash draws before that clear, which is why the front sight
//     and brake now cut real silhouettes into the flash instead of the flash
//     painting over the gun.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ADS IS A SIGHT PICTURE, AND THAT IS AN EYE-RELIEF PROBLEM, NOT A POSE PROBLEM.
//
// Cycle 2 seated the eye 0.12 m behind the rear notch. The AK's receiver runs
// 0.156 m BEHIND that notch, so at 0.12 m of relief the receiver passed clean
// through the camera: everything from z = 0.11 rearward sat inside 10 mm of the
// near plane and blew up to fill the frame. Measured, the weapon spanned 73% of
// frame width and its top edge started 41% down the screen, so the gun ate the
// lower 60% of an aiming view. No amount of re-posing fixes that; the eye has
// to move back.
//
// It is now 0.226 m, which is the number the ADS frame budget solves to. At vm
// vfov 45 one pixel is 7.67e-4 rad, so:
//
//   dust-cover top, 22 mm under the sight line at z = 0.006 -> 0.220 m away
//     -> 0.100 rad -> 130 px below centre -> y = 670 = 0.62 of frame height,
//   receiver half-width 18 mm at the frame edge -> the weapon converges from
//     ~35% of frame width at the bottom to a narrow strip at the sights,
//   and the whole rear sight cluster clears the receiver mass instead of
//     sitting on top of it.
//
// The vm ADS fov (45) is deliberately within a degree of the world camera's ADS
// fov (74 x 0.62 = 45.9 — see controller.ts), so in the aiming view the weapon
// and the world are at the SAME magnification and the sight covers the angular
// slice of target it physically should. The hip pair stays split (vm 60 vs
// world 74) for the usual reason: less perspective stretch on the near end of
// the gun.
// ---------------------------------------------------------------------------

const VM_FOV_HIP = 60;
const VM_FOV_ADS = 45;
const VM_NEAR = 0.01;
const VM_FAR = 24;
const VM_ADS_Z = -0.226;
/** World-camera fov multiplier while aiming; mirrors controller.ts. */
const WORLD_ADS_FOV_SCALE = 0.62;
const RENDER_ORDER = 5000;

const ZERO = new THREE.Vector3(0, 0, 0);
const _q = new THREE.Quaternion();

export class Viewmodel implements System {
  readonly rig = new THREE.Group();      // attached to camera
  private weaponRoot = new THREE.Group();
  private muzzleAnchor = new THREE.Object3D();
  private hipPose = new THREE.Vector3(0.122, -0.096, -0.375);
  private adsPose = new THREE.Vector3(0, 0, VM_ADS_Z);
  // Roll increased to ~6.6 deg: the gun cants toward the camera so the mag
  // well, selector and ejection-port flank come into the hip frame instead of
  // presenting a flat top-down slab.
  private hipRot = new THREE.Vector3(0.018, 0.052, -0.115);
  private poseRot = new THREE.Vector3();
  private kick = 0;
  private reloadAnim = 0;
  private swayX = 0;
  private swayY = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private adsT = 0;
  private sprintT = 0;
  /** Review-harness aim override; null in normal play. */
  private adsOverride: boolean | null = null;

  private vmCam = new THREE.PerspectiveCamera(VM_FOV_HIP, 1, VM_NEAR, VM_FAR);
  private savedProj = new THREE.Matrix4();
  private savedProjInv = new THREE.Matrix4();
  private swapped = false;
  /** World fov the review harness posed with, before any ADS narrowing. */
  private captureBaseFov = 0;
  /** Shared with all three rig materials — see VmSurfaceOpts.keyScale. */
  private keyScale: THREE.IUniform<number> = { value: 1 };

  constructor(
    private camera: THREE.PerspectiveCamera,
    factory: TextureFactory,
    private player: PlayerController,
    private weapon: Weapon
  ) {
    // envMapIntensity stays under 1.5. A first-person weapon is seen almost
    // entirely at grazing incidence — down its own length — and at grazing
    // angles the specular term runs to f90 = 1 regardless of how dark the base
    // is, so a gun lit by a bright sky probe turns into white chrome. Roughness,
    // probe intensity and the roughness-aware horizon term are the brakes.
    const metal = factory.standard(gunMetalRecipe, { envMapIntensity: 0.85 });
    const wood = factory.standard(gunWoodRecipe, { envMapIntensity: 0.6 });
    const glove = factory.standard(gunGloveRecipe, { envMapIntensity: 0.5 });
    // Worn metal edges polish up; worn wood edges only dull the lacquer.
    // rigSpecular is cut hard across the board (metal 0.85 -> 0.22, wood
    // 0.30 -> 0.05, glove 0.12 -> 0.05). The rig's specular lobe was reaching
    // 170x on any bevel the edge-wear term polished, which is what drew a
    // constant-intensity white line down the whole length of barrel and
    // receiver — the stock 0.5 m from the muzzle as blown as the gas block.
    // Fired highlights belong to the muzzle light now.
    applyViewmodelSurface(metal, {
      key: 'metal',
      rimColor: 0x9ab6d4,
      rimStrength: 0.1,
      wearRough: 0.28,
      grazeKnee: 0.22,
      grazeFloor: 0.46,
      rigStrength: 1,
      rigSpecular: 0.22,
      keyScale: this.keyScale,
    });
    applyViewmodelSurface(wood, {
      key: 'wood',
      rimColor: 0xc0a888,
      rimStrength: 0.04,
      // Worn wood DULLS its lacquer; it does not polish up. The negative value
      // here was making rubbed edges glossier than the field.
      wearRough: 0.12,
      grazeKnee: 0.3,
      grazeFloor: 0.55,
      rigStrength: 0.58,
      rigSpecular: 0.05,
      keyScale: this.keyScale,
    });
    applyViewmodelSurface(glove, {
      key: 'glove',
      rimColor: 0x8fa6bf,
      rimStrength: 0.08,
      wearRough: 0.06,
      grazeKnee: 0.34,
      grazeFloor: 0.62,
      rigStrength: 0.62,
      // Dropped so the glove stops picking up the receiver's sheen and reads as
      // fabric next to it.
      rigSpecular: 0.05,
      keyScale: this.keyScale,
    });

    const parts = buildAkm();
    const hands = buildHands();
    // Cavity AO across the weapon AND the hands as one solid. This is the band
    // under the support hand's fingers, in the mag well, along the handguard
    // seam and under the front sight base — the thing that makes assembled
    // parts read as one welded object rather than as parts floating near each
    // other. Static merged geometry, so it is a one-off boot cost with no
    // runtime price at all.
    bakeVertexAO([parts.metal, parts.wood, hands], 0.5);

    const g = this.weaponRoot;
    const meshes: THREE.Mesh[] = [];
    let order = RENDER_ORDER;
    for (const [geo, mat] of [
      [parts.metal, metal],
      [parts.wood, wood],
      [hands, glove],
    ] as [THREE.BufferGeometry, THREE.MeshStandardMaterial][]) {
      // Transparent queue at alpha 1: this is how the rig claims the LAST draws
      // in the frame (three runs the whole transparent list after all opaques),
      // which is what makes the depth clear below safe. The shader forces
      // diffuseColor.a to 1, so the blend is a straight copy.
      mat.transparent = true;
      mat.depthWrite = true;
      mat.depthTest = true;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = order++;
      meshes.push(mesh);
      g.add(mesh);
    }

    // First rig draw of the frame opens the viewmodel pass, last one closes it.
    meshes[0].onBeforeRender = (renderer) => this.beginPass(renderer);
    meshes[meshes.length - 1].onAfterRender = () => this.endPass();

    this.muzzleAnchor.position.set(0, BORE_Y, MUZZLE_Z - 0.002);
    g.add(this.muzzleAnchor);

    this.rig.add(g);
    // Start settled in the pose the player is actually in (shot captures boot
    // straight into ADS and only run a few dozen frames).
    this.adsT = this.wantAds ? 1 : 0;
    g.position.copy(this.wantAds ? this.adsPose : this.hipPose);
    if (!this.wantAds) g.rotation.set(this.hipRot.x, this.hipRot.y, this.hipRot.z);
    this.syncCamera();
    camera.add(this.rig);
    this.hookReviewPoses();
  }

  /**
   * Review capture only. tools/capture.mjs boots the world ONCE and then
   * re-poses the camera in place for every later shot, so the ADS pose the
   * review is meant to judge was being rendered with whatever aim state the
   * FIRST shot happened to boot with. Wrapping the harness's own re-pose hook
   * keeps that honest — and bumps the epoch that expires held capture FX.
   */
  private hookReviewPoses(): void {
    const w = window as unknown as Record<string, unknown>;
    const prev = w.__APPLY_POSE__;
    if (typeof prev !== 'function') return;
    // The FIRST pose is applied by main.ts before this rig exists, so seed the
    // capture state from it too.
    this.adsOverride = this.player.ads;
    this.captureBaseFov = this.camera.fov;
    this.applyCaptureFov();
    w.__APPLY_POSE__ = (name: string): boolean => {
      const ok = (prev as (n: string) => boolean)(name);
      if (ok) {
        this.adsOverride = name === 'weapon-ads';
        this.adsT = this.adsOverride ? 1 : 0;
        // applyPose has just reset the world fov to the pose's own value.
        this.captureBaseFov = this.camera.fov;
        this.applyCaptureFov();
        vmLink.poseEpoch++;
      }
      return ok;
    };
  }

  /**
   * Review capture only, and it is a fidelity fix rather than a dressing-up.
   *
   * In play PlayerController narrows the world camera to 0.62x while aiming
   * (controller.ts), which is the entire optical payoff of pressing the button.
   * The shot harness runs a stub player object instead of the controller, so
   * nothing ever narrowed it and weapon-hip and weapon-ads came out of the
   * capture at an identical world fov of 74 — the farmhouse, the haystack and
   * the power pole landing on the same pixels in both, so the review saw ADS as
   * a slab of weapon sliding up over an unchanged world. This applies the same
   * scale the controller would have, only for capture poses.
   */
  private applyCaptureFov(): void {
    if (this.adsOverride === null || this.captureBaseFov <= 0) return;
    const want = this.captureBaseFov * (this.adsOverride ? WORLD_ADS_FOV_SCALE : 1);
    if (Math.abs(this.camera.fov - want) > 0.01) {
      this.camera.fov = want;
      this.camera.updateProjectionMatrix();
    }
  }

  private get wantAds(): boolean {
    return this.adsOverride ?? this.player.ads;
  }

  /** World-space muzzle position for FX. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzleAnchor.getWorldPosition(out);
  }

  /** World-space bore axis (downrange) — the flash is aimed along this. */
  muzzleDir(out: THREE.Vector3): THREE.Vector3 {
    this.muzzleAnchor.updateWorldMatrix(true, false);
    return out.set(0, 0, -1).applyQuaternion(this.muzzleAnchor.getWorldQuaternion(_q)).normalize();
  }

  triggerKick(): void {
    this.kick = 1;
  }

  triggerReload(): void {
    this.reloadAnim = 1;
  }

  /** Swap the world projection for the viewmodel's, and give the rig a clean
   *  depth buffer. Runs inside the render, immediately before the first rig
   *  draw. */
  private beginPass(renderer: THREE.WebGLRenderer): void {
    if (this.swapped) return;
    this.savedProj.copy(this.camera.projectionMatrix);
    this.savedProjInv.copy(this.camera.projectionMatrixInverse);
    this.camera.projectionMatrix.copy(this.vmCam.projectionMatrix);
    this.camera.projectionMatrixInverse.copy(this.vmCam.projectionMatrixInverse);
    this.swapped = true;
    // renderer.clear() re-enables the depth mask itself, so this survives being
    // called straight after a depthWrite:false sprite (the muzzle flash).
    renderer.clearDepth();
  }

  private endPass(): void {
    if (!this.swapped) return;
    this.camera.projectionMatrix.copy(this.savedProj);
    this.camera.projectionMatrixInverse.copy(this.savedProjInv);
    this.swapped = false;
  }

  update(dt: number): void {
    // Paranoia: if a rig mesh were ever skipped mid-frame the world would be
    // left rendering through the weapon's projection. Cheap to make impossible.
    this.endPass();
    this.applyCaptureFov();
    // The fixed key rig ducks to ~0.35 while the muzzle flash's own light is
    // up, so the flash IS the key on the firing frame rather than a second one
    // stacked on top of it (see vmLink.flashKey).
    this.keyScale.value = 1 - vmLink.flashKey * 0.65;

    const g = this.weaponRoot;
    const k1 = Math.min(1, dt * 12);
    const aim = this.wantAds;

    this.adsT += ((aim ? 1 : 0) - this.adsT) * k1;
    const ads = this.adsT;

    // Pose blend hip<->ADS (position and rotation together: the hip pose is
    // canted and yawed toward the crosshair, ADS is square to the sight line).
    g.position.lerp(aim ? this.adsPose : this.hipPose, k1);
    this.poseRot.lerp(aim ? ZERO : this.hipRot, k1);
    g.rotation.set(this.poseRot.x, this.poseRot.y, this.poseRot.z);

    // Look sway: lag behind camera rotation
    const dYaw = this.player.yaw - this.lastYaw;
    const dPitch = this.player.pitch - this.lastPitch;
    this.lastYaw = this.player.yaw;
    this.lastPitch = this.player.pitch;
    const swayScale = 1 - ads * 0.68;
    this.swayX = THREE.MathUtils.clamp(this.swayX + dYaw * 1.6, -0.03, 0.03) * (1 - Math.min(1, dt * 8));
    this.swayY = THREE.MathUtils.clamp(this.swayY + dPitch * 1.6, -0.03, 0.03) * (1 - Math.min(1, dt * 8));
    g.position.x += this.swayX * swayScale;
    g.position.y += this.swayY * swayScale;

    // Movement bob
    const speedRatio = Math.min(this.player.speed2D / 6.4, 1);
    const t = performance.now() / 1000;
    if (speedRatio > 0.05) {
      const bobAmp = (0.008 - ads * 0.006) * speedRatio;
      g.position.x += Math.cos(t * 7.5) * bobAmp;
      g.position.y += Math.abs(Math.sin(t * 7.5)) * bobAmp * 1.2;
      g.rotation.z += Math.sin(t * 7.5) * bobAmp * 1.6;
    }

    // Sprint: weapon drops and swings across, smoothed on its own blend
    this.sprintT += ((this.player.isSprinting ? 1 : 0) - this.sprintT) * Math.min(1, dt * 8);
    if (this.sprintT > 0.001) {
      const s = this.sprintT;
      g.position.y -= s * 0.055;
      g.position.z -= s * 0.02;
      g.rotation.x += s * 0.42;
      g.rotation.y += s * 0.36;
      g.rotation.z -= s * 0.18;
    }

    // Fire kick spring — mostly rotation in ADS so the sight picture jumps
    // without the weapon walking out of the frame.
    if (this.kick > 0) {
      this.kick = Math.max(0, this.kick - dt * 9);
      const k = this.kick;
      g.position.z += k * 0.035 * (1 - ads * 0.72);
      g.position.y += k * 0.006;
      g.rotation.x += k * 0.055;
      g.rotation.z += k * 0.02 * (1 - ads);
    }

    // Reload dip + tilt
    if (this.reloadAnim > 0) {
      this.reloadAnim = Math.max(0, this.reloadAnim - dt / 2.9);
      const phase = 1 - this.reloadAnim; // 0..1
      const dip = Math.sin(Math.min(phase * 1.6, 1) * Math.PI);
      g.position.y -= dip * 0.09;
      g.position.z -= dip * 0.05;
      g.rotation.z += dip * 0.5;
      g.rotation.x += dip * 0.25;
    }

    this.syncCamera();
    vmLink.active = true;
    this.muzzleDir(vmLink.dir);
  }

  /** Keeps the viewmodel projection matched to the world camera's aspect and to
   *  the current ADS blend, and publishes the flash-alignment factor. */
  private syncCamera(): void {
    const fov = VM_FOV_HIP + (VM_FOV_ADS - VM_FOV_HIP) * this.adsT;
    if (this.vmCam.fov !== fov || this.vmCam.aspect !== this.camera.aspect) {
      this.vmCam.fov = fov;
      this.vmCam.aspect = this.camera.aspect;
      this.vmCam.updateProjectionMatrix();
    }
    vmLink.flashScale =
      Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5) /
      Math.tan(THREE.MathUtils.degToRad(fov) * 0.5);
  }
}
