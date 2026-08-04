import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sweep, roundedRect, tintGeo } from './vm-geometry';
import type { Station, SweepOpts } from './vm-geometry';

// Gloved hands, built in the same SIGHT-LINE SPACE as vm-akm.ts and merged into
// ONE extra draw call. They are parented to the weapon root, not to the camera,
// so every pose, sway, bob, sprint and recoil transform carries them for free —
// which is the whole reason a rifle held in hands reads as held rather than as
// a mesh bolted to the near plane.
//
// Anatomy is blocked out, not articulated: a palm slab, four separately swept
// fingers that curl over the part they grip, a thumb and a forearm that runs
// off the bottom of the frame instead of ending in a cut stump. At the screen
// size a viewmodel hand actually occupies (~12% of frame height for the support
// hand) finger SEPARATION and the curl silhouette carry the entire read;
// knuckles and nails do not.
//
// Local build frame for one hand:
//   +Z = knuckles -> fingertips        +X = index -> pinky (the finger row)
//   +Y = back of the hand (knuckle side)
// `orient` then drops that frame anywhere on the gun with a basis matrix.

// 10 repeats/m put the glove weave at ~2 SCREEN PIXELS on a support hand 25 cm
// from the eye — a moiring checkerboard that read as a UV-debug texture. The
// bake's own weave frequency came down with it (materials.ts).
const GLOVE: Partial<SweepOpts> = { uPerM: 4, vPerM: 4, wear: 0.1 };

function orient(
  geo: THREE.BufferGeometry,
  ex: THREE.Vector3,
  ey: THREE.Vector3,
  ez: THREE.Vector3,
  px: number,
  py: number,
  pz: number
): THREE.BufferGeometry {
  const m = new THREE.Matrix4().makeBasis(ex, ey, ez);
  m.setPosition(px, py, pz);
  geo.applyMatrix4(m);
  return geo;
}

export interface HandOpts {
  /** Finger ARC LENGTH, knuckle to tip (0.076 = relaxed support grip). */
  reach: number;
  /**
   * Radius of the circle the finger centreline follows. This is the whole grip
   * model: put the circle's centre on the axis of the part being held and set
   * the radius to (part radius + finger half-thickness), and the fingers close
   * around it by construction. Wrap angle falls out as reach / wrapR.
   */
  wrapR: number;
  /** Row pitch between fingers. */
  pitch?: number;
  /** Forearm axis in the LOCAL hand frame (wrist -> elbow), unit-ish. */
  arm: [number, number, number];
  /** Forearm length; it is meant to leave the frame, not reach an elbow. */
  armLen: number;
  /** Local-frame thumb. The support hand gets a bespoke one in world space
   *  instead, because its thumb has to lie ALONG the gun and every sweep in
   *  that hand's local frame runs ACROSS it. */
  thumb?: boolean;
}

