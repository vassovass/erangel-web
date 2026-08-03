import * as THREE from 'three';
import { hash2 } from './noise';

// Code-built humanoid: one SkinnedMesh per bot (single draw call each), boxes
// bound 1:1 to a 10-bone skeleton, clothing variation via vertex colors.
// The characters-visual stream (10) owns beautification; proportions and rig
// names are the contract: pelvis, spine, head, uarmL/R, farmL/R, thighL/R, shinL/R.

export interface CharacterRig {
  mesh: THREE.SkinnedMesh;
  root: THREE.Group;
  bones: Record<string, THREE.Bone>;
}

interface BonePart {
  name: string;
  parent: string | null;
  pos: [number, number, number];       // offset from parent
  box: [number, number, number];       // geometry size
  boxOffset: [number, number, number]; // geometry centre relative to bone
  color: 'skin' | 'shirt' | 'pants' | 'boots' | 'gear';
}

const PARTS: BonePart[] = [
  { name: 'pelvis', parent: null, pos: [0, 0.98, 0], box: [0.34, 0.18, 0.22], boxOffset: [0, 0.02, 0], color: 'pants' },
  { name: 'spine', parent: 'pelvis', pos: [0, 0.16, 0], box: [0.36, 0.42, 0.24], boxOffset: [0, 0.22, 0], color: 'shirt' },
  { name: 'head', parent: 'spine', pos: [0, 0.5, 0], box: [0.2, 0.24, 0.22], boxOffset: [0, 0.14, 0], color: 'skin' },
  { name: 'uarmL', parent: 'spine', pos: [0.24, 0.42, 0], box: [0.11, 0.3, 0.12], boxOffset: [0.02, -0.14, 0], color: 'shirt' },
  { name: 'uarmR', parent: 'spine', pos: [-0.24, 0.42, 0], box: [0.11, 0.3, 0.12], boxOffset: [-0.02, -0.14, 0], color: 'shirt' },
  { name: 'farmL', parent: 'uarmL', pos: [0.02, -0.3, 0], box: [0.09, 0.28, 0.1], boxOffset: [0, -0.13, 0], color: 'skin' },
  { name: 'farmR', parent: 'uarmR', pos: [-0.02, -0.3, 0], box: [0.09, 0.28, 0.1], boxOffset: [0, -0.13, 0], color: 'skin' },
  { name: 'thighL', parent: 'pelvis', pos: [0.1, -0.06, 0], box: [0.14, 0.42, 0.16], boxOffset: [0, -0.2, 0], color: 'pants' },
  { name: 'thighR', parent: 'pelvis', pos: [-0.1, -0.06, 0], box: [0.14, 0.42, 0.16], boxOffset: [0, -0.2, 0], color: 'pants' },
  { name: 'shinL', parent: 'thighL', pos: [0, -0.42, 0], box: [0.12, 0.42, 0.14], boxOffset: [0, -0.21, 0.01], color: 'boots' },
  { name: 'shinR', parent: 'thighR', pos: [0, -0.42, 0], box: [0.12, 0.42, 0.14], boxOffset: [0, -0.21, 0.01], color: 'boots' },
];

const SKIN_TONES = [0xc9a27c, 0xa87c58, 0x8a5f42, 0xdbb18d];
const SHIRT_TONES = [0x4a5d43, 0x6b5b4a, 0x3d4a5c, 0x5c4a3d, 0x2f3b33, 0x6e3d3a];
const PANT_TONES = [0x3a3f45, 0x4a453a, 0x33383d, 0x453a33];

let sharedMaterial: THREE.MeshStandardMaterial | null = null;

function material(): THREE.MeshStandardMaterial {
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.0,
      envMapIntensity: 0.4,
    });
  }
  return sharedMaterial;
}

