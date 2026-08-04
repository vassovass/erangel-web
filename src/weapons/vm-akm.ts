import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sweep, roundedRect, circleProfile, archProfile, place, adopt, tintGeo } from './vm-geometry';
import type { Pt, Station, SweepOpts } from './vm-geometry';

// AKM built to real proportions in SIGHT-LINE SPACE:
//
//   origin  = the rear sight notch
//   y = 0   = the line of sight (so the ADS pose is simply x=0, y=0)
//   -Z      = downrange, +Z = the shooter
//   bore    = 52 mm below the sight line, sight radius 413 mm
//
// The rear half is compressed the way every FPS viewmodel compresses it (the
// receiver rides forward under the sight) and the buttstock carries a strong
// AKM drop — that drop is load-bearing, not decoration: in ADS the stock has to
// be below the frustum edge (y < -0.060 at |z| = 0.08) before it reaches the
// 0.08 near plane, or the camera slices it open. See VM_ADS_Z in viewmodel.ts.

export const BORE_Y = -0.052;
export const MUZZLE_Z = -0.487;
export const FRONT_SIGHT_Z = -0.413;
/** Rear-most point of the model — the near-plane budget in viewmodel.ts uses it. */
export const STOCK_REAR_Z = 0.31;

const METAL_U = 5;
const METAL_V = 5;
// Wood tile density. At 3 repeats/m the 0.19 m handguard covered 0.57 of a
// tile, so the laminate's low-frequency layer band never completed a cycle
// along the part and the whole thing read as one flat orange gradient. At 8 it
// runs 1.5 tiles long and ~2 around, which puts 8 visible layers across the
// face — what the reference handguard shows.
const WOOD_U = 8;
const WOOD_V = 12;

const metalOpts = { uPerM: METAL_U, vPerM: METAL_V, wear: 0.21 };
const woodOpts = { uPerM: WOOD_U, vPerM: WOOD_V, wear: 0.13 };

/** Cylinder along +Z (bore, pins, rivets). Anything over ~8 mm radius is a
 *  silhouette the player counts facets on, so it gets 20 segments; 4 mm pins
 *  and rivets stay cheap. */
function tube(r: number, z0: number, z1: number, seg = r > 0.008 ? 20 : 10, opts: Partial<SweepOpts> = {}): THREE.BufferGeometry {
  return sweep(circleProfile(r, seg), [{ z: z0 }, { z: z1 }], { ...metalOpts, ...opts });
}

/** Bevelled box along +Z. */
function bar(
  w: number,
  h: number,
  z0: number,
  z1: number,
  x: number,
  y: number,
  opts: Partial<SweepOpts> = {}
): THREE.BufferGeometry {
  const r = Math.min(w, h) * 0.28;
  return sweep(
    roundedRect(w, h, r, 2),
    [
      { z: z0, ox: x, oy: y },
      { z: z1, ox: x, oy: y },
    ],
    { ...metalOpts, ...opts }
  );
}

function magProfileStations(): Station[] {
  return [
    { z: 0.0, sx: 1.0, sy: 1.0, oy: 0.0 },
    { z: 0.04, sx: 0.995, sy: 0.995, oy: -0.004 },
    { z: 0.082, sx: 0.978, sy: 0.985, oy: -0.014 },
    { z: 0.122, sx: 0.958, sy: 0.972, oy: -0.03 },
    { z: 0.158, sx: 0.938, sy: 0.96, oy: -0.046 },
    { z: 0.186, sx: 0.922, sy: 0.95, oy: -0.06 },
  ];
}

export interface AkmParts {
  metal: THREE.BufferGeometry;
  wood: THREE.BufferGeometry;
}