/** One blocked-out gloved hand in its local frame. */
function hand(o: HandOpts): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const pitch = o.pitch ?? 0.0186;

  // --- four fingers, index longest, pinky shortest and set slightly back ---
  //
  // THE STATION LIST NOW CURLS BACK UP. Cycle 2's ran oy 0 -> -curl
  // monotonically, so every finger descended PAST the part it was supposed to
  // be holding and kept going: the silhouette was four hooks laid over the
  // handguard with clear daylight under the fingertips, and the whole read of
  // a rifle being held died there. The last two stations now come back up to
  // -curl*0.82 and tuck in, which closes the hand around the part.
  //
  // Each finger also carries a mid-length KNUCKLE bulge (sy 1.06 at the second
  // joint). Cycle 2 relied on a flat 7% vertex tint for the knuckle line, and
  // 7% of value at this screen size is invisible; a 6 mm silhouette break is
  // not.
  const lenScale = [1.0, 1.04, 0.98, 0.86];
  const backSet = [0.0, -0.002, -0.004, -0.01];
  const taper = [1.0, 1.06, 1.0, 0.95, 0.88, 0.8, 0.68];
  const thick = [1.0, 1.07, 0.99, 0.93, 0.86, 0.76, 0.62];
  for (let i = 0; i < 4; i++) {
    const L = o.reach * lenScale[i];
    const R = o.wrapR;
    const wrap = L / R;
    const x = (i - 1.5) * pitch;
    const st: Station[] = [];
    for (let k = 0; k < taper.length; k++) {
      const th = wrap * (k / (taper.length - 1));
      st.push({
        z: backSet[i] + R * Math.sin(th),
        ox: x,
        oy: -R * (1 - Math.cos(th)),
        sx: taper[k],
        sy: thick[k],
      });
    }
    parts.push(sweep(roundedRect(0.0158, 0.0192, 0.0064, 2), st, GLOVE));
  }

  // --- palm / back of hand, with a WRIST BRIDGE running back into the sleeve --
  // The sleeve's start cap used to sit in open silhouette at the wrist as a
  // flat-capped grey tube with a visible cross-section and a black seam. The
  // palm now runs 18 mm further back than the sleeve's cap plane, so there is
  // solid geometry either side of the joint and no open cylinder anywhere.
  parts.push(
    sweep(
      roundedRect(0.0742, 0.0322, 0.012, 2),
      // The rear end TAPERS TO A NUB and stops at the wrist. Run out flat to
      // -0.098 (which is what a "long palm bridge" looked like on paper) and
      // the slab's end cap hangs 4 cm past where the forearm drops away,
      // presenting a 67 px flat ellipse in open air — the exact "flat-capped
      // grey tube with an open cross-section" the review called out, just moved
      // 4 cm left.
      [
        { z: -0.078, sx: 0.32, sy: 0.6, oy: -0.013 },
        { z: -0.068, sx: 0.6, sy: 1.04, oy: -0.012 },
        { z: -0.052, sx: 0.86, sy: 1.06, oy: -0.008 },
        { z: -0.028, sx: 1.0, sy: 1.0, oy: -0.003 },
        { z: 0.004, sx: 0.99, sy: 0.96, oy: 0 },
      ],
      GLOVE
    )
  );
  // Cuff ring: a raised band at the sleeve/palm joint. Without it the wrist is
  // a diameter change with nothing to read it against.
  parts.push(
    tintGeo(
      sweep(
        roundedRect(0.0742, 0.0322, 0.012, 2),
        [
          { z: -0.074, sx: 0.62, sy: 1.08, oy: -0.013 },
          { z: -0.065, sx: 0.7, sy: 1.16, oy: -0.012 },
          { z: -0.056, sx: 0.64, sy: 1.08, oy: -0.012 },
        ],
        { ...GLOVE, wear: 0.22 }
      ),
      0.86
    )
  );

  // --- thumb: off the index side, laid along the gripped part ---
  if (o.thumb !== false) {
    parts.push(
      sweep(
        roundedRect(0.0198, 0.0216, 0.0084, 2),
        [
          { z: -0.03, ox: -0.03, oy: -0.02, sx: 0.9, sy: 0.9 },
          { z: 0.004, ox: -0.036, oy: -0.024, sx: 1.0, sy: 1.0 },
          { z: 0.03, ox: -0.041, oy: -0.03, sx: 0.94, sy: 0.9 },
          { z: 0.048, ox: -0.044, oy: -0.038, sx: 0.78, sy: 0.74 },
        ],
        GLOVE
      )
    );
  }

  // --- forearm: sleeve, swept along its own axis from the wrist ---
  const a = new THREE.Vector3(o.arm[0], o.arm[1], o.arm[2]).normalize();
  const up = Math.abs(a.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const ax = new THREE.Vector3().crossVectors(up, a).normalize();
  const ay = new THREE.Vector3().crossVectors(a, ax).normalize();
  // The start cap has to end up INSIDE the palm slab, and "inside" is not the
  // same as "further back": the forearm axis points almost straight down, so
  // extending backward along it lifts the cap out through the top of the hand,
  // which is exactly how cycle 2 left a flat-capped grey tube with an open
  // cross-section sitting in silhouette at the wrist. The start station is
  // therefore only 12 mm back and heavily under-sized (35 x 26 mm against the
  // palm's 67 x 35 at that station), and the placement is dropped so the cap
  // plane sits wholly within the palm's section.
  const arm = sweep(
    roundedRect(0.07, 0.06, 0.022, 3),
    [
      { z: -0.012, sx: 0.5, sy: 0.44 },
      { z: 0.006, sx: 0.72, sy: 0.66 },
      { z: o.armLen * 0.22, sx: 0.86, sy: 0.82, oy: -0.004 },
      { z: o.armLen * 0.6, sx: 1.0, sy: 0.97, oy: -0.01 },
      { z: o.armLen, sx: 1.06, sy: 1.02, oy: -0.014 },
    ],
    { ...GLOVE, wear: 0.06, caps: [true, false] }
  );
  parts.push(tintGeo(orient(arm, ax, ay, a, 0, -0.016, -0.064), 0.86));

  return parts;
}

