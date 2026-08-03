import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { generateBuilding, type BuildingKind } from '../gen/buildinggen';
import { hash2 } from '../gen/noise';
import type { Heightfield } from '../gen/terraingen';
import type { TextureFactory } from '../gen/texgen';
import type { PhysicsWorld } from '../player/physics';
import { plasterRecipe, roofMetalRecipe, woodPlankRecipe } from '../materials/buildings';

// Village + farm placement. All buildings merge into 3 draw calls (plaster /
// roof metal / wood). 90-degree rotations only, so colliders stay AABBs.

interface Placement {
  kind: BuildingKind;
  x: number;
  z: number;
  /** Quarter-turns (0-3). */
  rot: number;
  seed: number;
}

export interface BuiltWorld {
  group: THREE.Group;
  lootSpots: THREE.Vector3[];
}

function rotate90(v: THREE.Vector3, quarter: number): THREE.Vector3 {
  const q = ((quarter % 4) + 4) % 4;
  let { x, z } = v;
  for (let i = 0; i < q; i++) {
    const nx = -z;
    z = x;
    x = nx;
  }
  return new THREE.Vector3(x, v.y, z);
}

export function buildSettlements(
  hf: Heightfield,
  factory: TextureFactory,
  physics: PhysicsWorld
): BuiltWorld {
  const placements: Placement[] = [];

  // Village: rows either side of the coastal road around the plateau (x 0..220,
  // road z ~90-110). Houses face the road (rot 0 faces +Z == south toward road
  // when north of it; rot 2 when south of it).
  let salt = 11;
  for (let i = 0; i < 9; i++) {
    salt++;
    const x = -40 + i * 32 + (hash2(salt, 1) - 0.5) * 10;
    const roadZ = 90 + (x > 0 ? (x / 180) * 20 : 0);
    const north = hash2(salt, 2) > 0.45;
    const z = roadZ + (north ? -1 : 1) * (16 + hash2(salt, 3) * 14);
    const kind: BuildingKind = hash2(salt, 4) > 0.72 ? 'house2' : 'house';
    placements.push({ kind, x, z, rot: north ? 0 : 2, seed: salt * 101 });
    // Yard shed for some.
    if (hash2(salt, 5) > 0.5) {
      placements.push({
        kind: 'shed',
        x: x + (hash2(salt, 6) - 0.5) * 18,
        z: z + (north ? -1 : 1) * (10 + hash2(salt, 7) * 6),
        rot: Math.floor(hash2(salt, 8) * 4),
        seed: salt * 313,
      });
    }
  }
  // Farm compounds along the north spur and east track.
  const farmAnchors: [number, number][] = [
    [-70, -120], [-150, -290], [300, -20], [440, -130], [-320, 40],
  ];
  for (const [ax, az] of farmAnchors) {
    salt += 7;
    placements.push({ kind: 'barn', x: ax, z: az, rot: Math.floor(hash2(salt, 1) * 4), seed: salt * 71 });
    placements.push({
      kind: hash2(salt, 2) > 0.5 ? 'house' : 'shed',
      x: ax + 14 + hash2(salt, 3) * 10,
      z: az + (hash2(salt, 4) - 0.5) * 24,
      rot: Math.floor(hash2(salt, 5) * 4),
      seed: salt * 37,
    });
  }

  const plasterGeos: THREE.BufferGeometry[] = [];
  const roofGeos: THREE.BufferGeometry[] = [];
  const woodGeos: THREE.BufferGeometry[] = [];
  const lootSpots: THREE.Vector3[] = [];

  for (const p of placements) {
    // Skip slopes and wet ground — buildings need a plausible pad.
    if (!hf.walkable(p.x, p.z) || hf.slope(p.x, p.z) > 0.12) continue;
    const y = hf.height(p.x, p.z) + 0.02;
    const pieces = generateBuilding(p.kind, p.seed);
    const rotY = (p.rot * Math.PI) / 2;

    const place = (geos: THREE.BufferGeometry[], target: THREE.BufferGeometry[]) => {
      for (const g of geos) {
        const c = g.clone();
        c.rotateY(rotY);
        c.translate(p.x, y, p.z);
        target.push(c);
      }
    };
    place(pieces.plaster, plasterGeos);
    place(pieces.roof, roofGeos);
    place(pieces.wood, woodGeos);

    for (const col of pieces.colliders) {
      // Rotate the 8 corners, take min/max (safe for quarter turns).
      const corners = [
        new THREE.Vector3(col.min.x, col.min.y, col.min.z),
        new THREE.Vector3(col.max.x, col.min.y, col.min.z),
        new THREE.Vector3(col.min.x, col.min.y, col.max.z),
        new THREE.Vector3(col.max.x, col.min.y, col.max.z),
      ].map((v) => rotate90(v, p.rot));
      const min = new THREE.Vector3(Infinity, col.min.y, Infinity);
      const max = new THREE.Vector3(-Infinity, col.max.y, -Infinity);
      for (const v of corners) {
        min.x = Math.min(min.x, v.x);
        min.z = Math.min(min.z, v.z);
        max.x = Math.max(max.x, v.x);
        max.z = Math.max(max.z, v.z);
      }
      min.add(new THREE.Vector3(p.x, y, p.z));
      max.add(new THREE.Vector3(p.x, y, p.z));
      physics.addBox(min, max, 'building');
    }
    for (const spot of pieces.lootSpots) {
      lootSpots.push(rotate90(spot, p.rot).add(new THREE.Vector3(p.x, y, p.z)));
    }
  }

  const group = new THREE.Group();
  const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material) => {
    if (geos.length === 0) return;
    // Mixed indexed (Box) and non-indexed (Extrude) sources: unify first.
    const prepared = geos.map((g) => (g.index ? g.toNonIndexed() : g));
    const merged = mergeGeometries(prepared, false);
    for (const g of geos) g.dispose();
    for (const g of prepared) g.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  const plasterMat = factory.standard(plasterRecipe, { envMapIntensity: 0.5 });
  const roofMat = factory.standard(roofMetalRecipe, { envMapIntensity: 0.7 });
  const woodMat = factory.standard(woodPlankRecipe, { envMapIntensity: 0.45 });
  addMerged(plasterGeos, plasterMat);
  addMerged(roofGeos, roofMat);
  addMerged(woodGeos, woodMat);

  return { group, lootSpots };
}
