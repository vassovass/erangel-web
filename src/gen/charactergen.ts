import * as THREE from 'three';
import { clamp } from './noise';
import {
  SkinBuilder,
  bakeShading,
  draw,
  mix,
  pick,
  shade,
  slotLuma,
  slotVariance,
  toneAt,
  SLOT,
  SURF_CLOTH,
  SURF_GUNWOOD,
  SURF_HAIR,
  SURF_HELMET,
  SURF_LEATHER,
  SURF_METAL,
  SURF_PACK,
  SURF_POLY,
  SURF_RUBBER,
  SURF_SKIN,
  SURF_WEBBING,
  type Blend,
  type LoftRing,
  type Occluder,
  type Shelf,
  type Surf,
} from './char-build';
import { patchCharacterMaterial } from './char-shader';
import { makeContactShadow, placeContactShadow } from './char-ground';
import { useSkyEnv } from '../world/sky';

// Code-built humanoid: ONE SkinnedMesh per bot (one draw call), lofted rounded
// masses + hard-edged gear merged into a single vertex-coloured, vertex-surfaced
// geometry bound to a 14-bone skeleton. Everything is authored in bind-world
// space (see char-build.ts) so any part can be bound to any bone, and joint
// bands carry a 2-bone weight blend so limbs deform instead of hinging open.
//
// The rig contract with src/ai/bot.ts is fixed: buildCharacter(seed) returns
// { mesh, root, bones } with bones named pelvis, spine, head, uarmL/R, farmL/R,
// thighL/R, shinL/R, and poseCharacter(rig, opts) drives them. This file ADDS
// chest, footL and footR; nothing existing was renamed or removed.
//
// Proportions: 1.80m tall, head 0.248m (1/7.25), hip joint at 0.525H, femur:
// shin 1.05:1, shoulder breadth 0.57m at the deltoids widening to ~0.60m over
// the plate carrier, so the standing silhouette is a top-heavy trapezoid.