/**
 * Both hands on the AKM: support hand wrapped over the lower handguard, firing
 * hand on the pistol grip. Returns one merged geometry (one draw call).
 */
export function buildHands(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // ---- support hand: comes from the left, fingers close over the handguard --
  // Local +Z -> world +X (across the gun), local +X -> world -Z (the finger row
  // spreads DOWN the handguard), local +Y stays up.
  //
  // PLACEMENT IS DERIVED, NOT DIALLED. The lower handguard's axis is at
  // (x 0, y -0.077) and its half-section is 25 x 21 mm; a finger is 19.2 mm
  // thick, so a wrap radius of 34 mm puts the finger's INNER surface ~0.6 mm
  // inside the wood at the sides — real contact, not the 4 mm of daylight
  // cycle 2 left under the fingertips — and the knuckle row lands at
  // y = -0.077 + 0.034 = -0.043.
  const sup = hand({
    reach: 0.076,
    wrapR: 0.034,
    // Negative pitch puts the index finger DOWNRANGE, where a support hand's
    // longest finger belongs.
    pitch: -0.0186,
    // Local-frame axis that comes out as world (-0.05, -0.98, 0.16): the
    // forearm drops almost straight down out of the bottom of the frame rather
    // than lying across it. A support arm laid diagonally across the lower half
    // of a first-person frame reads as a beam, not an arm.
    arm: [-0.16, -0.98, -0.05],
    armLen: 0.17,
    thumb: false,
  });
  const ex = new THREE.Vector3(0, 0, -1);
  const ey = new THREE.Vector3(0, 1, 0);
  const ez = new THREE.Vector3(1, 0, 0);
  for (const g of sup) parts.push(orient(g, ex, ey, ez, 0, -0.043, -0.235));

  // Support thumb, authored straight in world space: it lies ALONG the
  // handguard's left face (the sweep axis is the gun axis) and its 20 mm
  // section overlaps the wood by ~5 mm, so the AO bake lays a contact band
  // under it.
  parts.push(
    sweep(
      roundedRect(0.0206, 0.0224, 0.0086, 2),
      [
        { z: -0.288, ox: -0.0335, oy: -0.074, sx: 0.7, sy: 0.68 },
        { z: -0.272, ox: -0.0325, oy: -0.067, sx: 0.92, sy: 0.9 },
        { z: -0.25, ox: -0.0308, oy: -0.057, sx: 1.0, sy: 1.0 },
        { z: -0.23, ox: -0.03, oy: -0.048, sx: 0.98, sy: 0.96 },
      ],
      GLOVE
    )
  );

  // ---- firing hand: right side of the pistol grip, fingers round the front --
  // Finger row runs DOWN the grip (index at the trigger), fingers wrap forward
  // and left around it. fx is NEGATED from cycle 2 (and the row pitch with it,
  // so the finger order is unchanged): the old basis put the curl axis on +x,
  // so the firing fingers curled AWAY from the grip into open air.
  const fire = hand({
    reach: 0.058,
    wrapR: 0.03,
    pitch: -0.0172,
    // Comes out as world (0.30, -0.45, 0.84) — back and down to the shooter's
    // right shoulder, off the bottom of the frame.
    arm: [-0.651, -0.269, -0.762],
    armLen: 0.2,
  });
  const fx = new THREE.Vector3(0, 0.966, -0.257);
  const fz = new THREE.Vector3(-0.694, -0.101, -0.713);
  const fy = new THREE.Vector3().crossVectors(fz, fx).normalize();
  for (const g of fire) parts.push(orient(g, fx, fy, fz, 0.026, -0.128, 0.055));

  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('viewmodel: hand merge failed');
  for (const p of parts) p.dispose();
  return merged;
}