export function buildAkm(): AkmParts {
  const metal: THREE.BufferGeometry[] = [];
  const wood: THREE.BufferGeometry[] = [];

  // ---------------------------------------------------------------- receiver
  metal.push(
    sweep(
      roundedRect(0.036, 0.062, 0.005, 3),
      [
        { z: -0.104, sx: 1.03, sy: 0.98, oy: -0.067 },
        { z: -0.082, sx: 1.0, oy: -0.067 },
        { z: -0.02, oy: -0.067 },
        { z: 0.07, oy: -0.067 },
        { z: 0.128, sx: 0.99, sy: 0.99, oy: -0.068 },
        { z: 0.156, sx: 0.94, sy: 0.9, oy: -0.071 },
      ],
      metalOpts
    )
  );

  // Ribbed AKM dust cover: arched shell + two lengthwise stiffening ribs.
  metal.push(
    sweep(
      archProfile(0.04, 0.022, 0.014, 7),
      [
        { z: 0.006, sx: 1.0, oy: -0.044 },
        { z: 0.06, oy: -0.044 },
        { z: 0.12, oy: -0.044 },
        { z: 0.152, sx: 0.95, sy: 0.94, oy: -0.045 },
      ],
      { ...metalOpts, caps: [false, true] }
    )
  );
  for (const sx of [-1, 1]) {
    metal.push(
      sweep(
        roundedRect(0.0055, 0.004, 0.0018, 1),
        [
          { z: 0.012, ox: sx * 0.0108, oy: -0.0253 },
          { z: 0.148, ox: sx * 0.0102, oy: -0.0262 },
        ],
        { ...metalOpts, wear: 0.34 }
      )
    );
  }

  // -------------------------------------------------------------- rear sight
  //
  // A REAL U-NOTCH, CUT AND SQUARE. Cycle 2 built the notch as two separately
  // swept bars with a roundedRect corner radius of 28% of their own thickness,
  // and at 2 corner segments that is not a machined part, it is a pebble: the
  // measured result was two soft mushroom-cap blobs with no visible cut between
  // them, giving the eye nothing to align the front post against. Everything
  // here is authored to the ADS sight-picture budget (VM_ADS_Z = -0.226, vm
  // vfov 45, so 1 px = 7.67e-4 rad):
  //
  //   notch gap  4.6 mm @ 232 mm  -> 26 px of daylight
  //   notch wall 3.4 mm           -> 19 px each side, hard square corners
  //   notch depth 4.3 mm          -> 24 px, flat floor
  //   wall tops sit ON the sight line (y = 0), so the front post's tip — also
  //   on the sight line — reads level with them. That IS the sight picture.
  //
  // Value runs the reference's way round and not cycle 2's: the leaf and walls
  // are tinted DOWN to a near-black frame so the bright front post is the one
  // thing in the cluster the eye lands on. Cycle 2 had post and ears inside a
  // 12-luma band of mid grey, with the post LIGHTER than the treeline behind it.
  const NOTCH_FLOOR = -0.0043;
  const notchProfile = roundedRect(0.021, 0.0147, 0.0008, 1);
  metal.push(
    tintGeo(
      sweep(
        notchProfile,
        [
          { z: -0.05, sx: 0.86, sy: 0.9, oy: -0.0135 },
          { z: -0.03, sx: 1.0, sy: 1.0, oy: -0.01165 },
          { z: 0.004, sx: 1.0, sy: 0.94, oy: -0.0125 },
          { z: 0.024, sx: 0.92, sy: 0.42, oy: -0.028 },
        ],
        { ...metalOpts, wear: 0.16 }
      ),
      0.11
    )
  );
  // Square notch walls: r = 0.4 mm at 1 corner segment is a rectangle with a
  // break, not a rounded blob, and it silhouettes as machined steel.
  for (const sx of [-1, 1]) {
    metal.push(
      tintGeo(
        sweep(
          roundedRect(0.0034, 0.0043, 0.0004, 1),
          [
            { z: -0.021, ox: sx * 0.004, oy: NOTCH_FLOOR / 2 },
            { z: -0.002, ox: sx * 0.004, oy: NOTCH_FLOOR / 2 },
          ],
          { ...metalOpts, wear: 0.14 }
        ),
        0.11
      )
    );
  }

  // ---------------------------------------------------------------- barrel
  metal.push(tube(0.0106, -0.44, -0.098, 20, { caps: false }));
  // Barrel nut. Its forward face used to be a flat 33 mm triangle fan with a
  // radial UV swirl sitting unoccluded in mid-silhouette between the handguard
  // and the receiver; it now tapers down onto the barrel so the only cap left
  // is a ring at barrel radius, buried inside the barrel itself.
  metal.push(
    sweep(
      circleProfile(0.0165, 20),
      [
        { z: -0.134, sx: 0.64 },
        { z: -0.128, sx: 0.95 },
        { z: -0.108, sx: 1.0 },
        { z: -0.1, sx: 0.72 },
      ],
      { ...metalOpts, caps: [false, false] }
    ).translate(0, BORE_Y, 0)
  );
  metal.push(place(tube(0.0092, -0.325, -0.12, 20, { caps: [true, false] }), { y: -0.02 }));

  // Gas block with the classic angled front face.
  metal.push(
    sweep(
      roundedRect(0.026, 0.052, 0.005, 2),
      [
        { z: -0.348, sx: 0.8, sy: 0.72, oy: -0.04 },
        { z: -0.338, sx: 1.0, sy: 1.0, oy: -0.038 },
        { z: -0.318, sx: 1.0, sy: 1.0, oy: -0.038 },
        { z: -0.31, sx: 0.86, sy: 0.9, oy: -0.038 },
      ],
      metalOpts
    )
  );

  // Front sight block. Dropped 6 mm from cycle 2: its old top edge projected
  // 7 px ABOVE the rear notch floor in the ADS pose, so the block itself
  // intruded into the sight picture it is supposed to sit under.
  metal.push(
    sweep(
      roundedRect(0.024, 0.044, 0.005, 2),
      [
        { z: -0.43, sx: 0.86, sy: 0.9, oy: -0.037 },
        { z: -0.422, sx: 1.0, sy: 1.0, oy: -0.036 },
        { z: -0.404, sx: 1.0, sy: 1.0, oy: -0.036 },
        { z: -0.396, sx: 0.86, sy: 0.9, oy: -0.037 },
      ],
      metalOpts
    )
  );
  // Protective ears: NARROW (3.0 mm, was 5.2) and DARK (0.17, was tinted up to
  // 1.25). Cycle 2 sat them at nearly the same value as the post and three
  // times its width, which inverted the contrast hierarchy — the eye read the
  // ears as the aiming reference and the post as a gap between them. They now
  // frame the post at 6 px against its 12, and top out 1.5 mm proud of the
  // sight line so they still bracket the tip.
  for (const sx of [-1, 1]) {
    metal.push(
      tintGeo(
        sweep(
          roundedRect(0.003, 0.026, 0.0006, 1),
          [
            { z: -0.428, ox: sx * 0.0104, oy: -0.0115 },
            { z: -0.398, ox: sx * 0.0104, oy: -0.0115 },
          ],
          { ...metalOpts, wear: 0.18 }
        ),
        0.11
      )
    );
  }
  // Front post: the one part of the gun the eye is actually looking at. 5.6 mm
  // wide = 12 px in the ADS picture, inside a 26 px notch. Split into a shank
  // and a BEAD: the top 7 mm is tinted to 2.2 so the tip holds a hard bright
  // edge against a treeline, which is the background of essentially every
  // Erangel engagement and the one cycle 2 vanished into.
  metal.push(
    place(sweep(roundedRect(0.0056, 0.0052, 0.0016, 2), [{ z: 0 }, { z: 0.026 }], { ...metalOpts, wear: 0.19 }), {
      rx: -Math.PI / 2,
      y: -0.032,
      z: FRONT_SIGHT_Z,
    })
  );
  metal.push(
    tintGeo(
      place(sweep(roundedRect(0.0056, 0.0052, 0.0016, 2), [{ z: 0 }, { z: 0.0072 }], { ...metalOpts, wear: 0.3 }), {
        rx: -Math.PI / 2,
        y: -0.0072,
        z: FRONT_SIGHT_Z,
      }),
      5.0
    )
  );

  // AKM slant brake with a REAL BORE. Cycle 2 capped the muzzle with a flat
  // triangle fan and laid a dark disc on top of it, so the weapon appeared to
  // fire out of a solid rod. The sweep now folds back on itself at the crown —
  // two stations share z = MUZZLE_Z at different radii, which is what makes the
  // annular crown face, and the next pair chamfer inward and run 18 mm DOWN the
  // bore. The wall normals there come out pointing at the axis, so what the
  // camera sees through the crown is the inside of a hole, not a decal.
  metal.push(
    sweep(
      circleProfile(0.0149, 20),
      [
        { z: MUZZLE_Z + 0.018, sx: 0.483, sy: 0.483, shear: 0.55, oy: BORE_Y },
        { z: MUZZLE_Z + 0.0014, sx: 0.483, sy: 0.483, shear: 0.55, oy: BORE_Y },
        { z: MUZZLE_Z, sx: 0.577, sy: 0.577, shear: 0.55, oy: BORE_Y },
        { z: MUZZLE_Z, sx: 1.0, sy: 1.0, shear: 0.55, oy: BORE_Y },
        { z: -0.462, shear: 0.28, oy: BORE_Y },
        { z: -0.446, oy: BORE_Y },
        { z: -0.436, sx: 0.86, sy: 0.86, oy: BORE_Y },
      ],
      { ...metalOpts, shearPivot: BORE_Y, wear: 0.3, caps: [true, false] }
    )
  );
  // Bore floor: the dark disc lives 18 mm INSIDE the muzzle now, so it is only
  // ever seen down the hole.
  metal.push(
    tintGeo(
      sweep(
        circleProfile(0.0071, 14),
        [
          { z: MUZZLE_Z + 0.0175, shear: 0.55, oy: BORE_Y },
          { z: MUZZLE_Z + 0.0215, shear: 0.55, oy: BORE_Y },
        ],
        { ...metalOpts, shearPivot: BORE_Y, caps: [true, false] }
      ),
      0.05
    )
  );

  // ---------------------------------------------------------------- magazine
  const magSt = magProfileStations();
  const magGeo = sweep(roundedRect(0.0268, 0.062, 0.006, 2), magSt, {
    ...metalOpts,
    uPerM: 4,
    wear: 0.19,
  });
  metal.push(place(magGeo, { rx: Math.PI / 2, y: -0.088, z: -0.044 }));
  for (const side of [-1, 1]) {
    const ribSt: Station[] = magSt.map((s) => ({
      z: s.z,
      ox: side * 0.0132 * (s.sx ?? 1),
      oy: s.oy,
      sy: s.sy,
    }));
    metal.push(
      place(sweep(roundedRect(0.0035, 0.042, 0.0012, 1), ribSt, { ...metalOpts, uPerM: 4, wear: 0.34 }), {
        rx: Math.PI / 2,
        y: -0.088,
        z: -0.044,
      })
    );
  }
  // magwell lip + catch
  metal.push(bar(0.034, 0.016, -0.072, -0.014, 0, -0.094, { wear: 0.27 }));
  metal.push(bar(0.02, 0.018, -0.012, 0.006, 0, -0.1, { wear: 0.23 }));

  // ------------------------------------------------- trigger group / controls
  metal.push(bar(0.026, 0.008, 0.028, 0.104, 0, -0.126, { wear: 0.3 })); // guard bottom
  metal.push(bar(0.008, 0.03, 0.028, 0.038, 0, -0.111, { wear: 0.23 }));
  metal.push(bar(0.009, 0.028, 0.096, 0.104, 0, -0.112, { wear: 0.23 }));
  metal.push(tintGeo(bar(0.006, 0.022, 0.05, 0.058, 0, -0.11, { wear: 0.15 }), 0.55)); // trigger
  // EJECTION PORT. Cycle 2 had no port, no visible identity on the receiver's
  // right flank at all, and that is a large part of why the model read as a
  // greybox blockout: the reference rifle sells itself on a cut port with a
  // dark interior. Rather than boolean a hole through a swept receiver, this is
  // a near-black slot plate standing 1 mm proud with a rail above and below it
  // — the AO bake then darkens the plate under the rails, which is what makes
  // a raised frame read as a recess at viewmodel scale.
  metal.push(tintGeo(bar(0.0016, 0.0208, -0.018, 0.042, 0.0182, -0.0405, { wear: 0.1 }), 0.14));
  metal.push(bar(0.0026, 0.0038, -0.021, 0.045, 0.0196, -0.0286, { wear: 0.34 }));
  metal.push(bar(0.0026, 0.0034, -0.021, 0.045, 0.0196, -0.0526, { wear: 0.34 }));
  // charging handle + selector live on the right side, as on the real rifle.
  // Its wear was high enough to mix the albedo most of the way to bare steel,
  // which on a cap-mapped cylinder read as an unpainted tan dowel.
  metal.push(
    tintGeo(place(tube(0.0055, 0, 0.052, 12, { wear: 0.15 }), { ry: -0.12, x: 0.019, y: -0.034, z: -0.03 }), 0.88)
  );
  metal.push(bar(0.012, 0.012, 0.018, 0.03, 0.024, -0.034, { wear: 0.34 }));
  // selector lever: the long right-side plate that makes an AK read as an AK
  metal.push(bar(0.006, 0.021, 0.012, 0.098, 0.0215, -0.05, { wear: 0.34 }));
  metal.push(bar(0.007, 0.03, 0.012, 0.026, 0.0215, -0.042, { wear: 0.38 }));
  // receiver rivets (both flanks — the left one is what the player actually sees)
  for (const sx of [-1, 1]) {
    for (const [z, y] of [
      [0.02, -0.056],
      [0.02, -0.088],
      [0.098, -0.058],
      [0.138, -0.084],
    ] as [number, number][]) {
      metal.push(place(tube(0.0038, 0, 0.004, 8, { wear: 0.38 }), { ry: Math.PI / 2, x: sx * 0.0182, y, z }));
    }
  }
  // sling swivels
  metal.push(
    adopt(new THREE.TorusGeometry(0.0075, 0.0022, 8, 16).rotateY(Math.PI / 2), 1.25, 0.05).translate(
      -0.012,
      -0.062,
      -0.33
    )
  );
  metal.push(
    adopt(new THREE.TorusGeometry(0.0075, 0.0022, 8, 16).rotateY(Math.PI / 2), 1.25, 0.05).translate(
      -0.019,
      -0.108,
      0.2
    )
  );
  // Handguard ferrules. Wood butt-ends are never exposed on a real rifle, and
  // an exposed end cap is exactly where a flat-shaded viewmodel looks fake.
  metal.push(
    sweep(
      roundedRect(0.053, 0.045, 0.007, 3),
      [
        // Runs 2 mm PAST the gas block's rear face. Cycle 2 left a 2 mm air gap
        // there with no occlusion in it, which is exactly the kind of seam that
        // makes a merged model read as loose parts near each other.
        { z: -0.312, sx: 0.9, sy: 0.9, oy: -0.077 },
        { z: -0.3, sx: 1.0, sy: 1.0, oy: -0.077 },
        { z: -0.292, sx: 1.0, sy: 1.0, oy: -0.077 },
      ],
      { ...metalOpts, wear: 0.3 }
    )
  );
  metal.push(
    sweep(
      roundedRect(0.053, 0.045, 0.007, 3),
      [
        { z: -0.124, sx: 1.0, sy: 1.0, oy: -0.077 },
        { z: -0.11, sx: 1.0, sy: 1.0, oy: -0.077 },
      ],
      { ...metalOpts, wear: 0.3, caps: [true, false] }
    )
  );
  metal.push(
    sweep(
      archProfile(0.049, 0.028, 0.013, 7),
      [
        { z: -0.296, sx: 0.94, sy: 0.94, oy: -0.04 },
        { z: -0.286, sx: 1.0, sy: 1.0, oy: -0.04 },
      ],
      { ...metalOpts, wear: 0.3 }
    )
  );
  metal.push(
    sweep(
      archProfile(0.049, 0.028, 0.013, 7),
      [
        { z: -0.146, sx: 1.0, sy: 1.0, oy: -0.04 },
        { z: -0.134, sx: 0.96, sy: 0.96, oy: -0.04 },
      ],
      { ...metalOpts, wear: 0.3 }
    )
  );

  // butt plate
  metal.push(
    tintGeo(
      sweep(
        roundedRect(0.042, 0.092, 0.01, 2),
        [
          { z: 0.306, sx: 1.0, sy: 1.0, oy: -0.14 },
          { z: 0.316, sx: 0.96, sy: 0.97, oy: -0.141 },
        ],
        { ...metalOpts, wear: 0.3 }
      ),
      0.75
    )
  );

  // ---------------------------------------------------------------- woodwork
  // Lower handguard with finger swells (scale dips read as grooves).
  const hgProfile: Pt[] = roundedRect(0.05, 0.042, 0.0065, 3);
  const groove = (z: number, s: number): Station => ({ z, sx: s, sy: s, oy: -0.077 });
  wood.push(
    sweep(
      hgProfile,
      [
        groove(-0.302, 0.8),
        groove(-0.292, 0.96),
        groove(-0.275, 1.0),
        groove(-0.259, 0.945),
        groove(-0.243, 1.0),
        groove(-0.227, 0.945),
        groove(-0.211, 1.0),
        groove(-0.195, 0.95),
        groove(-0.179, 1.0),
        groove(-0.152, 1.0),
        groove(-0.13, 0.99),
        groove(-0.116, 0.86),
      ],
      woodOpts
    )
  );
  // Upper handguard over the gas tube.
  wood.push(
    sweep(
      archProfile(0.046, 0.026, 0.012, 7),
      [
        { z: -0.288, sx: 0.88, sy: 0.9, oy: -0.04 },
        { z: -0.276, sx: 1.0, sy: 1.0, oy: -0.04 },
        { z: -0.2, sx: 1.0, sy: 1.0, oy: -0.04 },
        { z: -0.152, sx: 0.99, sy: 0.98, oy: -0.04 },
        { z: -0.138, sx: 0.9, sy: 0.9, oy: -0.04 },
      ],
      { ...woodOpts, caps: [true, true] }
    )
  );
  // Pistol grip: swept down and raked back.
  wood.push(
    place(
      sweep(
        roundedRect(0.032, 0.045, 0.011, 3),
        [
          { z: 0.0, sx: 1.02, sy: 1.0, oy: 0.0 },
          { z: 0.026, sx: 1.06, sy: 1.02, oy: 0.008 },
          { z: 0.062, sx: 1.03, sy: 0.99, oy: 0.019 },
          { z: 0.098, sx: 0.93, sy: 0.94, oy: 0.028 },
          { z: 0.124, sx: 0.86, sy: 0.9, oy: 0.033 },
        ],
        woodOpts
      ),
      { rx: Math.PI / 2, y: -0.092, z: 0.064 }
    )
  );
  // Buttstock: rising drop keeps it clear of the ADS near plane.
  wood.push(
    sweep(
      roundedRect(0.04, 0.1, 0.014, 3),
      [
        { z: 0.148, sx: 0.88, sy: 0.56, oy: -0.072 },
        { z: 0.19, sx: 0.95, sy: 0.62, oy: -0.088 },
        { z: 0.235, sx: 1.0, sy: 0.7, oy: -0.107 },
        { z: 0.275, sx: 1.03, sy: 0.82, oy: -0.126 },
        { z: STOCK_REAR_Z, sx: 1.05, sy: 0.92, oy: -0.14 },
      ],
      woodOpts
    )
  );

  const merge = (list: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    const g = mergeGeometries(list, false);
    if (!g) throw new Error('viewmodel: geometry merge failed');
    for (const part of list) part.dispose();
    return g;
  };

  return { metal: merge(metal), wood: merge(wood) };
}