export function buildCharacter(seed: number): CharacterRig {
  const bones: Record<string, THREE.Bone> = {};
  const boneList: THREE.Bone[] = [];
  for (const part of PARTS) {
    const b = new THREE.Bone();
    b.name = part.name;
    b.position.set(...part.pos);
    bones[part.name] = b;
    if (part.parent) bones[part.parent].add(b);
    boneList.push(b);
  }

  const skinTone = new THREE.Color(SKIN_TONES[Math.floor(hash2(seed, 1) * SKIN_TONES.length)]);
  const shirtTone = new THREE.Color(SHIRT_TONES[Math.floor(hash2(seed, 2) * SHIRT_TONES.length)]);
  const pantTone = new THREE.Color(PANT_TONES[Math.floor(hash2(seed, 3) * PANT_TONES.length)]);
  const bootTone = new THREE.Color(0x2a2622);
  const gearTone = new THREE.Color(0x5a5347);
  const tones = { skin: skinTone, shirt: shirtTone, pants: pantTone, boots: bootTone, gear: gearTone };

  // Merge one box per bone into a single skinned geometry.
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const indices: number[] = [];

  PARTS.forEach((part, boneIdx) => {
    const boxGeo = new THREE.BoxGeometry(...part.box);
    boxGeo.translate(...part.boxOffset);
    // Transform into bind pose: accumulate parent offsets.
    let wx = 0, wy = 0, wz = 0;
    let cur: BonePart | undefined = part;
    while (cur) {
      wx += cur.pos[0];
      wy += cur.pos[1];
      wz += cur.pos[2];
      cur = PARTS.find((p) => p.name === cur!.parent);
    }
    boxGeo.translate(wx, wy, wz);

    const posAttr = boxGeo.getAttribute('position');
    const normAttr = boxGeo.getAttribute('normal');
    const idxAttr = boxGeo.getIndex()!;
    const base = positions.length / 3;
    const tone = tones[part.color];
    // Slight per-face shade variation so the boxes don't read flat.
    for (let i = 0; i < posAttr.count; i++) {
      positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      normals.push(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
      const shade = 0.9 + hash2(seed + boneIdx, i >> 2) * 0.2;
      colors.push(tone.r * shade, tone.g * shade, tone.b * shade);
      skinIndices.push(boneIdx, 0, 0, 0);
      skinWeights.push(1, 0, 0, 0);
    }
    for (let i = 0; i < idxAttr.count; i++) indices.push(base + idxAttr.getX(i));
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geo.setIndex(indices);
  geo.computeBoundingSphere();

  const mesh = new THREE.SkinnedMesh(geo, material());
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  const skeleton = new THREE.Skeleton(boneList);
  const root = new THREE.Group();
  root.add(bones.pelvis);
  mesh.add(bones.pelvis);
  mesh.bind(skeleton);
  root.add(mesh);

  return { mesh, root, bones };
}

/**
 * Procedural locomotion/aim/death posing. phase advances with distance,
 * aimPitch tilts the spine, death rotates the whole rig.
 */
export function poseCharacter(
  rig: CharacterRig,
  opts: { walkPhase: number; speed01: number; aimPitch: number; crouch: number; dead: number }
): void {
  const { bones } = rig;
  const s = opts.speed01;
  const w = opts.walkPhase;

  const legSwing = Math.sin(w) * 0.7 * s;
  bones.thighL.rotation.x = legSwing;
  bones.thighR.rotation.x = -legSwing;
  bones.shinL.rotation.x = Math.max(0, -Math.sin(w + 0.6)) * 0.9 * s;
  bones.shinR.rotation.x = Math.max(0, Math.sin(w - 0.6 + Math.PI)) * 0.9 * s;

  // Arms: right holds weapon forward, left swings slightly.
  bones.uarmR.rotation.x = -1.15 + Math.sin(w) * 0.06 * s;
  bones.farmR.rotation.x = -0.55;
  bones.uarmL.rotation.x = -1.0 - Math.sin(w) * 0.08 * s;
  bones.farmL.rotation.x = -0.9;

  bones.spine.rotation.x = opts.aimPitch * 0.5 + s * 0.08;
  bones.head.rotation.x = opts.aimPitch * 0.4;
  bones.pelvis.position.y = 0.98 - opts.crouch * 0.32 + Math.abs(Math.sin(w)) * 0.03 * s;
  bones.thighL.rotation.x += opts.crouch * -0.9;
  bones.thighR.rotation.x += opts.crouch * -0.9;
  bones.shinL.rotation.x += opts.crouch * 1.1;
  bones.shinR.rotation.x += opts.crouch * 1.1;

  if (opts.dead > 0) {
    rig.root.rotation.x = -Math.PI / 2 * Math.min(1, opts.dead * 2.2);
    rig.root.position.y = -0.85 * Math.min(1, opts.dead * 2.2);
  }
}
