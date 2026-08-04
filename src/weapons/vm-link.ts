import * as THREE from 'three';

// One-way publish channel from the viewmodel to the combat FX.
//
// The viewmodel renders in its OWN projection (a fixed viewmodel FOV, see
// viewmodel.ts) while the muzzle flash is a world-space effect drawn in the
// world camera's projection. Two projections means a point on the gun and the
// same point in the world land on DIFFERENT pixels, so a flash pinned to the
// real muzzle would visibly float off the barrel — worse the wider the gap
// (1.8x in ADS). `flashScale` is tan(worldHalfFov)/tan(vmHalfFov): scaling the
// flash's camera-space x/y by it (and its size, and its along-bore offsets)
// puts it back on the muzzle on screen and keeps it the right size relative to
// the gun.
//
// `dir` carries the real BORE axis. The flash used to be aimed along the camera
// axis, which is 3-4 degrees off in the hip pose and is why the cone was always
// exactly end-on.
//
// A module singleton rather than a constructor argument because main.ts wires
// CombatFX and Viewmodel up independently; defaults make FX correct on its own
// (no viewmodel: scale 1, camera-forward aim).
export const vmLink = {
  /** True once a viewmodel has published a bore axis this session. */
  active: false,
  /** World-space bore direction (downrange). */
  dir: new THREE.Vector3(0, 0, -1),
  /** tan(worldHalfFov) / tan(vmHalfFov) — see above. */
  flashScale: 1,
  /** Bumped when the review harness re-poses the camera in place. Held capture
   *  FX (a flash frozen on its hero frame) must not bleed into the next shot. */
  poseEpoch: 0,
  /**
   * 0..1 muzzle-flash strength, published by CombatFX and read by the viewmodel.
   *
   * The viewmodel carries a FIXED camera-parented key rig (materials.ts) whose
   * whole job is to give the gun form when the world sun is behind the player.
   * A muzzle flash is a second, far brighter key from the opposite direction,
   * and the two used to ADD: the measured result was 2.15% of the weapon clipped
   * to >=250 on the firing frame against 0.00% unfired, in one unbroken band
   * that made no distinction between bluing and walnut. The rig now ducks while
   * the flash is up, so the flash is the key rather than a bonus on top of one.
   */
  flashKey: 0,
};
