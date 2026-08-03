import * as THREE from 'three';
import { hash2 } from '../gen/noise';
import type { Heightfield } from '../gen/terraingen';

// Ground loot: colour-coded crates, one InstancedMesh per type (3 draw calls).
// Deterministic spawns along roads and the village plateau until the building
// stream provides interiors to seed into.

export type LootType = 'ammo' | 'medkit' | 'bandage';

export interface LootItem {
  type: LootType;
  pos: THREE.Vector3;
  taken: boolean;
  index: number; // instance index within its type mesh
}

const COUNTS: Record<LootType, number> = { ammo: 34, medkit: 12, bandage: 22 };
const COLORS: Record<LootType, number> = { ammo: 0xd9a12b, medkit: 0x3fa66a, bandage: 0x7fa8c9 };
const SIZE: Record<LootType, [number, number, number]> = {
  ammo: [0.34, 0.2, 0.22],
  medkit: [0.36, 0.26, 0.3],
  bandage: [0.22, 0.14, 0.18],
};

export class LootField {
  readonly group = new THREE.Group();
  readonly items: LootItem[] = [];
  private meshes = new Map<LootType, THREE.InstancedMesh>();
  private dummy = new THREE.Object3D();
  private time = 0;

  constructor(hf: Heightfield, interiorSpots: THREE.Vector3[] = []) {
    // Interior spots get first claim — buildings are where loot belongs.
    const spotPool = [...interiorSpots];
    let salt = 0;
    for (const type of Object.keys(COUNTS) as LootType[]) {
      const count = COUNTS[type];
      const geo = new THREE.BoxGeometry(...SIZE[type]);
      const mat = new THREE.MeshStandardMaterial({
        color: COLORS[type],
        roughness: 0.5,
        metalness: 0.15,
        emissive: COLORS[type],
        emissiveIntensity: 0.22,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.castShadow = true;
      this.meshes.set(type, mesh);
      this.group.add(mesh);

      let placed = 0;
      let attempt = 0;
      while (placed < count && attempt < count * 40) {
        attempt++;
        salt++;
        let pos: THREE.Vector3;
        if (spotPool.length > 0 && hash2(salt, 5) > 0.35) {
          const idx = Math.floor(hash2(salt, 31) * spotPool.length);
          const spot = spotPool.splice(idx, 1)[0];
          pos = spot.clone();
          pos.y += SIZE[type][1] / 2;
        } else {
          // Cluster near roads (village plateau is roaddist-small too).
          const x = (hash2(salt, 11) - 0.5) * 1000;
          const z = (hash2(salt, 23) - 0.5) * 1000;
          if (!hf.walkable(x, z)) continue;
          if (hf.roadDistance(x, z) > 60) continue;
          pos = new THREE.Vector3(x, hf.height(x, z) + SIZE[type][1] / 2 + 0.02, z);
        }
        this.items.push({ type, pos, taken: false, index: placed });
        this.dummy.position.copy(pos);
        this.dummy.rotation.y = hash2(salt, 7) * Math.PI;
        this.dummy.updateMatrix();
        mesh.setMatrixAt(placed, this.dummy.matrix);
        placed++;
      }
      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Nearest untaken item within radius of a position, or null. */
  nearest(pos: THREE.Vector3, radius = 2.2): LootItem | null {
    let best: LootItem | null = null;
    let bestD = radius * radius;
    for (const item of this.items) {
      if (item.taken) continue;
      const d = item.pos.distanceToSquared(pos);
      if (d < bestD) {
        bestD = d;
        best = item;
      }
    }
    return best;
  }

  take(item: LootItem): void {
    item.taken = true;
    // Hide instance by scaling to zero.
    this.dummy.position.copy(item.pos);
    this.dummy.scale.setScalar(0.0001);
    this.dummy.updateMatrix();
    const mesh = this.meshes.get(item.type)!;
    mesh.setMatrixAt(item.index, this.dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Gentle bob/pulse so items catch the eye. */
  update(dt: number): void {
    this.time += dt;
    for (const [, mesh] of this.meshes) {
      const m = mesh.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.18 + Math.sin(this.time * 2.4) * 0.08;
    }
  }
}