export interface CharacterRig {
  mesh: THREE.SkinnedMesh;
  root: THREE.Group;
  bones: Record<string, THREE.Bone>;
  seed: number;
  /** Ground contact patch — see char-ground.ts. Lives under `root`. */
  contact: THREE.Mesh;
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

interface BoneDef {
  name: string;
  parent: string | null;
  pos: [number, number, number];
}

const BONE_DEFS: BoneDef[] = [
  { name: 'pelvis', parent: null, pos: [0, 0.970, 0] },
  { name: 'spine', parent: 'pelvis', pos: [0, 0.115, 0] }, // spine_01 — locomotion
  { name: 'chest', parent: 'spine', pos: [0, 0.175, 0] }, // spine_02 — aim layer
  { name: 'head', parent: 'chest', pos: [0, 0.292, 0] },
  { name: 'uarmL', parent: 'chest', pos: [0.206, 0.192, 0] },
  { name: 'uarmR', parent: 'chest', pos: [-0.206, 0.192, 0] },
  { name: 'farmL', parent: 'uarmL', pos: [0.012, -0.288, 0] },
  { name: 'farmR', parent: 'uarmR', pos: [-0.012, -0.288, 0] },
  { name: 'thighL', parent: 'pelvis', pos: [0.098, -0.025, 0] },
  { name: 'thighR', parent: 'pelvis', pos: [-0.098, -0.025, 0] },
  { name: 'shinL', parent: 'thighL', pos: [0, -0.455, 0] },
  { name: 'shinR', parent: 'thighR', pos: [0, -0.455, 0] },
  { name: 'footL', parent: 'shinL', pos: [0, -0.435, 0] },
  { name: 'footR', parent: 'shinR', pos: [0, -0.435, 0] },
];

const BI: Record<string, number> = {};
BONE_DEFS.forEach((b, i) => (BI[b.name] = i));

const PELVIS_Y = BONE_DEFS[0].pos[1];

/** Bind-pose world position of each bone (the bind matrices are translations). */
const BIND: Record<string, THREE.Vector3> = (() => {
  const out: Record<string, THREE.Vector3> = {};
  for (const def of BONE_DEFS) {
    const v = new THREE.Vector3(...def.pos);
    if (def.parent) v.add(out[def.parent]);
    out[def.name] = v;
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Weapon-hold pose, solved once
// ---------------------------------------------------------------------------

const UARM_LEN = 0.288;
const HAND_LEN = 0.330; // elbow -> grip centre (forearm + half hand)

// The rifle lives on the +Z (forward) axis at chest height. Hand targets are
// read straight off it, so if the rifle moves the arms follow.
//
// Cycle 2 put the weapon INSIDE the body: RIFLE_Z0 -0.062 with RIFLE_X -0.086
// meant the buttstock and receiver ran from z -0.062 to 0.24 while the torso's
// front face is at 0.128 and its mag pouches reach 0.227, so from the front the
// bot read as hugging a dark box. The weapon now sits in the SHOULDER POCKET:
// outboard on the firing side, up at collarbone height and clear of the plate
// carrier, with the support elbow flared. The whole weapon axis is outside the
// body outline, which is what the third-person reference shows.
const RIFLE_X = -0.172;
const RIFLE_Y = 1.438;
const RIFLE_DY = RIFLE_Y - 1.372; // every part below is authored against 1.372
const RIFLE_Z0 = 0.048; // butt plate — inside the deltoid, not 7cm inside the chest
/** Pistol grip — right hand. */
const GRIP_Y = 1.302 + RIFLE_DY;
const GRIP_Z = RIFLE_Z0 + 0.296;
const GRIP_TARGET = new THREE.Vector3(RIFLE_X - 0.020, GRIP_Y, GRIP_Z);
/** Handguard — left (support) hand. The support hand sits at the REAR of the
 *  handguard: pushed out to the front of it the arm hits full extension and the
 *  IK clamps to a straight limb, which reads as a mannequin holding a plank. */
const SUPPORT_Y = 1.336 + RIFLE_DY;
const SUPPORT_Z = RIFLE_Z0 + 0.345;
const SUPPORT_TARGET = new THREE.Vector3(RIFLE_X + 0.018, SUPPORT_Y, SUPPORT_Z);

/**
 * Chest BLADE. Cycle 3 solved both arms from a square-on bind skeleton, and the
 * arithmetic that falls out of that is unavoidable: the support shoulder sits
 * 0.35m outboard of a handguard 0.45m in front of it, so the reach is 0.57m
 * against a 0.618m arm and the analytic IK can only return a near-straight limb.
 * That is the "T-pose holding a gun" the panel measured, and no pole vector or
 * target nudge fixes it — the LENGTH is wrong.
 *
 * A shooter solves it by blading: the support shoulder comes forward and the
 * firing shoulder goes back, which is why a rifle stance is never square. Here
 * the temp skeleton is yawed at the chest BEFORE the IK runs, so both shoulder
 * positions move and the support elbow resolves near 105 deg instead of 136.
 * poseCharacter re-applies the same yaw every frame, so the runtime pose IS the
 * pose the hands and rifle were authored in (the hold-space transforms cancel
 * exactly), and only the head counter-yaws back toward the target.
 */
const BLADE = -0.24;

interface HoldPose {
  uarmL: THREE.Euler;
  farmL: THREE.Euler;
  uarmR: THREE.Euler;
  farmR: THREE.Euler;
  /** hold-pose world space -> farmR bind space (the merged rifle + right hand) */
  rifleXf: THREE.Matrix4;
  /** hold-pose world space -> farmL bind space (the support hand) */
  supportXf: THREE.Matrix4;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const TAU = Math.PI * 2;

/** Two-bone analytic IK. Returns parent/child local quaternions. */
function ik2(
  shoulder: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
  pole: THREE.Vector3
): { q1: THREE.Quaternion; q2: THREE.Quaternion } {
  const to = target.clone().sub(shoulder);
  let d = to.length();
  d = clamp(d, Math.abs(l1 - l2) + 0.02, (l1 + l2) * 0.995);
  to.normalize();
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const alpha = Math.acos(cosA);
  const axis = new THREE.Vector3().crossVectors(to, pole);
  if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0);
  axis.normalize();
  const dir1 = to.clone().applyAxisAngle(axis, alpha);
  const elbow = shoulder.clone().addScaledVector(dir1, l1);
  const dir2 = shoulder.clone().addScaledVector(to, d).sub(elbow).normalize();
  const q1 = new THREE.Quaternion().setFromUnitVectors(DOWN, dir1);
  const q2w = new THREE.Quaternion().setFromUnitVectors(DOWN, dir2);
  const q2 = q1.clone().invert().multiply(q2w);
  return { q1, q2 };
}

const HOLD: HoldPose = (() => {
  // Temp skeleton in bind pose.
  const bones: Record<string, THREE.Object3D> = {};
  const rootObj = new THREE.Object3D();
  for (const def of BONE_DEFS) {
    const o = new THREE.Object3D();
    o.position.set(...def.pos);
    bones[def.name] = o;
    (def.parent ? bones[def.parent] : rootObj).add(o);
  }
  // Blade FIRST: the IK must see where the shoulders actually are.
  bones.chest.rotation.y = BLADE;
  rootObj.updateMatrixWorld(true);
  const shR = bones.uarmR.getWorldPosition(new THREE.Vector3());
  const shL = bones.uarmL.getWorldPosition(new THREE.Vector3());

  // Pole vectors flare the elbows outboard rather than letting them collapse
  // into the ribs — the read that says "shouldering a rifle", not "hugging".
  // ik2 returns q1 in WORLD orientation. The upper arms hang off a chest that
  // is now rotated, so q1 has to be taken back into the chest's frame before it
  // can be written as a LOCAL bone rotation — otherwise the blade is applied
  // twice and both hands miss the weapon by ~13 degrees. q2 is already relative
  // to q1, so it needs no correction.
  const invChest = bones.chest.getWorldQuaternion(new THREE.Quaternion()).invert();
  const right = ik2(shR, GRIP_TARGET, UARM_LEN, HAND_LEN, new THREE.Vector3(-0.72, -1, -0.34).normalize());
  bones.uarmR.quaternion.copy(invChest).multiply(right.q1);
  bones.farmR.quaternion.copy(right.q2);
  // The support elbow is FLARED high and outboard: a symmetric inboard tuck on
  // both arms is a praying-mantis clutch, not a shouldered rifle.
  const left = ik2(shL, SUPPORT_TARGET, UARM_LEN, HAND_LEN, new THREE.Vector3(0.75, -0.55, -0.10).normalize());
  bones.uarmL.quaternion.copy(invChest).multiply(left.q1);
  bones.farmL.quaternion.copy(left.q2);
  rootObj.updateMatrixWorld(true);

  // xf = bind(bone) * posed(bone)^-1 : takes a point authored in the hold
  // pose's world space into that bone's bind space, where skinning wants it.
  const xfFor = (name: string): THREE.Matrix4 =>
    new THREE.Matrix4()
      .makeTranslation(BIND[name].x, BIND[name].y, BIND[name].z)
      .multiply(bones[name].matrixWorld.clone().invert());

  return {
    uarmL: bones.uarmL.rotation.clone(),
    farmL: bones.farmL.rotation.clone(),
    uarmR: bones.uarmR.rotation.clone(),
    farmR: bones.farmR.rotation.clone(),
    rifleXf: xfFor('farmR'),
    supportXf: xfFor('farmL'),
  };
})();

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
//
// Hue comes from the tables; VALUE comes from the slot. toneAt() rescales any
// hex to an exact sRGB luma, so a squad can be visually varied in hue while
// every single figure still carries the same hard dark/mid/light ladder. That
// ladder — not hue — is what keeps a body readable against mid-value grass at
// 30m, and it is what the previous single-band olive palette had none of.

// Hues are deliberately LOW-saturation: toneAt only fixes value, so a vivid hex
// pushed to a 0.5 luma slot comes out neon, which is not a colour PUBG's
// late-afternoon grade ever produces.
const SKIN_HUES = [0xc7ac93, 0xac8b70, 0x8a6a52, 0xd3bda6, 0x967059];
const HAIR_HUES = [0x2a1e15, 0x40301f, 0x1b1613, 0x6a5238, 0x332a24];
// NOTHING in here may be a flesh family. Cycle 3 carried "faded tan" and "tan
// brown" alongside a skin slot authored BRIGHTER than the garment, and the
// result at 8-40m was a torso the eye reads as a bare chest with a plate
// carrier strapped to it — the panel called four of five archetypes shirtless
// and they were not: they were wearing a jacket the exact colour and value of
// their own arms. Hue separation from skin is now a hard property of the table,
// and jacketFor() below enforces it per seed as well.
const JACKET_HUES = [
  0x8d9078, // olive
  0x9d9a80, // khaki-olive
  0x9a9a96, // pale grey
  0x8f9488, // sage
  0xc2c4bd, // dirty white
  0x8a939a, // blue-grey
  0x77807e, // slate green
  0x7a8070, // dark olive
];
const PANT_HUES = [0x6f7059, 0x7a7566, 0x63666e, 0x847a66, 0x62625a];
// A CIVILIAN wardrobe for roughly half the squad. PUBG's identity is scavenger,
// not army issue: the reference frame carries four hue families in one
// silhouette (teal jeans, black tee, tan leather, olive rig), and that contrast
// — not polygon count — is why it reads as Erangel. The military tables above
// sit at ~0.10 source saturation, which the warm late-afternoon key annihilates
// back into one tan band; these are authored high enough to survive it.
// Weathered, not bright: every entry is already close to the 0.30 chroma
// ceiling toneAt() enforces, so the hue family survives the rescale to a light
// slot instead of turning into a costume colour.
const CIVIL_TOP_HUES = [
  0x54646e, // faded denim jacket
  0x6a4744, // washed brick track top
  0x545c46, // moss hoodie
  0x2a2a2c, // black tee
  0xbdb9b0, // grey-white tee
  0x454e63, // navy work shirt
  0x6d5344, // worn rust jacket (pulled well off flesh)
  0x5a5060, // dull plum shell
];
const CIVIL_PANT_HUES = [
  0x4a5a68, // blue jeans
  0x3a4750, // dark denim
  0x3a3a3c, // black track pants
  0x6b5b46, // corduroy
  0x3c4d52, // teal work trousers
];
const VEST_HUES = [0x4a4c40, 0x3c362e, 0x55503a, 0x33362f, 0x2e3a40];
const BOOT_HUES = [0x40342a, 0x3a3129, 0x2c2723];
const HELMET_HUES = [0x7a745f, 0x5c5c4c, 0x494a42, 0x6a665a];
const PACK_HUES = [0x6c6852, 0x565b4c, 0x5c5844, 0x4a4a44];

/**
 * Light-band anchors for the jacket. Everything else is derived from these.
 *
 * Cycle 2 spanned only 0.32-0.52 with pants 0.185 under it and skin at
 * 0.38-0.46, so ~80% of the model lived inside one 0.2-wide sRGB band of the
 * same tan as the ground and the figures dissolved at 20-40m. The references
 * hold a TRUE near-black (vest, boots, pack) against a TRUE light (skin, jacket,
 * rolled sleeve); both ends of that ladder are restored here.
 */
const JACKET_LUMA = [0.47, 0.43, 0.39, 0.35, 0.32];

// The weapon is a dark anchor of the silhouette, never a highlight. Nothing on
// a PUBG character is brighter than the field it is standing on.
const METAL = toneAt(0x8f949a, 0.20);
const GUNWOOD = toneAt(0x8a5a33, 0.16);
const POLY = toneAt(0x3f423c, 0.075);

interface CharSpec {
  skin: THREE.Color;
  hair: THREE.Color;
  jacket: THREE.Color;
  cuff: THREE.Color;
  pants: THREE.Color;
  vest: THREE.Color;
  vestLite: THREE.Color;
  boot: THREE.Color;
  glove: THREE.Color;
  helmet: THREE.Color;
  pack: THREE.Color;
  webbing: THREE.Color;
  headgear: number; // 0 bare, 1 cap, 2 helmet, 3 heavy helmet
  hasVest: boolean;
  hasPack: boolean;
  rolled: boolean;
  civilian: boolean;
  bulk: number;
  shoulder: number;
  scale: number;
  /** Authored sRGB luma per slot — what the value-ladder audit asserts against. */
  target: Record<string, number>;
}

/**
 * Chromaticity direction of a colour, normalised out of its value. Two colours
 * with the same direction are the same HUE FAMILY however differently they are
 * lit, which is the comparison that matters here: a torso and the arms beside
 * it read as one uncovered mass whenever their hue families agree, regardless
 * of the fact that one of them is nominally a jacket.
 */
function chromaDir(c: THREE.Color): [number, number, number] {
  const s = Math.max(1e-4, c.r + c.g + c.b);
  return [c.r / s, c.g / s, c.b / s];
}

function chromaDist(a: THREE.Color, b: THREE.Color): number {
  const p = chromaDir(a);
  const q = chromaDir(b);
  return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
}

/** Cool fallbacks used when a seed's top lands in the wearer's own skin family. */
const JACKET_FALLBACK = [
  0x76807c, // sage grey
  0x6f7a86, // slate blue
  0x808476, // dry olive
  0x9a9c99, // pale grey
  0x5e6a72, // dark slate
  0x4e5a63, // navy work
  0x6a6f5c, // moss
  0x5d5a66, // dull plum
];

/**
 * Is this colour in the FLESH family — i.e. would a torso wearing it read as an
 * uncovered chest? Two tests, and either one is disqualifying:
 *
 *   1. it sits within 0.11 of the wearer's own skin in chromaticity, or
 *   2. its red fraction exceeds its blue fraction by more than 0.085.
 *
 * Test 2 is the one that matters and it is deliberately blunt. Cycle 4's first
 * pass shipped test 1 alone and a "washed brick" civilian top still cleared it
 * at 0.097 — then toneAt rescaled it to a 0.47 luma slot and produced a pale
 * salmon that the eye reads as bare skin every time. There is no warm light top
 * that survives being pushed to the brightest slot on the figure, so warm light
 * tops are simply not in the wardrobe. Both references agree: their hue variety
 * lives on leather, packs, dirt and denim, never on a lit torso.
 */
function readsAsFlesh(c: THREE.Color, skin: THREE.Color): boolean {
  const d = chromaDir(c);
  return chromaDist(c, skin) < 0.11 || d[0] - d[2] > 0.085;
}

function specFor(seed: number): CharSpec {
  const civilian = draw(seed, 40) < 0.45;
  const jacketL = pick(JACKET_LUMA, seed, 30);
  // A true two-and-a-half stop drop to the trousers. 0.185 put pants inside the
  // jacket's own band and left the figure one value.
  const pantsL = clamp(jacketL - 0.20 - draw(seed, 31) * 0.04, 0.125, 0.330);
  // The rig has to stay the dark anchor. Bound it to the trousers rather than
  // to a fixed band: on the darkest-trouser seeds a free 0.088-0.122 vest
  // crosses PANTS after AO and the ladder audit catches it.
  const vestL = clamp(Math.min(0.086 + draw(seed, 32) * 0.030, pantsL - 0.045), 0.058, 0.116);
  const packL = 0.122 + draw(seed, 33) * 0.050;
  const bootL = 0.058 + draw(seed, 34) * 0.026;
  const helmetL = 0.118 + draw(seed, 35) * 0.088; // capped well under the jacket
  // SKIN MAY NEVER OUT-VALUE THE GARMENT. Cycle 3 authored skin at 0.345-0.425
  // against a jacket at 0.32-0.47, so on a large fraction of seeds the brightest
  // surface on a battle-royale character was its own bare arm — spot-ability at
  // 20-40m then came down to RNG skin luma rather than to cover or movement.
  // Exposed skin is now the head, neck and (on rolled seeds) the forearm only,
  // and all of it sits a clear step UNDER whatever is covering the trunk.
  const skinL = clamp(
    Math.min(0.300 + draw(seed, 36) * 0.065, jacketL - 0.095),
    0.150,
    0.365
  );

  // Garments take a TIGHTER chroma ceiling than the default: a top is the
  // largest single area on the figure, so a hue that is merely lively on a
  // pouch reads as a costume across a whole chest. Skin keeps the looser cap —
  // desaturating a face to 0.22 chroma turns it grey.
  const skin = toneAt(pick(SKIN_HUES, seed, 11), skinL, 0.34);
  let jacket = toneAt(pick(civilian ? CIVIL_TOP_HUES : JACKET_HUES, seed, 12), jacketL, 0.21);
  // Hard guard, not a palette hope.
  if (readsAsFlesh(jacket, skin)) {
    jacket = toneAt(pick(JACKET_FALLBACK, seed, 41), jacketL, 0.21);
  }
  const boot = toneAt(pick(BOOT_HUES, seed, 16), bootL);
  const vest = toneAt(pick(VEST_HUES, seed, 15), vestL);
  // Headgear must SPREAD across a squad, not be drawn independently per bot —
  // four bots that all rolled a dome helmet are four identical silhouettes at
  // 40m. Bot seeds step by 17, so folding a high bit of the seed into the draw
  // guarantees consecutive members of a squad differ while any single seed
  // stays deterministic.
  const g = draw(seed, 20);
  const headgear = ((seed >>> 3) + Math.floor(g * 4)) % 4;
  return {
    skin,
    hair: toneAt(pick(HAIR_HUES, seed, 13), 0.048 + draw(seed, 37) * 0.042),
    jacket,
    cuff: shade(jacket, 0.62),
    pants: toneAt(pick(civilian ? CIVIL_PANT_HUES : PANT_HUES, seed, 14), pantsL, 0.24),
    vest,
    vestLite: shade(vest, 1.30),
    boot,
    // The glove was shade(boot, 1.04) — ~0.07 luma against a 0.075 polymer grip
    // and a 0.20 receiver, so both hands merged into the weapon and every arm
    // visibly ended in a blunt stump at the wrist. A hand has to be its own
    // value or the finger geometry that exists is invisible.
    glove: toneAt(pick(BOOT_HUES, seed, 16), 0.148 + draw(seed, 39) * 0.030),
    helmet: toneAt(pick(HELMET_HUES, seed, 17), helmetL),
    pack: toneAt(pick(PACK_HUES, seed, 18), packL),
    webbing: toneAt(0x55523f, 0.095),
    headgear,
    hasVest: draw(seed, 21) < 0.76,
    hasPack: draw(seed, 22) < 0.52,
    rolled: draw(seed, 23) < 0.38,
    civilian,
    // Silhouette variance. Five mannequins of one mass read as one asset
    // repeated; the reference squad differs in height, shoulder and girth
    // before it differs in kit.
    bulk: 0.89 + draw(seed, 25) * 0.23, // +/-11% girth
    shoulder: 0.90 + draw(seed, 27) * 0.24, // +/-12% clavicle spread
    scale: 0.925 + draw(seed, 26) * 0.145, // 1.665m - 1.926m
    target: {
      SKIN: skinL, JACKET: jacketL, PANTS: pantsL, VEST: vestL,
      BOOT: bootL, HELMET: helmetL, PACK: packL,
      METAL: 0.20, GUNWOOD: 0.16, POLY: 0.075, WEBBING: 0.095,
    },
  };
}

// ---------------------------------------------------------------------------
// Body masses
// ---------------------------------------------------------------------------

function scaleRings(rings: LoftRing[], k: number): LoftRing[] {
  return rings.map((r) => ({ ...r, rx: r.rx * k, rz: r.rz * k }));
}

/** Widens only the clavicle band, so build varies without changing height. */
function shoulderRings(rings: LoftRing[], sk: number): LoftRing[] {
  return rings.map((r) => {
    const t = clamp((r.y - 1.24) / 0.20, 0, 1);
    const k = 1 + (sk - 1) * t;
    return { ...r, rx: r.rx * k, cx: (r.cx ?? 0) * k };
  });
}

const TORSO: LoftRing[] = [
  { y: 1.085, rx: 0.134, rz: 0.098 },
  { y: 1.160, rx: 0.150, rz: 0.108 },
  { y: 1.240, rx: 0.170, rz: 0.119 },
  { y: 1.320, rx: 0.190, rz: 0.126 },
  { y: 1.395, rx: 0.204, rz: 0.124 },
  { y: 1.448, rx: 0.208, rz: 0.117 }, // shoulder line
  { y: 1.486, rx: 0.180, rz: 0.101 }, // clavicle wedge
  { y: 1.518, rx: 0.110, rz: 0.079 }, // neck base
];
const TORSO_BLEND: Blend[] = [
  [BI.chest, 0.0], [BI.chest, 0.18], [BI.chest, 0.48], [BI.chest, 0.80],
  [BI.chest, 1.0], [BI.chest, 1.0], [BI.chest, 1.0], [BI.chest, 1.0],
];

const HIPS: LoftRing[] = [
  { y: 0.858, rx: 0.122, rz: 0.098 },
  { y: 0.920, rx: 0.147, rz: 0.109 },
  { y: 0.978, rx: 0.149, rz: 0.107 },
  { y: 1.036, rx: 0.139, rz: 0.099 },
  { y: 1.092, rx: 0.134, rz: 0.096 },
];
const HIPS_BLEND: Blend[] = [null, null, null, [BI.spine, 0.35], [BI.spine, 0.8]];

const HEAD: LoftRing[] = [
  { y: 1.556, rx: 0.058, rz: 0.059 }, // neck top
  { y: 1.580, rx: 0.064, rz: 0.072, cz: 0.008 }, // chin
  { y: 1.608, rx: 0.076, rz: 0.086, cz: 0.006 }, // jaw
  { y: 1.640, rx: 0.085, rz: 0.092, cz: 0.002 }, // cheek
  { y: 1.672, rx: 0.087, rz: 0.092 }, // eye line
  { y: 1.694, rx: 0.086, rz: 0.092 }, // brow
  { y: 1.722, rx: 0.084, rz: 0.088, cz: -0.003 }, // forehead
  { y: 1.756, rx: 0.078, rz: 0.078, cz: -0.005 },
  { y: 1.784, rx: 0.058, rz: 0.056, cz: -0.008 },
  { y: 1.800, rx: 0.024, rz: 0.024, cz: -0.010 },
];

/**
 * The upper arm STARTS INSIDE the torso. Cycle 2's first ring sat at y 1.494 —
 * 46mm ABOVE the torso's shoulder line (1.448) and outboard of it — so the tube
 * boundary and its open end both landed on the silhouette and the deltoid read
 * as a detached shoulder pad with a black crescent under the armpit. Rings 0-1
 * are now buried inside the trapezius/chest volume and skinned almost entirely
 * to the chest, so the shoulder is one continuous mass that deforms with the
 * torso rather than swinging as a rigid cap.
 */
function armRings(sx: number): LoftRing[] {
  return [
    { y: 1.486, rx: 0.052, rz: 0.052, cx: sx * 0.148 }, // buried in the trap
    { y: 1.464, rx: 0.068, rz: 0.066, cx: sx * 0.178 }, // deltoid crown
    { y: 1.430, rx: 0.077, rz: 0.074, cx: sx * 0.202 }, // deltoid belly
    { y: 1.352, rx: 0.068, rz: 0.066, cx: sx * 0.212 },
    { y: 1.258, rx: 0.060, rz: 0.059, cx: sx * 0.214 },
    { y: 1.196, rx: 0.056, rz: 0.056, cx: sx * 0.216 },
    { y: 1.164, rx: 0.055, rz: 0.055, cx: sx * 0.217 }, // 32mm into the forearm
  ];
}

function forearmRings(sx: number): LoftRing[] {
  return [
    { y: 1.196, rx: 0.055, rz: 0.055, cx: sx * 0.215 },
    { y: 1.142, rx: 0.056, rz: 0.055, cx: sx * 0.218 },
    { y: 1.052, rx: 0.050, rz: 0.049, cx: sx * 0.220 },
    { y: 0.962, rx: 0.041, rz: 0.040, cx: sx * 0.221 },
    { y: 0.908, rx: 0.037, rz: 0.036, cx: sx * 0.221 },
    { y: 0.884, rx: 0.036, rz: 0.035, cx: sx * 0.221 },
  ];
}

// Every limb tube overlaps its neighbouring mass by 18-32mm at each end so the
// (now CLOSED) cap is never on the silhouette. Cycle 2 shipped these lofts with
// capTop AND capBot false — open-ended cylinders — so any pose that opened a
// joint seam showed a bright elliptical bore with black backface inside it.
function thighRings(sx: number): LoftRing[] {
  return [
    { y: 1.010, rx: 0.090, rz: 0.094, cx: sx * 0.098 }, // 18mm up into the hips
    { y: 0.952, rx: 0.096, rz: 0.099, cx: sx * 0.099 },
    { y: 0.862, rx: 0.092, rz: 0.096, cx: sx * 0.099 },
    { y: 0.742, rx: 0.080, rz: 0.085, cx: sx * 0.098 },
    { y: 0.632, rx: 0.070, rz: 0.074, cx: sx * 0.098 },
    { y: 0.548, rx: 0.065, rz: 0.069, cx: sx * 0.098 },
    { y: 0.506, rx: 0.063, rz: 0.067, cx: sx * 0.098 },
  ];
}

function shinRings(sx: number): LoftRing[] {
  return [
    { y: 0.540, rx: 0.062, rz: 0.066, cx: sx * 0.098 }, // 18mm up into the thigh
    { y: 0.472, rx: 0.066, rz: 0.073, cx: sx * 0.098, cz: -0.010 },
    { y: 0.402, rx: 0.062, rz: 0.071, cx: sx * 0.098, cz: -0.013 }, // calf belly
    { y: 0.302, rx: 0.054, rz: 0.058, cx: sx * 0.098, cz: -0.006 },
    { y: 0.212, rx: 0.050, rz: 0.052, cx: sx * 0.098 },
    { y: 0.146, rx: 0.049, rz: 0.050, cx: sx * 0.098 }, // inside the boot collar
  ];
}

// AKM-ish silhouette. [z0, z1, yCentre, width, height, rotX, tone, surf].
type RiflePart = [number, number, number, number, number, number, THREE.Color, Surf];
const RIFLE: RiflePart[] = [
  // Recoil pad. The butt has to TERMINATE in a plate seated in the deltoid, or
  // the stock reads as a stick ending in mid-air short of the shoulder.
  [-0.026, 0.004, 1.360, 0.050, 0.094, 0.0, POLY, SURF_POLY],
  [0.00, 0.24, 1.362, 0.046, 0.082, 0.0, GUNWOOD, SURF_GUNWOOD], // buttstock
  [0.24, 0.44, 1.372, 0.050, 0.088, 0.0, METAL, SURF_METAL], // receiver
  [0.26, 0.44, 1.418, 0.044, 0.018, 0.0, METAL, SURF_METAL], // dust cover
  [0.265, 0.325, 1.300, 0.038, 0.105, 0.30, POLY, SURF_POLY], // pistol grip
  [0.355, 0.445, 1.297, 0.034, 0.098, -0.20, METAL, SURF_METAL], // magazine
  [0.395, 0.470, 1.232, 0.032, 0.070, -0.55, METAL, SURF_METAL], // magazine curve
  [0.44, 0.60, 1.368, 0.050, 0.072, 0.0, GUNWOOD, SURF_GUNWOOD], // handguard
  [0.46, 0.62, 1.412, 0.034, 0.028, 0.0, METAL, SURF_METAL], // gas tube
  [0.60, 0.82, 1.378, 0.022, 0.022, 0.0, METAL, SURF_METAL], // barrel
  [0.785, 0.830, 1.402, 0.026, 0.056, 0.0, METAL, SURF_METAL], // front sight block
  [0.830, 0.885, 1.378, 0.030, 0.030, 0.0, METAL, SURF_METAL], // muzzle device
  [0.235, 0.300, 1.432, 0.030, 0.020, 0.0, METAL, SURF_METAL], // rear sight
];

// ---------------------------------------------------------------------------
// Shared material — one program, one draw call per character
// ---------------------------------------------------------------------------

let sharedMaterial: THREE.MeshStandardMaterial | null = null;

function material(): THREE.MeshStandardMaterial {
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.86, // overridden per-vertex from aSurf
      metalness: 0.0, // overridden per-vertex from aSurf
      // three OVERWRITES material.envMapIntensity with scene.environmentIntensity
      // for any standard material whose own envMap is null (WebGLRenderer
      // .setProgram), so this knob was inert and the character ran at the scene
      // default of 0.42 — enough for a metalness-0.85 receiver to mirror the
      // full sky PMREM and become the brightest object in a 20m frame. Binding
      // the map per material (sky.ts ships useSkyEnv for exactly this trap)
      // makes the authored value real. 0.16 is a parkerised-steel sheen; the
      // ambient a character actually needs comes from the shader's hemispheric
      // irradiance probe, which is diffuse-only and cannot blow out a highlight.
      envMapIntensity: 0.16,
    });
    patchCharacterMaterial(sharedMaterial);
    useSkyEnv(sharedMaterial);
  }
  return sharedMaterial;
}

// ---------------------------------------------------------------------------
// buildCharacter
// ---------------------------------------------------------------------------

export function buildCharacter(seed: number): CharacterRig {
  const sp = specFor(seed);
  const k = sp.bulk;
  const sk = sp.shoulder;
  const b = new SkinBuilder();

  // Joint fillers. Cycle 2 built these at r * 0.94 — strictly INSIDE the tube
  // radius — so they could never plug the opening they existed to hide; the
  // blob was simply visible through the bore. They now SPAN the bore at r * 1.06
  // on a 5-ring profile, which reads as the muscle mass swelling across the
  // joint rather than a ball in a socket. The tubes are capped as well, so this
  // is belt AND braces: nothing can show a hole even mid-stride.
  const joint = (
    bone: number, cx: number, cy: number, r: number, col: THREE.Color,
    blend: Blend | undefined, slot: number
  ): void => {
    const bl: Blend[] | undefined = blend ? [blend, blend, blend, blend, blend] : undefined;
    b.loft(bone, [
      { y: cy - r * 0.92, rx: r * 0.44, rz: r * 0.44, cx },
      { y: cy - r * 0.55, rx: r * 0.84, rz: r * 0.84, cx },
      { y: cy, rx: r * 1.02, rz: r * 1.02, cx },
      { y: cy + r * 0.55, rx: r * 0.84, rz: r * 0.84, cx },
      { y: cy + r * 0.92, rx: r * 0.44, rz: r * 0.44, cx },
    ], { sides: 12, color: col, surf: SURF_CLOTH, blend: bl, slot });
  };

  const skinDark = mix(sp.skin, new THREE.Color(0x1a1310), 0.62);
  const browDark = mix(sp.skin, new THREE.Color(0x2a1f18), 0.34);
  const handCol = sp.glove; // always gloved: bare hands out-valued the weapon

  // --- hips / seat (pelvis) --------------------------------------------------
  // The jacket hem runs down over the seat: it shortens the perceived leg and
  // gives the waist a real hem edge instead of a painted stripe.
  b.loft(BI.pelvis, scaleRings(HIPS, k), {
    sides: 12,
    color: sp.pants,
    surf: SURF_CLOTH,
    capTop: false,
    blend: HIPS_BLEND,
    colorAt: (r) => (r >= 2 ? sp.jacket : null),
    slot: SLOT.PANTS,
  });
  // Jacket hem flare — a real lip standing 1.5cm proud, not a colour change.
  b.loft(BI.pelvis, scaleRings([
    { y: 0.968, rx: 0.156, rz: 0.114 },
    { y: 1.006, rx: 0.160, rz: 0.117 },
    { y: 1.038, rx: 0.150, rz: 0.110 },
  ], k), {
    sides: 12, color: shade(sp.jacket, 0.92), surf: SURF_CLOTH,
    capTop: false, capBot: false, slot: SLOT.JACKET,
  });
  // Belt + buckle
  b.loft(BI.pelvis, scaleRings([
    { y: 1.040, rx: 0.140, rz: 0.101 },
    { y: 1.074, rx: 0.141, rz: 0.102 },
  ], k), {
    sides: 12, color: sp.boot, surf: SURF_LEATHER,
    capTop: false, capBot: false, slot: SLOT.BOOT,
  });
  b.box(BI.pelvis, 0, 1.058, 0.104 * k, 0.056, 0.042, 0.020, {
    color: METAL, surf: SURF_METAL, slot: SLOT.METAL,
  });
  // Hip pouch — breaks the waist line on one side.
  b.box(BI.pelvis, 0.132 * k, 1.014, 0.028, 0.058, 0.092, 0.070, {
    color: sp.webbing, surf: SURF_WEBBING, taper: 0.9, slot: SLOT.WEBBING,
  });

  // --- torso (spine -> chest) ------------------------------------------------
  // The trunk is not a colour, it is a GARMENT: a buttoned front placket top to
  // hem, a chest yoke seam, side seams and a darker waistband. Cycle 3 lofted
  // the torso as one flat fill, and a flat fill in a flesh-adjacent hue is
  // exactly what the panel read as a naked chest with a rig strapped over it.
  // Panel lines cost nothing and they are what the eye uses to decide a trunk
  // is clothed, at every distance from 3m to 40m.
  const placketCol = shade(sp.jacket, 0.70);
  const yokeCol = shade(sp.jacket, 0.87);
  const seamCol = shade(sp.jacket, 0.82);
  const waistCol = shade(sp.jacket, 0.76);
  b.loft(BI.spine, shoulderRings(scaleRings(TORSO, k), sk), {
    sides: 12,
    color: sp.jacket,
    surf: SURF_CLOTH,
    capBot: false,
    capTop: false,
    blend: TORSO_BLEND,
    slot: SLOT.JACKET,
    colorAt: (r, _s, ang) => {
      const front = Math.cos(ang);
      const side = Math.abs(Math.sin(ang));
      if (r === 0) return waistCol; // waistband
      if (r === 4) return yokeCol; // chest yoke seam
      if (front > 0.86 && r <= 6) return placketCol; // buttoned front
      if (side > 0.95) return seamCol; // side seams
      return null;
    },
    offMod: (r, ang) => (Math.cos(ang) > 0.86 && r >= 1 && r <= 5 ? [0, 0, 0.006] : null),
  });
  // Collar
  b.loft(BI.chest, scaleRings([
    { y: 1.482, rx: 0.096, rz: 0.080 },
    { y: 1.524, rx: 0.090, rz: 0.075 },
    { y: 1.552, rx: 0.082, rz: 0.069 },
  ], k), {
    sides: 12, color: shade(sp.jacket, 0.80), surf: SURF_CLOTH,
    capTop: false, capBot: false, slot: SLOT.JACKET,
  });
  // Neck — three rings so the head can yaw without shearing off the collar.
  b.loft(BI.chest, [
    { y: 1.470, rx: 0.058, rz: 0.056 },
    { y: 1.512, rx: 0.055, rz: 0.053 },
    { y: 1.552, rx: 0.053, rz: 0.051 },
    { y: 1.572, rx: 0.052, rz: 0.050 },
  ], {
    sides: 10, color: skinDark, surf: SURF_SKIN, capTop: false, capBot: false,
    blend: [null, [BI.head, 0.25], [BI.head, 0.62], [BI.head, 0.9]],
    slot: SLOT.SKIN,
  });
  // Trapezius wedge so the head does not plug into the torso like a peg, and
  // so the (buried) top of the sleeve has real mass to sit inside.
  for (const s of [1, -1]) {
    b.box(BI.chest, s * 0.096 * k, 1.466, -0.006, 0.108, 0.044, 0.112, {
      color: shade(sp.jacket, 0.9), surf: SURF_CLOTH, rot: [0, 0, -s * 0.30],
      taper: 0.7, slot: SLOT.JACKET,
    });
  }

  // --- head ------------------------------------------------------------------
  const headCovered = sp.headgear >= 2;
  const eyeDark = mix(sp.skin, new THREE.Color(0x120c08), 0.55);
  const lipDark = mix(sp.skin, new THREE.Color(0x3a1d16), 0.42);
  const cheekLit = shade(sp.skin, 1.08);
  b.loft(BI.head, HEAD, {
    sides: 12,
    color: sp.skin,
    surf: SURF_SKIN,
    capBot: false,
    slot: SLOT.SKIN,
    // The face is mostly VERTEX COLOUR, not geometry. Cycle 2's eye band ran
    // across a ~140 degree arc (front > 0.35), which reads as a blindfold
    // stripe wrapped around the skull; a real eye line occupies about 45
    // degrees either side of centre. Narrowed and darkened, plus a nostril/lip
    // break and a lit cheek plane so the head is not a smooth tan oval at 8m.
    colorAt: (r, _s, ang) => {
      const front = Math.cos(ang);
      const side = Math.abs(Math.sin(ang));
      if (r === 4 && front > 0.72) return eyeDark; // eye line
      if (r === 5 && front > 0.78) return browDark; // brow shadow
      if (r === 3 && front > 0.80) return lipDark; // mouth line
      if (r === 2 && front > 0.62) return mix(sp.skin, browDark, 0.22); // jaw shade
      if ((r === 3 || r === 4) && side > 0.72 && front > -0.2) return cheekLit;
      if (r >= 6) return headCovered ? shade(sp.hair, 0.9) : null;
      return null;
    },
    offMod: (r, ang) => {
      const c = Math.cos(ang), s2 = Math.abs(Math.sin(ang));
      // A brow ridge that actually NOTCHES the silhouette, plus a socket
      // recess under it, so the eye line has geometry behind the value break.
      if (r === 5 && c > 0.30) return [0, -0.002, 0.013 * c];
      if (r === 4 && c > 0.55) return [0, 0, -0.007 * c]; // eye socket recess
      if (r === 1 && c > 0.45) return [0, 0, 0.007 * c]; // chin point
      if ((r === 3 || r === 4) && s2 > 0.80) return [0, 0, -0.004]; // cheekbone
      if (r === 2 && c < -0.5) return [0, 0, -0.006]; // occiput
      return null;
    },
  });
  // Nose: a 4-ring wedge off the brow, not a floating rectangular tab. It runs
  // from the bridge down to a shadowed underside so it breaks the profile and
  // casts into the baked AO.
  b.loft(BI.head, [
    { y: 1.700, rx: 0.011, rz: 0.014, cz: 0.084 },
    { y: 1.678, rx: 0.014, rz: 0.020, cz: 0.090 },
    { y: 1.658, rx: 0.018, rz: 0.024, cz: 0.094 },
    { y: 1.646, rx: 0.017, rz: 0.020, cz: 0.090 },
  ], {
    sides: 8, color: mix(sp.skin, browDark, 0.14), surf: SURF_SKIN,
    capTop: false, slot: SLOT.SKIN,
    colorAt: (r) => (r === 3 ? mix(sp.skin, browDark, 0.55) : null),
  });
  // Ears — smaller and set back; cycle 2's stood proud enough to read as tabs.
  for (const s of [1, -1]) {
    b.box(BI.head, s * 0.084, 1.658, -0.010, 0.011, 0.042, 0.026, {
      color: mix(sp.skin, browDark, 0.30), surf: SURF_SKIN,
      rot: [0, 0, -s * 0.12], taper: 0.8, slot: SLOT.SKIN,
    });
  }
  // --- actual FACE ------------------------------------------------------------
  // Cycle 3 tried to carry the face on vertex colour alone at 12 sides, which
  // gives an eye about 2 vertices wide on a smoothed ring — it averages away to
  // nothing and the head renders as the smooth tan ovoid the panel measured. A
  // face needs its own primitives; six small boxes is enough past 3m and they
  // survive smoothing because a box is flat-shaded.
  const eyeCol = mix(sp.skin, new THREE.Color(0x0d0906), 0.80);
  const scleraCol = mix(sp.skin, new THREE.Color(0xd8d2c6), 0.55);
  for (const s of [1, -1]) {
    // Eye: a pale sclera plate with a dark iris block set into it.
    b.box(BI.head, s * 0.034, 1.6720, 0.0790, 0.032, 0.0135, 0.012, {
      color: scleraCol, surf: SURF_SKIN, rot: [0, -s * 0.16, 0], slot: SLOT.SKIN,
    });
    b.box(BI.head, s * 0.031, 1.6715, 0.0835, 0.0135, 0.0125, 0.010, {
      color: eyeCol, surf: SURF_SKIN, rot: [0, -s * 0.16, 0], slot: SLOT.SKIN,
    });
    // Brow: a real bar above the socket, angled outward-down.
    b.box(BI.head, s * 0.036, 1.6905, 0.0775, 0.044, 0.0125, 0.016, {
      color: mix(sp.hair, browDark, 0.35), surf: SURF_HAIR,
      rot: [0, 0, -s * 0.16], taper: 0.9, slot: SLOT.HAIR,
    });
  }
  // Mouth line and a shadowed underlip, so the lower face is not a blank plane.
  b.box(BI.head, 0, 1.6215, 0.0745, 0.044, 0.0095, 0.012, {
    color: lipDark, surf: SURF_SKIN, taper: 0.86, slot: SLOT.SKIN,
  });
  // Jaw / chin plane: the head profile was a circle, which is why nothing broke
  // the helmet-to-neck silhouette. A chin block gives it a front corner.
  b.box(BI.head, 0, 1.5905, 0.0500, 0.060, 0.030, 0.052, {
    color: mix(sp.skin, browDark, 0.18), surf: SURF_SKIN,
    rot: [0.22, 0, 0], taper: 0.78, slot: SLOT.SKIN,
  });
  // Hair at the nape and temples, protruding past the helmet rim. Under a
  // helmet cycle 3 skipped hair entirely, so every covered head met the neck on
  // a bare curve and four bots shared one outline at 40m.
  b.box(BI.head, 0, 1.6420, -0.0865, 0.136, 0.060, 0.030, {
    color: sp.hair, surf: SURF_HAIR, taper: 0.88, slot: SLOT.HAIR,
  });
  for (const s of [1, -1]) {
    b.box(BI.head, s * 0.0805, 1.6560, -0.0330, 0.022, 0.052, 0.070, {
      color: shade(sp.hair, 1.08), surf: SURF_HAIR,
      rot: [0, 0, -s * 0.10], taper: 0.9, slot: SLOT.HAIR,
    });
  }
  // Hair / stubble crop — skipped under a helmet, which would otherwise let the
  // crown poke through the shell.
  if (!headCovered) {
    b.loft(BI.head, [
      { y: 1.694, rx: 0.090, rz: 0.094, cz: -0.004 },
      { y: 1.744, rx: 0.087, rz: 0.086, cz: -0.006 },
      { y: 1.782, rx: 0.064, rz: 0.060, cz: -0.009 },
      { y: 1.806, rx: 0.028, rz: 0.026, cz: -0.011 },
    ], {
      sides: 12,
      color: sp.hair,
      surf: SURF_HAIR,
      capBot: false,
      slot: SLOT.HAIR,
      radMod: (r, ang) => (r === 0 ? 1 - 0.15 * Math.max(0, Math.cos(ang)) : 1),
    });
  }

  // --- headgear --------------------------------------------------------------
  let brimY = 0;
  if (sp.headgear === 1) {
    // Ball cap: shallow dome + peak + a sweatband lip.
    b.loft(BI.head, [
      { y: 1.700, rx: 0.095, rz: 0.098, cz: -0.004 },
      { y: 1.716, rx: 0.094, rz: 0.097, cz: -0.004 },
      { y: 1.762, rx: 0.090, rz: 0.089, cz: -0.006 },
      { y: 1.798, rx: 0.062, rz: 0.058, cz: -0.008 },
      { y: 1.816, rx: 0.026, rz: 0.024, cz: -0.010 },
    ], { sides: 12, color: sp.helmet, surf: SURF_CLOTH, capBot: false, slot: SLOT.HELMET });
    b.box(BI.head, 0, 1.704, 0.148, 0.152, 0.016, 0.118, {
      color: shade(sp.helmet, 0.74), surf: SURF_CLOTH, rot: [0.16, 0, 0], slot: SLOT.HELMET,
    });
    b.box(BI.head, 0, 1.812, -0.004, 0.024, 0.014, 0.024, {
      color: shade(sp.helmet, 0.8), surf: SURF_CLOTH, slot: SLOT.HELMET,
    });
    brimY = 1.700;
  } else if (sp.headgear >= 2) {
    // Combat helmet: real rim thickness, a rear sweep, ear cups modelled INTO
    // the shell, a brow band and a Y chinstrap with a jaw-side buckle.
    const heavy = sp.headgear === 3;
    const R = heavy ? 0.121 : 0.114;
    const yc = 1.704;
    const dome: LoftRing[] = [];
    for (const th of [84, 68, 50, 32, 15]) {
      const t = (th * Math.PI) / 180;
      dome.push({ y: yc + R * Math.cos(t) * 0.98, rx: R * Math.sin(t), rz: R * Math.sin(t) * 1.04, cz: -0.006 });
    }
    // Rim lip below the equator: outer flare, then a step back under it. That
    // step is the whole difference between a helmet and a bowler hat.
    dome.unshift({ y: yc - 0.030, rx: R * 1.05, rz: R * 1.08, cz: -0.006 });
    dome.unshift({ y: yc - 0.046, rx: R * 0.99, rz: R * 1.02, cz: -0.006 });
    b.loft(BI.head, dome, {
      sides: 12,
      color: sp.helmet,
      surf: SURF_HELMET,
      capBot: false,
      slot: SLOT.HELMET,
      radMod: (r, ang) => (r <= 2 && Math.abs(Math.sin(ang)) > 0.72 ? 1.11 : 1), // ear cups
      offMod: (r, ang) => (r <= 2 && Math.cos(ang) < -0.45 ? [0, 0, -0.020] : null), // rear sweep
    });
    brimY = yc - 0.046;
    // Brow band, seated FLUSH against the shell. Standing it proud gave it its
    // own hard cast shadow and a visible gap, which is what made the helmet
    // read as two stacked objects.
    b.box(BI.head, 0, 1.674, 0.100, 0.124, 0.026, 0.020, {
      color: shade(sp.helmet, 0.72), surf: SURF_HELMET, rot: [0.14, 0, 0], slot: SLOT.HELMET,
    });
    // Y chinstrap, closed into a chin cup rather than two bars ending mid-cheek.
    for (const s of [1, -1]) {
      b.box(BI.head, s * 0.082, 1.622, 0.020, 0.014, 0.094, 0.022, {
        color: shade(sp.helmet, 0.44), surf: SURF_WEBBING, rot: [0.18, 0, -s * 0.24],
        slot: SLOT.WEBBING,
      });
      b.box(BI.head, s * 0.074, 1.618, -0.048, 0.013, 0.088, 0.020, {
        color: shade(sp.helmet, 0.44), surf: SURF_WEBBING, rot: [-0.22, 0, -s * 0.20],
        slot: SLOT.WEBBING,
      });
      b.box(BI.head, s * 0.062, 1.594, -0.010, 0.022, 0.022, 0.018, {
        color: POLY, surf: SURF_POLY, slot: SLOT.POLY,
      });
      // strap-to-cup link, so nothing terminates in mid air
      b.box(BI.head, s * 0.046, 1.586, 0.020, 0.036, 0.020, 0.030, {
        color: shade(sp.helmet, 0.40), surf: SURF_WEBBING, rot: [0.20, 0, -s * 0.42],
        slot: SLOT.WEBBING,
      });
    }
    b.box(BI.head, 0, 1.580, 0.044, 0.070, 0.030, 0.048, {
      color: shade(sp.helmet, 0.40), surf: SURF_WEBBING, rot: [0.26, 0, 0], taper: 0.86,
      slot: SLOT.WEBBING,
    });
    if (heavy) {
      b.box(BI.head, 0, 1.752, 0.092, 0.050, 0.032, 0.040, {
        color: POLY, surf: SURF_POLY, slot: SLOT.POLY,
      });
      b.box(BI.head, 0.104, 1.700, -0.028, 0.020, 0.052, 0.062, {
        color: shade(sp.helmet, 0.82), surf: SURF_HELMET, taper: 0.8, slot: SLOT.HELMET,
      });
    }
  }

  // --- arms ------------------------------------------------------------------
  for (const side of [1, -1] as const) {
    const uarm = side > 0 ? BI.uarmL : BI.uarmR;
    const farm = side > 0 ? BI.farmL : BI.farmR;
    // Deltoid blends into the chest at the top and into the forearm at the
    // elbow, so neither end shows a cut plane.
    // Rings 0-2 skin almost entirely to the CHEST (0.90 / 0.62 / 0.30), so the
    // top of the sleeve deforms with the torso instead of swinging as a rigid
    // pad hinged at the shoulder bone.
    b.loft(uarm, shoulderRings(scaleRings(armRings(side), k), sk), {
      sides: 12,
      color: sp.jacket,
      surf: SURF_CLOTH,
      blend: [
        [BI.chest, 0.90], [BI.chest, 0.62], [BI.chest, 0.30],
        null, null, [farm, 0.34], [farm, 0.72],
      ],
      slot: SLOT.JACKET,
    });
    // Shoulder seam / sleeve break.
    b.loft(uarm, scaleRings([
      { y: 1.348, rx: 0.073, rz: 0.071, cx: side * 0.212 },
      { y: 1.368, rx: 0.074, rz: 0.072, cx: side * 0.212 },
    ], k), {
      sides: 12, color: shade(sp.jacket, 0.82), surf: SURF_CLOTH,
      capTop: false, capBot: false, slot: SLOT.JACKET,
    });

    b.loft(farm, scaleRings(forearmRings(side), k), {
      sides: 12,
      color: sp.jacket,
      surf: SURF_CLOTH,
      blend: [[uarm, 0.68], [uarm, 0.28], null, null, null, null],
      colorAt: (r) => {
        if (!sp.rolled) return r >= 3 ? sp.cuff : null;
        // Exposed forearm sits BELOW the uniform in value: a bright bare arm
        // next to a dark weapon reads as the highest-value element on the model.
        return r >= 2 ? shade(sp.skin, 0.82) : null;
      },
      surfAt: (r) => (sp.rolled && r >= 2 ? SURF_SKIN : null),
      slot: SLOT.JACKET,
    });
    if (sp.rolled) {
      b.loft(farm, scaleRings([
        { y: 1.088, rx: 0.058, rz: 0.057, cx: side * 0.219 },
        { y: 1.134, rx: 0.057, rz: 0.056, cx: side * 0.218 },
      ], k), {
        sides: 12, color: sp.cuff, surf: SURF_CLOTH,
        capTop: false, capBot: false, slot: SLOT.JACKET,
      });
    }
    // Only the ELBOW keeps a filler. The shoulder blob is gone: the sleeve now
    // starts inside the trapezius, so a blob there only added a water-wing
    // bulge on top of a mass that was already continuous.
    joint(farm, side * 0.216, 1.180, 0.050 * k, sp.rolled ? sp.cuff : sp.jacket, [uarm, 0.4], SLOT.JACKET);
  }

  // --- hands ------------------------------------------------------------------
  // Authored in HOLD-pose world space and pushed through the same transform the
  // rifle uses, so the fingers weld to the weapon instead of hovering beside a
  // wrist. Three boxes per hand: palm, wrapped fingers, thumb over the top.
  const hand = (xf: THREE.Matrix4, bone: number, parts: Array<[number, number, number, number, number, number, [number, number, number] | undefined, THREE.Color]>): void => {
    for (const [cx, cy, cz, sx, sy, sz, rot, col] of parts) {
      b.box(bone, cx, cy, cz, sx, sy, sz, {
        color: col, surf: SURF_LEATHER, rot, xf, taper: 0.94, slot: SLOT.GLOVE,
      });
    }
  };
  // FINGERS ARE SEPARATE BLOCKS with real gaps. Cycle 3 built one fused block
  // per hand in a value that measured inside the weapon's own band, so both
  // hands dissolved into the gun and every forearm terminated in a rounded
  // stump at the wrist. Separation needs two things and needs both: gaps the
  // silhouette can see, and a glove value that is not the weapon's value.
  const knuckle = shade(handCol, 1.16);
  const fingerCol = shade(handCol, 0.94);
  const cuffLite = shade(handCol, 1.34); // the sleeve terminator, deliberately light
  hand(HOLD.rifleXf, BI.farmR, [
    // palm, on the shooter's side of the pistol grip
    [RIFLE_X - 0.034, GRIP_Y, GRIP_Z, 0.038, 0.092, 0.058, [0.30, 0, 0], handCol],
    // three separate fingers wrapping the FRONT face of the grip
    [RIFLE_X - 0.006, GRIP_Y - 0.030, GRIP_Z + 0.030, 0.072, 0.018, 0.030, [0.30, 0, 0], fingerCol],
    [RIFLE_X - 0.006, GRIP_Y - 0.007, GRIP_Z + 0.033, 0.072, 0.018, 0.031, [0.30, 0, 0], knuckle],
    [RIFLE_X - 0.006, GRIP_Y + 0.016, GRIP_Z + 0.033, 0.070, 0.017, 0.030, [0.30, 0, 0], fingerCol],
    // trigger finger reaching the guard
    [RIFLE_X + 0.020, GRIP_Y + 0.026, GRIP_Z + 0.026, 0.019, 0.016, 0.058, [0.12, 0, 0], knuckle],
    // thumb crossing over the top of the receiver
    [RIFLE_X + 0.006, GRIP_Y + 0.040, GRIP_Z + 0.004, 0.056, 0.019, 0.026, [0.18, 0, 0.22], knuckle],
    // wrist cuff, closing the gap to the sleeve
    [RIFLE_X - 0.052, GRIP_Y + 0.036, GRIP_Z - 0.032, 0.050, 0.030, 0.058, [0.30, 0, 0], cuffLite],
  ]);
  hand(HOLD.supportXf, BI.farmL, [
    // palm under the handguard
    [RIFLE_X + 0.002, SUPPORT_Y - 0.030, SUPPORT_Z, 0.068, 0.034, 0.090, undefined, handCol],
    // four fingers curling over the far side, each its own block
    [RIFLE_X - 0.032, SUPPORT_Y + 0.002, SUPPORT_Z + 0.030, 0.024, 0.058, 0.024, [0, 0, 0.10], fingerCol],
    [RIFLE_X - 0.032, SUPPORT_Y + 0.004, SUPPORT_Z + 0.001, 0.024, 0.060, 0.024, [0, 0, 0.10], knuckle],
    [RIFLE_X - 0.031, SUPPORT_Y + 0.002, SUPPORT_Z - 0.028, 0.023, 0.056, 0.023, [0, 0, 0.10], fingerCol],
    // thumb on the near side
    [RIFLE_X + 0.034, SUPPORT_Y - 0.002, SUPPORT_Z - 0.010, 0.022, 0.048, 0.062, [0, 0, -0.14], knuckle],
    // wrist cuff
    [RIFLE_X + 0.050, SUPPORT_Y - 0.046, SUPPORT_Z - 0.056, 0.052, 0.032, 0.050, [0, 0, -0.2], cuffLite],
  ]);

  // --- legs ------------------------------------------------------------------
  for (const side of [1, -1] as const) {
    const thigh = side > 0 ? BI.thighL : BI.thighR;
    const shin = side > 0 ? BI.shinL : BI.shinR;
    const foot = side > 0 ? BI.footL : BI.footR;
    b.loft(thigh, scaleRings(thighRings(side), k), {
      sides: 12,
      color: sp.pants,
      surf: SURF_CLOTH,
      blend: [
        [BI.pelvis, 0.80], [BI.pelvis, 0.42], [BI.pelvis, 0.12],
        null, null, [shin, 0.30], [shin, 0.68],
      ],
      slot: SLOT.PANTS,
    });
    b.loft(shin, scaleRings(shinRings(side), k), {
      sides: 12,
      color: sp.pants,
      surf: SURF_CLOTH,
      blend: [[thigh, 0.72], [thigh, 0.30], null, null, [foot, 0.20], [foot, 0.45]],
      slot: SLOT.PANTS,
    });
    joint(shin, side * 0.098, 0.508, 0.062 * k, sp.pants, [thigh, 0.4], SLOT.PANTS);
    // Knee pad — a silhouette breaker and a real value step on the leg.
    b.box(shin, side * 0.098, 0.478, 0.058 * k, 0.086, 0.104, 0.038, {
      color: sp.webbing, surf: SURF_WEBBING, taper: 0.88, blend: [thigh, 0.3], slot: SLOT.WEBBING,
    });
    // Cargo pocket — extruded 22mm with a flap lip, not a decal on the thigh.
    b.box(thigh, side * 0.114 * k, 0.740, 0.030, 0.046, 0.116, 0.100, {
      color: shade(sp.pants, 0.86), surf: SURF_CLOTH, taper: 0.94, slot: SLOT.PANTS,
    });
    b.box(thigh, side * 0.116 * k, 0.792, 0.030, 0.042, 0.026, 0.104, {
      color: shade(sp.pants, 0.70), surf: SURF_CLOTH, taper: 0.96, slot: SLOT.PANTS,
    });
    // Pants bloused over the boot top.
    b.loft(shin, scaleRings([
      { y: 0.158, rx: 0.066, rz: 0.068, cx: side * 0.098 },
      { y: 0.222, rx: 0.072, rz: 0.074, cx: side * 0.098 },
      { y: 0.268, rx: 0.058, rz: 0.060, cx: side * 0.098 },
    ], k), {
      sides: 12, color: sp.pants, surf: SURF_CLOTH, capTop: false, capBot: false,
      blend: [[foot, 0.25], null, null], slot: SLOT.PANTS,
    });

    // Boot: ankle collar, upper, toe box, and a 3-segment sole with a break.
    // The sole boxes previously topped out at y 0.034 while the upper started
    // at 0.043 — a 9mm black gap running right around the boot.
    const fx = side * 0.098;
    b.loft(foot, [
      { y: 0.100, rx: 0.058, rz: 0.060, cx: fx },
      { y: 0.150, rx: 0.062, rz: 0.064, cx: fx },
      { y: 0.186, rx: 0.058, rz: 0.058, cx: fx },
    ], {
      sides: 12, color: shade(sp.boot, 1.2), surf: SURF_LEATHER, capTop: false, capBot: false,
      blend: [null, [shin, 0.30], [shin, 0.55]], slot: SLOT.BOOT,
    });
    // Upper: instep block, a TAPERED toe (ball 1.15x ankle, tip 0.62x) and a
    // heel counter. Cycle 3 stacked two equal slabs with the sole overhanging
    // the toe by 17mm and no taper anywhere, which at 20m is a brick.
    b.box(foot, fx, 0.084, 0.008, 0.090, 0.090, 0.130, {
      color: sp.boot, surf: SURF_LEATHER, taper: 0.92, slot: SLOT.BOOT,
    });
    b.box(foot, fx, 0.058, 0.078, 0.086, 0.062, 0.074, {
      color: sp.boot, surf: SURF_LEATHER, taper: 0.84, slot: SLOT.BOOT,
    });
    // Toe cap, narrowing to the tip so the boot has a direction.
    b.box(foot, fx, 0.046, 0.114, 0.070, 0.044, 0.044, {
      color: shade(sp.boot, 1.10), surf: SURF_LEATHER, rot: [-0.22, 0, 0],
      taper: 0.66, slot: SLOT.BOOT,
    });
    b.box(foot, fx, 0.052, -0.050, 0.080, 0.062, 0.056, {
      color: shade(sp.boot, 0.9), surf: SURF_LEATHER, taper: 0.9, slot: SLOT.BOOT,
    });
    // Sole: toe / waisted arch / heel, each INSIDE the upper's footprint so no
    // shelf hangs past the leather. Rubber, so it takes no specular — a shiny
    // sole is what made the boots read cream at 20m.
    const soleCol = shade(sp.boot, 0.58);
    b.box(foot, fx, 0.024, 0.086, 0.084, 0.048, 0.084, {
      color: soleCol, surf: SURF_RUBBER, taper: 1.08, slot: SLOT.BOOT,
    });
    b.box(foot, fx, 0.028, 0.014, 0.078, 0.040, 0.086, {
      color: soleCol, surf: SURF_RUBBER, taper: 1.08, slot: SLOT.BOOT,
    });
    b.box(foot, fx, 0.024, -0.056, 0.082, 0.048, 0.068, {
      color: soleCol, surf: SURF_RUBBER, taper: 1.06, slot: SLOT.BOOT,
    });
  }

  // --- chest rig / plate carrier ---------------------------------------------
  // Real extruded shell: front plate, back plate, cummerbund, shoulder yokes
  // and six pouches. Nothing here is coplanar with the body — the whole point
  // is to break the outline so the figure is not a plain humanoid at 25m.
  let vestHem = 0;
  const frontZ = 0.128 * k;
  if (sp.hasVest) {
    b.box(BI.chest, 0, 1.312, frontZ + 0.026, 0.252 * sk, 0.302, 0.052, {
      color: sp.vest, surf: SURF_WEBBING, taper: 0.96, slot: SLOT.VEST,
    });
    b.box(BI.chest, 0, 1.316, -frontZ - 0.024, 0.258 * sk, 0.312, 0.048, {
      color: sp.vest, surf: SURF_WEBBING, taper: 0.96, slot: SLOT.VEST,
    });
    // Cummerbund wrapping the waist, standing proud of the jacket.
    b.loft(BI.spine, scaleRings([
      { y: 1.146, rx: 0.174, rz: 0.128 },
      { y: 1.196, rx: 0.180, rz: 0.132 },
      { y: 1.238, rx: 0.176, rz: 0.129 },
    ], k), {
      sides: 12, color: shade(sp.vest, 0.86), surf: SURF_WEBBING, capTop: false, capBot: false,
      blend: [[BI.chest, 0.35], [BI.chest, 0.55], [BI.chest, 0.75]], slot: SLOT.VEST,
    });
    // Shoulder yokes over the traps, front and back.
    for (const s of [1, -1]) {
      b.box(BI.chest, s * 0.104 * sk, 1.462, 0.004, 0.070, 0.036, 0.232, {
        color: shade(sp.vest, 1.1), surf: SURF_WEBBING, rot: [0, 0, s * 0.12], slot: SLOT.VEST,
      });
    }
    // Mag pouches across the front, each with a flap lip so the edge catches a
    // highlight instead of reading as a flat quad glued to the plate.
    for (const px of [-0.088, 0, 0.088]) {
      b.box(BI.chest, px * sk, 1.244, frontZ + 0.070, 0.080, 0.118, 0.058, {
        color: sp.vestLite, surf: SURF_WEBBING, taper: 0.92, slot: SLOT.VEST,
      });
      b.box(BI.chest, px * sk, 1.300, frontZ + 0.074, 0.084, 0.022, 0.062, {
        color: shade(sp.vest, 0.78), surf: SURF_WEBBING, taper: 0.94, slot: SLOT.VEST,
      });
    }
    // Utility + admin pouches higher up.
    for (const s of [1, -1]) {
      b.box(BI.chest, s * 0.108 * sk, 1.368, frontZ + 0.060, 0.070, 0.088, 0.046, {
        color: shade(sp.vest, 0.72), surf: SURF_WEBBING, taper: 0.9, slot: SLOT.VEST,
      });
    }
    b.box(BI.chest, 0, 1.382, frontZ + 0.056, 0.104, 0.070, 0.040, {
      color: sp.vestLite, surf: SURF_WEBBING, taper: 0.92, slot: SLOT.VEST,
    });
    // Radio on the back plate.
    b.box(BI.chest, 0.082 * sk, 1.400, -frontZ - 0.062, 0.070, 0.110, 0.044, {
      color: POLY, surf: SURF_POLY, taper: 0.92, slot: SLOT.POLY,
    });
    // MOLLE ladder: four webbing rows at 2.5cm pitch standing 8mm proud of the
    // REAR plate, which sheet-back showed as one unbroken black rectangle — the
    // largest single flat area on the whole figure and the one most often
    // silhouetted against sky.
    for (let i = 0; i < 4; i++) {
      b.box(BI.chest, 0, 1.222 + i * 0.052, -frontZ - 0.050, 0.222 * sk, 0.016, 0.010, {
        color: sp.webbing, surf: SURF_WEBBING, slot: SLOT.WEBBING,
      });
    }
    // Rear utility pouch — a real volume so the back is not a slab.
    b.box(BI.chest, -0.070 * sk, 1.238, -frontZ - 0.070, 0.092, 0.104, 0.052, {
      color: sp.vestLite, surf: SURF_WEBBING, taper: 0.9, slot: SLOT.VEST,
    });
    vestHem = 1.146;
  }

  // --- backpack --------------------------------------------------------------
  // Seated flush against the back plate (zero air gap), 15cm proud, with a
  // chamfered top flap, a bottom roll, two compression straps and shoulder
  // straps that route over the clavicles and terminate on the chest.
  let packHem = 0;
  if (sp.hasPack) {
    const back = -(frontZ + (sp.hasVest ? 0.048 : 0.006));
    const bz = back - 0.070;
    // A STUFFED pack, lofted with rounded corners and a bulged middle, whose
    // rear-most rings sit flush against the back. Cycle 2's rectangular box
    // hung off the spine at an angle with a visible air gap and read as a slab
    // of luggage strapped to a mannequin. Lofting it also lets the top and
    // bottom taper into the body instead of terminating on a hard edge.
    b.loft(BI.chest, [
      { y: 1.096, rx: 0.088 * sk, rz: 0.048, cz: bz + 0.030 },
      { y: 1.150, rx: 0.114 * sk, rz: 0.068, cz: bz + 0.008 },
      { y: 1.240, rx: 0.126 * sk, rz: 0.080, cz: bz },
      { y: 1.340, rx: 0.128 * sk, rz: 0.082, cz: bz },
      { y: 1.430, rx: 0.118 * sk, rz: 0.072, cz: bz + 0.004 },
      { y: 1.492, rx: 0.094 * sk, rz: 0.052, cz: bz + 0.020 },
    ], {
      sides: 12, color: sp.pack, surf: SURF_PACK, slot: SLOT.PACK,
      colorAt: (r) => (r >= 4 ? shade(sp.pack, 0.86) : null),
    });
    // Inset filler that FOLLOWS the torso curve, closing the wedge between the
    // pack's rear face and the rounded back.
    b.loft(BI.chest, [
      { y: 1.150, rx: 0.112 * sk, rz: 0.056, cz: back - 0.020 },
      { y: 1.300, rx: 0.120 * sk, rz: 0.062, cz: back - 0.022 },
      { y: 1.440, rx: 0.110 * sk, rz: 0.056, cz: back - 0.018 },
    ], {
      sides: 10, color: shade(sp.pack, 0.68), surf: SURF_PACK,
      capTop: false, capBot: false, slot: SLOT.PACK,
    });
    // Lid flap and bottom roll, both sitting proud so the pack has silhouette
    // steps rather than one continuous rectangle.
    b.box(BI.chest, 0, 1.470, bz - 0.010, 0.226 * sk, 0.056, 0.146, {
      color: shade(sp.pack, 0.80), surf: SURF_PACK, taper: 0.86, slot: SLOT.PACK,
    });
    b.box(BI.chest, 0, 1.126, bz - 0.004, 0.210 * sk, 0.062, 0.128, {
      color: shade(sp.pack, 0.68), surf: SURF_PACK, taper: 0.94, slot: SLOT.PACK,
    });
    for (const cy of [1.222, 1.372]) {
      b.box(BI.chest, 0, cy, bz - 0.074, 0.244 * sk, 0.026, 0.020, {
        color: sp.webbing, surf: SURF_WEBBING, slot: SLOT.WEBBING,
      });
    }
    for (const s of [1, -1]) {
      // over the clavicle
      b.box(BI.chest, s * 0.100 * sk, 1.468, -0.016, 0.056, 0.030, 0.250, {
        color: sp.webbing, surf: SURF_WEBBING, rot: [0, 0, s * 0.10], slot: SLOT.WEBBING,
      });
      // down the chest to the rig
      b.box(BI.chest, s * 0.098 * sk, 1.336, frontZ + 0.046, 0.052, 0.240, 0.020, {
        color: sp.webbing, surf: SURF_WEBBING, rot: [0.06, 0, s * 0.10], slot: SLOT.WEBBING,
      });
    }
    // Sternum strap
    b.box(BI.chest, 0, 1.372, frontZ + 0.048, 0.186 * sk, 0.022, 0.016, {
      color: sp.webbing, surf: SURF_WEBBING, slot: SLOT.WEBBING,
    });
    packHem = 1.128;
  }

  // --- rifle (merged, bound to farmR) ----------------------------------------
  for (const [z0, z1, y, w, h, rot, tone, srf] of RIFLE) {
    b.box(
      BI.farmR, RIFLE_X, y + RIFLE_DY, RIFLE_Z0 + (z0 + z1) * 0.5, w, h, z1 - z0,
      {
        color: tone, surf: srf, rot: rot ? [rot, 0, 0] : undefined, xf: HOLD.rifleXf,
        slot: srf === SURF_GUNWOOD ? SLOT.GUNWOOD : srf === SURF_POLY ? SLOT.POLY : SLOT.METAL,
      }
    );
  }
  // Sling: two real segments from the front sight to the buttstock, routed
  // across the chest rather than one painted diagonal.
  b.box(BI.chest, 0.030 * k, 1.300, frontZ + 0.030, 0.030, 0.320, 0.018, {
    color: sp.webbing, surf: SURF_WEBBING, rot: [0, 0, 0.52], slot: SLOT.WEBBING,
  });
  b.box(BI.chest, -0.052 * k, 1.290, -frontZ - 0.010, 0.028, 0.300, 0.018, {
    color: sp.webbing, surf: SURF_WEBBING, rot: [0, 0, -0.42], slot: SLOT.WEBBING,
  });

  // --- geometry + baked shading ----------------------------------------------
  const geo = b.build();

  const occluders: Occluder[] = [
    // Armpit: down from 0.60 now that the deltoid is geometrically welded into
    // the chest. At 0.60 over an actual GAP it rendered as a hard black wedge.
    { x: 0.176 * k, y: 1.400, z: 0, r: 0.140, s: 0.38 }, // armpit L
    { x: -0.176 * k, y: 1.400, z: 0, r: 0.140, s: 0.38 }, // armpit R
    // Face: eye sockets and the shadow under the nose, so the features cast
    // into the baked AO instead of relying on a flat colour band.
    { x: 0.032, y: 1.676, z: 0.072, r: 0.030, s: 0.55 },
    { x: -0.032, y: 1.676, z: 0.072, r: 0.030, s: 0.55 },
    { x: 0, y: 1.644, z: 0.084, r: 0.026, s: 0.44 },
    { x: 0, y: 1.622, z: 0.078, r: 0.026, s: 0.30 }, // under the lip
    { x: 0, y: 0.900, z: 0, r: 0.150, s: 0.52 }, // crotch
    { x: 0, y: 0.780, z: 0, r: 0.135, s: 0.34 }, // inner thigh
    { x: 0, y: 1.540, z: 0, r: 0.115, s: 0.50 }, // neck base
    { x: 0, y: 1.586, z: 0.045, r: 0.090, s: 0.46 }, // under the chin
    { x: 0.098, y: 0.500, z: -0.066, r: 0.098, s: 0.36 }, // knee back L
    { x: -0.098, y: 0.500, z: -0.066, r: 0.098, s: 0.36 }, // knee back R
    { x: 0, y: 1.086, z: 0, r: 0.170, s: 0.26 }, // belt crease
    { x: 0.098, y: 0.200, z: -0.02, r: 0.090, s: 0.32 }, // boot top L
    { x: -0.098, y: 0.200, z: -0.02, r: 0.090, s: 0.32 }, // boot top R
    { x: 0, y: 1.300, z: -(frontZ + 0.030), r: 0.170, s: 0.40 }, // pack-to-back gap
    { x: 0, y: 1.700, z: 0.010, r: 0.120, s: 0.30 }, // under the helmet
  ];

  const shelves: Shelf[] = [
    { y: 1.038, r: 0.34, depth: 0.14, s: 0.42 }, // jacket hem
    { y: 1.040, r: 0.20, depth: 0.05, s: 0.30 }, // belt line
    { y: 0.036, r: 0.32, depth: 0.05, s: 0.48 }, // ground contact under the boots
    { y: 0.268, r: 0.20, depth: 0.06, s: 0.34 }, // bloused pants over the boot
  ];
  if (vestHem > 0) {
    shelves.push({ y: vestHem, r: 0.32, depth: 0.11, s: 0.40 });
    shelves.push({ y: 1.244 - 0.059, r: 0.24, depth: 0.06, s: 0.34, cz: 0.19 }); // under the mag pouches
  }
  if (packHem > 0) shelves.push({ y: packHem, r: 0.34, depth: 0.13, s: 0.42, cz: -0.24 });
  if (brimY > 0) shelves.push({ y: brimY, r: 0.18, depth: 0.12, s: 0.56 });
  else shelves.push({ y: 1.694, r: 0.15, depth: 0.08, s: 0.30 });

  bakeShading(geo, occluders, shelves, seed & 0xffff, {
    fabric: 0.10,
    grunge: 0.11,
    // A dust TINT (a multiplier hue), not a colour to lerp toward. Cycle 2
    // lerped 34% toward a linear-0.24 tan, which raised a 0.068-luma boot to
    // ~0.32 and produced the cream boots the panel measured brighter than the
    // ground. Soiling can now only lower luma.
    dust: new THREE.Color(1.0, 0.90, 0.70),
    dustK: 0.15,
    camo: sp.civilian ? 0.55 : 1.0,
    camoSlots: [SLOT.JACKET, SLOT.PANTS, SLOT.PACK, SLOT.VEST],
  });
  geo.userData.slotLuma = slotLuma(geo);
  geo.userData.slotTarget = sp.target;
  geo.userData.clothSigma = slotVariance(geo, [SLOT.JACKET, SLOT.PANTS]);

  // Generous, pose-independent bounds: the skinned silhouette (and the corpse
  // rotation on the mesh) both leave the bind-pose sphere behind.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.5);

  // --- rig -------------------------------------------------------------------
  const bones: Record<string, THREE.Bone> = {};
  const boneList: THREE.Bone[] = [];
  for (const def of BONE_DEFS) {
    const bone = new THREE.Bone();
    bone.name = def.name;
    bone.position.set(...def.pos);
    bones[def.name] = bone;
    if (def.parent) bones[def.parent].add(bone);
    boneList.push(bone);
  }

  const mesh = new THREE.SkinnedMesh(geo, material());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.scale.setScalar(sp.scale);
  const root = new THREE.Group();
  root.add(mesh);
  mesh.add(bones.pelvis);
  mesh.bind(new THREE.Skeleton(boneList));

  const contact = makeContactShadow();
  root.add(contact);

  const rig: CharacterRig = { mesh, root, bones, seed, contact };
  poseCharacter(rig, { walkPhase: 0, speed01: 0, aimPitch: 0, crouch: 0, dead: 0 });
  return rig;
}

// ---------------------------------------------------------------------------
// Forward kinematics + ground contact solve
// ---------------------------------------------------------------------------
//
// Grounding is SOLVED, never hand-tuned. A single global Y offset per death
// variant (what shipped last cycle) lands exactly one corner of a rolled body
// on the floor and hangs everything else; and a stride that swings the leg
// without re-seating the pelvis floats both boots. Both are fixed by running
// real FK over the posed skeleton and clamping against actual contact samples.

const _fk: THREE.Matrix4[] = BONE_DEFS.map(() => new THREE.Matrix4());
const _rootM = new THREE.Matrix4();
const _localM = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Bind-world contact sample: which bone owns it, and where it sits at rest. */
type Sample = readonly [number, number, number, number]; // boneIndex, x, y, z

function fkBones(rig: CharacterRig): void {
  const m = rig.mesh;
  _rootM.compose(m.position, m.quaternion, m.scale);
  for (let i = 0; i < BONE_DEFS.length; i++) {
    const def = BONE_DEFS[i];
    const bone = rig.bones[def.name];
    _localM.compose(bone.position, bone.quaternion, bone.scale);
    _fk[i].multiplyMatrices(def.parent ? _fk[BI[def.parent]] : _rootM, _localM);
  }
}

/** World-space (root-relative) position of a bind-world sample after posing. */
function samplePos(s: Sample, out: THREE.Vector3): THREE.Vector3 {
  const def = BONE_DEFS[s[0]];
  const bind = BIND[def.name];
  return out.set(s[1] - bind.x, s[2] - bind.y, s[3] - bind.z).applyMatrix4(_fk[s[0]]);
}

function minSampleY(samples: readonly Sample[]): number {
  let lo = Infinity;
  for (const s of samples) {
    const y = samplePos(s, _v).y;
    if (y < lo) lo = y;
  }
  return lo;
}

/** Sole corners, both boots — the only points that may touch when standing. */
const SOLE_SAMPLES: Sample[] = (() => {
  const out: Sample[] = [];
  for (const [bone, sx] of [[BI.footL, 1], [BI.footR, -1]] as const) {
    for (const dz of [-0.090, 0.128]) {
      for (const dx of [-0.042, 0.042]) out.push([bone, sx * 0.098 + dx, 0.0, dz]);
    }
  }
  return out;
})();

/** Everything that can take weight when the body is on the ground. */
// A body on its side rests on ONE side's chain — down shoulder, down elbow,
// down hip, down knee, boot. Averaging both sides (or fitting a plane through
// all of it) just rolls the corpse back onto its spine, so the landing has to
// be solved against the down-side chain specifically.
// Sampled on the body's OUTER SURFACE, not on the joint centres: a shoulder
// joint sits 8cm inboard of the deltoid that actually touches the floor, a hip
// 9cm, a knee 6cm — all different, so a chain of joint centres reads level
// while the body is visibly propped up.
// The head is NOT in the chain: a body on its side is 57cm across the shoulders
// and 17cm across the skull, so the head genuinely rides ~19cm clear of the
// floor. Including it drags the fit and pitches the boots into the air.
// Neither head nor elbows are in the chain. A body on its side is 57cm across
// the shoulders and 17cm across the skull, so the head genuinely rides ~19cm
// clear; and a rifleman's elbows are folded in FRONT of the chest, not under
// it. Including either drags the fit and pitches the boots into the air. Both
// still appear in BODY_SAMPLES, so neither can sink through the ground.
const CHAIN_L: Sample[] = [
  [BI.chest, 0.278, 1.440, 0], // deltoid outer
  [BI.pelvis, 0.222, 0.950, 0.010], // hip outer
  [BI.shinL, 0.160, 0.500, 0.010], // knee outer
  [BI.footL, 0.146, 0.070, 0.050], // boot outer
];
const CHAIN_R: Sample[] = [
  [BI.chest, -0.278, 1.440, 0],
  [BI.pelvis, -0.222, 0.950, 0.010],
  [BI.shinR, -0.160, 0.500, 0.010],
  [BI.footR, -0.146, 0.070, 0.050],
];
const CHAIN_C: Sample[] = [
  [BI.head, 0, 1.795, 0],
  [BI.head, 0.088, 1.672, 0],
  [BI.head, -0.088, 1.672, 0],
  [BI.chest, 0, 1.300, 0.140],
  [BI.chest, 0, 1.300, -0.200],
  [BI.pelvis, 0, 0.920, -0.100],
  [BI.farmL, 0.268, 1.170, 0],
  [BI.farmR, -0.268, 1.170, 0],
];
const BODY_SAMPLES: Sample[] = [...CHAIN_L, ...CHAIN_R, ...CHAIN_C, ...SOLE_SAMPLES];

const GROUND_SINK = -0.008; // bury the contact by 8mm so no gap survives at 8m

// ---------------------------------------------------------------------------
// poseCharacter
// ---------------------------------------------------------------------------

export interface PoseOpts {
  walkPhase: number;
  speed01: number;
  aimPitch: number;
  crouch: number;
  dead: number;
  /** Optional: aim yaw RELATIVE to body facing. Splits across chest and head. */
  aimYaw?: number;
}

/**
 * Layered posing. The skeleton is split at `chest` (spine_02): locomotion
 * drives pelvis + spine + legs, and the aim pose is applied to chest + head +
 * arms on top, so a running bot no longer holds a frozen aim block over a
 * cycling pair of legs. Feet get an ankle-plant pass and the pelvis is then
 * re-seated from a real contact solve, so soles sit ON the ground in every
 * state instead of hovering.
 */
export function poseCharacter(rig: CharacterRig, opts: PoseOpts): void {
  const b = rig.bones;
  const m = rig.mesh;
  const s = clamp(opts.speed01, 0, 1);
  const w = opts.walkPhase;
  const cr = clamp(opts.crouch, 0, 1);
  const dead = clamp(opts.dead, 0, 1);
  const pitch = clamp(opts.aimPitch, -0.9, 0.9);
  const yaw = clamp(opts.aimYaw ?? 0, -1.9, 1.9);

  m.position.set(0, 0, 0);
  m.quaternion.identity();

  if (dead > 0) {
    poseDead(rig, dead);
    return;
  }

  // --- lower body: locomotion -------------------------------------------------
  // Stride shortens when crouched — a crouch-walk with a full stride swings a
  // leg longer than the lowered hip allows.
  const swing = Math.sin(w) * (0.32 + 0.50 * s) * s * (1 - 0.55 * cr);
  const kneeA = Math.max(0, -Math.sin(w + 0.55));
  const kneeB = Math.max(0, -Math.sin(w + 0.55 + Math.PI));
  const kneeGain = (0.30 + 0.85 * s) * s * (1 - 0.5 * cr);
  const idle = 1 - s;

  const thL = -0.12 * idle + swing - 1.04 * cr;
  const thR = 0.10 * idle - swing - 1.04 * cr;
  const shL = 0.14 * idle + kneeA * kneeGain + 1.34 * cr;
  const shR = 0.09 * idle + kneeB * kneeGain + 1.34 * cr;
  b.thighL.rotation.set(thL, 0, 0.15 * cr);
  b.thighR.rotation.set(thR, 0, -0.15 * cr);
  b.shinL.rotation.set(shL, 0, 0);
  b.shinR.rotation.set(shR, 0, 0);

  // Ankle: a real gait curve, not a plant weight.
  //
  // Cycle 3 used plant = clamp(0.40 + 0.60*stance), whose FLOOR of 0.40 drags
  // the sole toward level even in mid-swing and pins it dead level right
  // through stance — so there is no heel strike and no toe-off anywhere in the
  // cycle, which is precisely what the review sheets show (both boots flat and
  // parallel to the ground, mid-stride). The ankle now runs +0.22 rad of
  // dorsiflexion at heel strike, rolls level through mid-stance, drives -0.45
  // at toe-off, and then hangs free through swing.
  const pelvisPitch = 0.13 * s + 0.18 * cr;
  const gait = s * (1 - 0.72 * cr); // a crouch-walk keeps the sole flat
  const ankle = (phase: number, level: number): number => {
    const q = ((phase % TAU) + TAU) % TAU;
    if (q <= Math.PI) {
      // Stance: heel down -> flat -> up on the toe.
      return level + Math.cos(q) * (q < Math.PI * 0.5 ? 0.22 : 0.45);
    }
    // Swing: the foot is unloaded, so it follows the shin and only eases back
    // toward dorsiflexion as the heel comes round for the next strike.
    const t = (q - Math.PI) / Math.PI;
    return level * (0.22 + 0.40 * t) - 0.30 * (1 - t) + 0.24 * t * t;
  };
  const flatL = -(thL + shL + pelvisPitch);
  const flatR = -(thR + shR + pelvisPitch);
  b.footL.rotation.set(
    clamp(flatL + (ankle(w - Math.PI * 0.5, flatL) - flatL) * gait, -0.78, 0.78), 0, 0
  );
  b.footR.rotation.set(
    clamp(flatR + (ankle(w + Math.PI * 0.5, flatR) - flatR) * gait, -0.78, 0.78), 0, 0
  );

  // Pelvis: sway, roll, a real vertical bob at 2x stride frequency, a 3cm hip
  // DROP on the swing side, and a crouch that sits BACK as well as down (weight
  // over the front foot) rather than sinking through an invisible stool.
  // Without the drop and the counter-rotation below, a run is an ice-skater
  // glide: the torso translates and the legs cycle underneath it.
  const hipDrop = -Math.sin(w) * 0.030 * s;
  b.pelvis.position.set(
    0,
    PELVIS_Y - 0.235 * cr + Math.abs(Math.sin(w)) * 0.038 * s,
    -0.085 * cr
  );
  b.pelvis.rotation.set(
    pelvisPitch,
    -Math.sin(w) * 0.105 * s,
    Math.sin(w) * 0.070 * s + hipDrop
  );

  // spine_01 counter-rotates against the hips — the thing that makes a run read
  // as a body moving rather than a torso bolted to a leg cycle.
  b.spine.rotation.set(0.03 + 0.07 * s + 0.11 * cr, Math.sin(w) * 0.085 * s, -Math.sin(w) * 0.050 * s);

  // --- upper body: aim layer --------------------------------------------------
  // Low-ready blend: as speed rises the chest pitches forward and both upper
  // arms drop, so a running bot lowers the muzzle instead of carrying a frozen
  // aim block through a sprint. Total forward lean at full speed is ~11 deg
  // across pelvis + spine + chest.
  const lowReady = s * s;
  const chestYaw = clamp(yaw * 0.45, -0.78, 0.78) + Math.sin(w) * 0.050 * s; // shoulder counter-rotation
  const headYaw = clamp(yaw - clamp(yaw * 0.45, -0.78, 0.78), -1.22, 1.22);
  // BLADE is part of the pose, not a one-off used to solve the hold: the hands
  // and the rifle were authored through the bladed skeleton, so it has to be
  // re-applied every frame or both hands leave the weapon.
  b.chest.rotation.set(0.02 + 0.06 * s + 0.22 * lowReady + 0.10 * cr - pitch * 0.42, chestYaw + BLADE, 0);
  // The head counter-yaws MOST of the blade back out, so the figure looks where
  // it is aiming while the shoulders stay squared to the weapon — and the
  // residual leans the cheek toward the stock instead of holding the skull bolt
  // upright above the receiver.
  b.head.rotation.set(
    -pitch * 0.40 - 0.10 * s - 0.16 * lowReady + 0.04 * cr + 0.10,
    headYaw - BLADE * 0.82,
    BLADE * 0.34
  );

  const bob = Math.sin(w) * 0.050 * s;
  const carry = 0.30 * lowReady;
  // Arm counter-swing above a jog. Cycle 3 locked BOTH arms to the hold pose at
  // every speed with a +/-0.05 rad bob, so a sprinting bot was a rigid rifle
  // block over a leg cycle — and at 8-40m arm swing is the single strongest cue
  // that a silhouette is running. Past ~0.62 the support hand comes off the
  // handguard into a real counter-swing while the weapon stays in the firing
  // hand, muzzle down. It lerps back as speed drops, so nothing snaps.
  const sprint = clamp((s - 0.62) / 0.30, 0, 1) * (1 - cr);
  const swingArm = Math.sin(w) * 0.52 * sprint;
  b.uarmL.rotation.set(
    HOLD.uarmL.x + carry + bob * 0.9 + (1.05 - HOLD.uarmL.x - carry) * sprint * 0.55 - swingArm,
    HOLD.uarmL.y * (1 - sprint),
    HOLD.uarmL.z + bob * 0.35 - HOLD.uarmL.z * sprint * 0.55
  );
  b.farmL.rotation.set(
    HOLD.farmL.x - bob * 0.4 + (0.85 - HOLD.farmL.x) * sprint * 0.6,
    HOLD.farmL.y * (1 - sprint * 0.5),
    HOLD.farmL.z * (1 - sprint * 0.5)
  );
  b.uarmR.rotation.set(
    HOLD.uarmR.x + carry + bob * 0.9 + 0.34 * sprint + swingArm * 0.34,
    HOLD.uarmR.y,
    HOLD.uarmR.z - bob * 0.35
  );
  b.farmR.rotation.set(HOLD.farmR.x - bob * 0.4 - 0.24 * sprint, HOLD.farmR.y, HOLD.farmR.z);

  // --- ground contact solve ---------------------------------------------------
  fkBones(rig);
  const lo = minSampleY(SOLE_SAMPLES);
  if (isFinite(lo)) {
    b.pelvis.position.y -= (lo - GROUND_SINK) / Math.max(1e-4, m.scale.y);
    fkBones(rig);
  }
  groundContact(rig, SOLE_SAMPLES, 0.86);
}

// ---------------------------------------------------------------------------
// Contact patch placement
// ---------------------------------------------------------------------------

/**
 * Fits the contact-occlusion patch to whatever is actually touching the deck.
 * Called after the FK solve, so it reads the real posed samples rather than a
 * bind-pose guess: a crouched figure gets a tight patch, a corpse gets a long
 * one along its own body axis, and a boot at the top of a stride fades out.
 */
function groundContact(rig: CharacterRig, samples: readonly Sample[], peak: number): void {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let lift = 0, n = 0;
  for (const smp of samples) {
    samplePos(smp, _v);
    if (_v.x < minX) minX = _v.x;
    if (_v.x > maxX) maxX = _v.x;
    if (_v.z < minZ) minZ = _v.z;
    if (_v.z > maxZ) maxZ = _v.z;
    // Only samples near the deck count toward the lift average; a shoulder
    // 1.4m up is not "a foot that failed to land".
    if (_v.y < 0.55) { lift += Math.max(0, _v.y); n++; }
  }
  if (!isFinite(minX)) return;
  placeContactShadow(
    rig.contact,
    (minX + maxX) * 0.5,
    (minZ + maxZ) * 0.5,
    (maxX - minX) * 0.5,
    (maxZ - minZ) * 0.5,
    n > 0 ? lift / n : 0,
    peak
  );
}

/**
 * Death is a ROLL about Z, never a pitch about X: the rifle is welded to farmR
 * in front of the chest, so the body's forward axis has to stay horizontal or
 * the corpse ends up holding its weapon at the sky.
 *
 * Each variant is an authored slack pose — bent knees, elbows folded in,
 * asymmetric limbs — and the LANDING is then SOLVED, not hand-tuned. A body on
 * its side rests on one side's chain (down shoulder, elbow, hip, knee, boot),
 * so the solve picks the down chain, fits its height along the body's own long
 * axis with lower-envelope weighting (so a limb sticking up cannot drag the fit
 * with it), pitches the mesh to level that chain, then drops the whole body
 * until the lowest sample of all rests on the deck. The old code applied ONE
 * hand-tuned Y lift per variant, which could only ever land a single corner.
 */
function poseDead(rig: CharacterRig, t: number): void {
  const b = rig.bones;
  const m = rig.mesh;
  const e = t * t * (3 - 2 * t);
  const variant = rig.seed % 3;
  const side = variant === 1 ? -1 : 1; // twist/head-turn direction only

  // Twist stays small: after the Z roll, a Y rotation on the spine chain pitches
  // the legs vertically, which is what lifted both boots clear of the ground.
  // Per-seed asymmetric settle. Three canned variants with mirror-symmetric
  // limbs read as a knocked-over mannequin, and that symmetry is the loudest
  // "this is not a real game" cue in the set at 30m. Every joint below carries
  // its own seeded offset, so no two corpses hold the same shape and none of
  // them is symmetric. The contact solve at the end re-levels whatever this
  // produces, so the offsets cannot un-ground the body.
  const d = (salt: number, lo: number, hi: number): number =>
    lo + draw(rig.seed, salt) * (hi - lo);
  const spineCurl = d(60, 0.15, 0.40);
  const elbowL = d(61, 0.5, 1.4);
  const elbowR = d(62, 0.5, 1.4);
  const headYaw = d(63, -0.6, 0.6);
  const headRoll = d(64, -0.34, 0.34);

  b.pelvis.position.set(0, PELVIS_Y, 0);
  b.pelvis.rotation.set(0.05 + spineCurl * 0.25, side * 0.05, 0.03 * side);
  b.spine.rotation.set(-0.10 + spineCurl * 0.55, side * 0.06 + d(65, -0.10, 0.10), d(66, -0.08, 0.08));
  // BLADE again: the hands and rifle are authored through it, so a corpse whose
  // chest is un-bladed drops the weapon out of both fists.
  b.chest.rotation.set(-0.05 + spineCurl * 0.45, BLADE + side * 0.07 + d(67, -0.12, 0.12), d(68, -0.10, 0.10));
  b.head.rotation.set(0.26 - spineCurl * 0.30, -BLADE + side * 0.42 + headYaw, side * 0.12 + headRoll);
  // Arms slack but still on the weapon, so the rifle lands with the body. The
  // elbows are the loudest asymmetry available: a corpse with two straight arms
  // at matching angles is a prop.
  b.uarmL.rotation.set(HOLD.uarmL.x + d(69, 0.16, 0.52), HOLD.uarmL.y, HOLD.uarmL.z + d(70, 0.18, 0.50));
  b.farmL.rotation.set(HOLD.farmL.x * 0.5 + elbowL * 0.34, HOLD.farmL.y, HOLD.farmL.z);
  b.uarmR.rotation.set(HOLD.uarmR.x + d(71, 0.10, 0.44), HOLD.uarmR.y, HOLD.uarmR.z - d(72, 0.08, 0.34));
  b.farmR.rotation.set(HOLD.farmR.x * 0.82 + elbowR * 0.22, HOLD.farmR.y, HOLD.farmR.z);

  // Every variant falls onto the LEFT side. That is not cosmetic: the support
  // arm reaches ACROSS the chest so its elbow tucks inboard, while the firing
  // arm's elbow flares outboard on a pole vector. Rolling right lands the body
  // on that outboard elbow and props the whole corpse 12cm off the deck; rolling
  // left tucks it and leaves the weapon on top where it can be seen.
  //
  // Leg splay is authored on thigh/shin X only. After the roll a thigh Z
  // rotation is VERTICAL, so it drives a boot below the resting chain and the
  // body ends up balanced on one foot.
  // Knee flexion is seeded on top of every variant: 0.30-1.10 rad extra, split
  // unevenly between the legs, so no corpse holds two straight legs in a
  // symmetric V. Splay stays on thigh/shin X only — after the roll a thigh Z
  // rotation is VERTICAL and drives a boot below the resting chain.
  const kneeL = d(73, 0.30, 1.10);
  const kneeR = d(74, 0.30, 1.10);
  const hipL = d(75, -0.22, 0.18);
  const hipR = d(76, -0.22, 0.18);
  let roll: number;
  if (variant === 0) {
    // Dropped straight down, lead leg folded, trailing leg long.
    b.thighL.rotation.set(-0.42 + hipL, 0, 0.05);
    b.thighR.rotation.set(0.22 + hipR, 0, 0.04);
    b.shinL.rotation.set(0.50 + kneeL, 0, 0);
    b.shinR.rotation.set(0.12 + kneeR * 0.45, 0, 0);
    b.footL.rotation.set(-0.28 + d(77, -0.16, 0.16), 0, 0);
    b.footR.rotation.set(-0.08 + d(78, -0.16, 0.16), 0, 0);
    roll = -1.42;
  } else if (variant === 1) {
    // Crumpled, knees drawn up toward the chest.
    b.thighL.rotation.set(-0.86 + hipL, 0, 0.05);
    b.thighR.rotation.set(-0.48 + hipR, 0, 0.04);
    b.shinL.rotation.set(0.86 + kneeL * 0.55, 0, 0);
    b.shinR.rotation.set(0.44 + kneeR, 0, 0);
    b.footL.rotation.set(-0.36 + d(77, -0.16, 0.16), 0, 0);
    b.footR.rotation.set(-0.26 + d(78, -0.16, 0.16), 0, 0);
    roll = -1.56;
  } else {
    // Rolled further onto the chest, one leg trailing wide behind.
    b.thighL.rotation.set(-0.30 + hipL, 0, 0.06);
    b.thighR.rotation.set(0.46 + hipR, 0, 0.05);
    b.shinL.rotation.set(0.34 + kneeL, 0, 0);
    b.shinR.rotation.set(0.06 + kneeR * 0.40, 0, 0);
    b.footL.rotation.set(-0.22 + d(77, -0.16, 0.16), 0, 0);
    b.footR.rotation.set(-0.04 + d(78, -0.16, 0.16), 0, 0);
    roll = -1.74;
  }

  m.position.set(0, 0, 0);
  m.rotation.set(0, 0, roll * e);

  if (e < 0.02) {
    fkBones(rig);
    groundContact(rig, SOLE_SAMPLES, 0.86);
    return;
  }
  levelOnGround(rig, e);
  // A corpse gets a long soft patch fitted to the body's own footprint. Without
  // it a body lying on a flat plane at 18m has no depth cue at all and reads as
  // suspended in mid-air — which is exactly what the panel reported, on bodies
  // the contact report measured as resting within 4cm.
  groundContact(rig, BODY_SAMPLES, 0.74);
}

const _pHead = new THREE.Vector3();
const _pFoot = new THREE.Vector3();
const _u = new THREE.Vector3();

/** Which side is underneath, by mean sample height. */
function downChain(): Sample[] {
  let sl = 0, sr = 0;
  for (let i = 0; i < CHAIN_L.length; i++) {
    sl += samplePos(CHAIN_L[i], _v).y;
    sr += samplePos(CHAIN_R[i], _v).y;
  }
  return sl <= sr ? CHAIN_L : CHAIN_R;
}

/**
 * Pitches the mesh until the down-side contact chain lies flat, then drops it
 * onto the deck. The fit is re-weighted twice toward the LOWER envelope so a
 * raised knee or a cocked elbow cannot tip the whole body.
 */
function levelOnGround(rig: CharacterRig, e: number): void {
  const m = rig.mesh;
  for (let pass = 0; pass < 3; pass++) {
    fkBones(rig);
    const chain = downChain();
    samplePos(chain[0], _pHead);
    samplePos(chain[chain.length - 1], _pFoot);
    _u.set(_pFoot.x - _pHead.x, 0, _pFoot.z - _pHead.z);
    if (_u.lengthSq() < 1e-6) _u.set(1, 0, 0);
    _u.normalize();

    const ts: number[] = [];
    const ys: number[] = [];
    for (const smp of chain) {
      samplePos(smp, _v);
      ts.push(_v.x * _u.x + _v.z * _u.z);
      ys.push(_v.y);
    }
    let a = 0, slope = 0;
    for (let it = 0; it < 3; it++) {
      let sw = 0, st = 0, sy = 0, stt = 0, sty = 0;
      for (let i = 0; i < ts.length; i++) {
        // Iteration 0 is unweighted; after that, points sitting above the line
        // lose influence, so the fit settles on the resting profile.
        const w = it === 0 ? 1 : Math.exp(-Math.max(0, ys[i] - (a + slope * ts[i])) / 0.09);
        sw += w; st += w * ts[i]; sy += w * ys[i];
        stt += w * ts[i] * ts[i]; sty += w * ts[i] * ys[i];
      }
      const den = sw * stt - st * st;
      if (Math.abs(den) < 1e-9) break;
      slope = (sw * sty - st * sy) / den;
      a = (sy - slope * st) / sw;
    }
    const ang = Math.atan(slope) * e;
    if (Math.abs(ang) < 2e-4) break;
    _axis.crossVectors(_u, UP).normalize();
    _q.setFromAxisAngle(_axis, -ang);
    m.quaternion.premultiply(_q);
  }

  fkBones(rig);
  const lo = minSampleY(BODY_SAMPLES);
  if (isFinite(lo)) m.position.y = -lo + GROUND_SINK;
}

/**
 * Value-ladder audit over N seeds. Cycle 2 shipped an "enforced value ladder"
 * whose boots and rifle measured BRIGHTER than the ground on some seeds, and
 * nothing caught it because nothing measured it. This walks the merged vertex
 * colours per palette slot and asserts two things the eye actually reads:
 *
 *  1. every slot's mean sRGB luma stays within a ratio band of its authored
 *     toneAt() target (shade() variants live inside the band; a slot that
 *     inherited skin or jacket tone does not);
 *  2. the ORDERING holds — boots and the weapon are darker than the trousers,
 *     which are darker than the jacket. Nothing on a PUBG character is brighter
 *     than the field it stands on, and the boots/pack/vest are the dark anchors
 *     of the silhouette.
 *
 * Returns one row per violation; an empty array means the ladder held.
 */
export function auditValueLadder(
  seeds: number[]
): Array<{ seed: number; slot: string; got: number; want: number; why: string }> {
  const out: Array<{ seed: number; slot: string; got: number; want: number; why: string }> = [];
  for (const seed of seeds) {
    const rig = buildCharacter(seed);
    const geo = rig.mesh.geometry;
    const got = geo.userData.slotLuma as Record<string, number>;
    const want = geo.userData.slotTarget as Record<string, number>;
    for (const slot of Object.keys(want)) {
      const g = got[slot];
      if (g === undefined) continue;
      const ratio = g / Math.max(1e-4, want[slot]);
      // Baked AO + dust pull the mean down; camo and shade() variants spread it.
      // Anything outside 0.45-1.35x is a slot wearing the wrong palette entry.
      if (ratio < 0.45 || ratio > 1.35) {
        out.push({ seed, slot, got: g, want: want[slot], why: `ratio ${ratio.toFixed(2)}` });
      }
    }
    // --- "is this torso actually clothed" gate -------------------------------
    // Measured on the BAKED vertex colours, not on the authored palette, so it
    // sees what the frame sees. Two cycles running, the panel's loudest single
    // finding was that most of the squad looked shirtless — and both times the
    // trunk was in fact covered by a jacket whose hue and value were its own
    // wearer's skin. Nothing measured that, so nothing caught it.
    const jm = slotMeanColor(geo, SLOT.JACKET);
    const sm = slotMeanColor(geo, SLOT.SKIN);
    if (jm && sm) {
      const dist = chromaDist(jm, sm);
      if (dist < 0.040) {
        out.push({
          seed, slot: 'JACKET', got: +dist.toFixed(4), want: 0.040,
          why: 'torso chromaticity is the wearer\'s own skin — reads as bare',
        });
      }
    }
    const order: Array<[string, string]> = [
      ['BOOT', 'PANTS'], ['VEST', 'PANTS'], ['METAL', 'JACKET'],
      ['GUNWOOD', 'JACKET'], ['PANTS', 'JACKET'], ['PACK', 'JACKET'],
    ];
    for (const [dark, light] of order) {
      if (got[dark] === undefined || got[light] === undefined) continue;
      if (got[dark] >= got[light]) {
        out.push({
          seed, slot: dark, got: got[dark], want: got[light],
          why: `${dark} is not darker than ${light}`,
        });
      }
    }
    geo.dispose();
    (rig.contact.material as THREE.Material).dispose();
  }
  return out;
}

/** Mean BAKED vertex colour of one palette slot, or null if the slot is empty. */
function slotMeanColor(geo: THREE.BufferGeometry, slot: number): THREE.Color | null {
  const col = geo.getAttribute('color');
  const slots = geo.userData.slot as Uint8Array | undefined;
  if (!slots) return null;
  let n = 0, r = 0, g = 0, b2 = 0;
  for (let i = 0; i < col.count; i++) {
    if (slots[i] !== slot) continue;
    n++; r += col.getX(i); g += col.getY(i); b2 += col.getZ(i);
  }
  return n > 8 ? new THREE.Color(r / n, g / n, b2 / n) : null;
}

/** Per-figure cloth albedo spread — the "is there any pattern at all" probe. */
export function clothSigma(rig: CharacterRig): number {
  return (rig.mesh.geometry.userData.clothSigma as number) ?? 0;
}

/**
 * Mechanical grounding report for the lane's review harness: how many contact
 * samples actually rest on the deck, not just the single lowest one. minY alone
 * certified a corpse as grounded while most of it was airborne.
 */
export function contactReport(rig: CharacterRig): {
  minY: number; contacts: number; spread: number; worst: number; downMax: number;
} {
  rig.mesh.updateMatrixWorld(true);
  fkBones(rig);
  let lo = Infinity, hi = -Infinity, contacts = 0;
  for (const smp of BODY_SAMPLES) {
    const y = samplePos(smp, _v).y;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
    if (y < 0.045) contacts++;
  }
  const soleLo = minSampleY(SOLE_SAMPLES);
  // How high the WORST link of the resting chain sits. A corpse balanced on one
  // shoulder corner passes a minY check and fails this one.
  const chain = downChain();
  let downMax = -Infinity;
  for (const smp of chain) downMax = Math.max(downMax, samplePos(smp, _v).y);
  return {
    minY: +lo.toFixed(4),
    contacts,
    spread: +(hi - lo).toFixed(3),
    worst: +soleLo.toFixed(4),
    downMax: +downMax.toFixed(4),
  };
}
