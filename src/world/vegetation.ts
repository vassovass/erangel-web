import * as THREE from 'three';
import { NoiseField, hash2 } from '../gen/noise';
import { MAP_SIZE, type Heightfield } from '../gen/terraingen';
import { makeGrassClumpTexture, makeFoliageTexture, treeGeometry } from '../gen/treegen';
import { quality } from '../core/settings';
import type { PhysicsWorld } from '../player/physics';
import type { System } from '../core/engine';

// Vegetation: camera-local instanced grass clumps (cylindrical billboards,
// wind-swayed, splat-driven density) + statically instanced trees in two
// species. Five draw calls total for everything green above the terrain.

const CELL = 32;
const GRID = 5;                 // 5x5 cells around the camera
const CLUMPS_PER_CELL = 340;    // before density rejection
const MASK_RES = 256;

class VegetationMask {
  readonly grass = new Uint8Array(MASK_RES * MASK_RES);
  readonly forest = new Uint8Array(MASK_RES * MASK_RES);

  constructor(hf: Heightfield, seed: number) {
    const forestNoise = new NoiseField(seed + 707);
    const step = MAP_SIZE / MASK_RES;
    let p = 0;
    for (let j = 0; j < MASK_RES; j++) {
      for (let i = 0; i < MASK_RES; i++) {
        const x = -MAP_SIZE / 2 + (i + 0.5) * step;
        const z = -MAP_SIZE / 2 + (j + 0.5) * step;
        const h = hf.height(x, z);
        const slope = hf.slope(x, z);
        const road = hf.roadDistance(x, z);
        let g = 1;
        if (h < 2.2 || h > 55) g = 0;
        else {
          g *= Math.min(1, Math.max(0, (0.3 - slope) / 0.3));
          g *= Math.min(1, Math.max(0, (road - 5.5) / 6));
        }
        this.grass[p] = Math.round(g * 255);

        let f = 0;
        if (h > 3 && h < 46 && slope < 0.24 && road > 14) {
          const n = forestNoise.warped(x / 260 + 3.1, z / 260 - 7.7, 0.8, { octaves: 3 });
          f = n > 0.34 ? Math.min(1, (n - 0.34) * 4) : 0;
        }
        this.forest[p] = Math.round(f * 255);
        p++;
      }
    }
  }

  sample(arr: Uint8Array, x: number, z: number): number {
    const i = Math.floor(((x + MAP_SIZE / 2) / MAP_SIZE) * MASK_RES);
    const j = Math.floor(((z + MAP_SIZE / 2) / MAP_SIZE) * MASK_RES);
    if (i < 0 || j < 0 || i >= MASK_RES || j >= MASK_RES) return 0;
    return arr[j * MASK_RES + i] / 255;
  }
}

export class Vegetation implements System {
  readonly group = new THREE.Group();
  private grassMesh: THREE.InstancedMesh;
  private grassMat: THREE.ShaderMaterial;
  private mask: VegetationMask;
  private lastCellX = 1e9;
  private lastCellZ = 1e9;
  private dummy = new THREE.Object3D();

  constructor(
    private hf: Heightfield,
    private camera: THREE.PerspectiveCamera,
    physics: PhysicsWorld,
    seed: number
  ) {
    this.mask = new VegetationMask(hf, seed);

    // --- Grass ---
    const clumpTex = makeGrassClumpTexture(seed + 11);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0); // pivot at root
    const capacity = GRID * GRID * CLUMPS_PER_CELL;
    this.grassMat = new THREE.ShaderMaterial({
      transparent: false,
      side: THREE.DoubleSide,
      fog: true,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uMap: { value: clumpTex },
        uTime: { value: 0 },
        uSunTint: { value: new THREE.Color(1.06, 1.0, 0.9) },
        uFadeRadius: { value: quality.grassRadius },
      },
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        uniform float uTime;
        uniform float uFadeRadius;
        attribute float aRand;
        varying vec2 vUv;
        varying float vShade;
        void main() {
          vUv = uv;
          vec3 instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float scale = instanceMatrix[0][0];
          float dist = distance(cameraPosition.xz, instPos.xz);
          float fade = 1.0 - smoothstep(uFadeRadius * 0.72, uFadeRadius, dist);
          float w = scale * fade;
          // Cylindrical billboard.
          vec3 toCam = cameraPosition - instPos;
          vec2 fwd = normalize(toCam.xz + vec2(1e-4));
          vec2 right = vec2(fwd.y, -fwd.x);
          // Wind: tip-weighted sway, two frequencies, per-clump phase.
          float sway = sin(uTime * 1.7 + aRand * 6.283 + instPos.x * 0.33 + instPos.z * 0.27) * 0.09
                     + sin(uTime * 3.9 + aRand * 12.0 + instPos.z * 0.5) * 0.035;
          vec3 wpos = instPos;
          wpos.xz += right * (position.x * w * 1.05);
          wpos.y += position.y * w * (0.85 + aRand * 0.4);
          wpos.xz += fwd * 0.0 + vec2(sway, sway * 0.7) * position.y * w;
          vShade = 0.62 + 0.38 * uv.y + aRand * 0.08;
          vec4 mvPosition = viewMatrix * vec4(wpos, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>
        uniform sampler2D uMap;
        uniform vec3 uSunTint;
        varying vec2 vUv;
        varying float vShade;
        void main() {
          vec4 tex = texture2D(uMap, vUv);
          if (tex.a < 0.42) discard;
          vec3 col = tex.rgb * vShade * uSunTint;
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.grassMesh = new THREE.InstancedMesh(geo, this.grassMat, capacity);
    this.grassMesh.frustumCulled = false;
    this.grassMesh.castShadow = false;
    this.grassMesh.receiveShadow = false;
    const rands = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) rands[i] = hash2(i, 999);
    geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rands, 1));
    this.group.add(this.grassMesh);

    // --- Trees ---
    this.plantTrees(physics, seed);
  }

  private plantTrees(physics: PhysicsWorld, seed: number): void {
    interface Placed {
      x: number; z: number; y: number; s: number; seed: number;
    }
    const bySpecies: Record<'broadleaf' | 'pine', Placed[]> = { broadleaf: [], pine: [] };
    const spacing = 7.5;
    const jitter = 5.0;
    let count = 0;
    for (let gz = 0; gz < MAP_SIZE / spacing && count < 640; gz++) {
      for (let gx = 0; gx < MAP_SIZE / spacing && count < 640; gx++) {
        const bx = -MAP_SIZE / 2 + gx * spacing;
        const bz = -MAP_SIZE / 2 + gz * spacing;
        const f = this.mask.sample(this.mask.forest, bx, bz);
        if (f < 0.25) continue;
        const r = hash2(gx, gz, seed + 31);
        if (r > f * 0.9) continue;
        const x = bx + (hash2(gx, gz, seed + 37) - 0.5) * jitter;
        const z = bz + (hash2(gx, gz, seed + 41) - 0.5) * jitter;
        const y = this.hf.height(x, z);
        const species: 'broadleaf' | 'pine' = hash2(gx, gz, seed + 43) > 0.42 ? 'broadleaf' : 'pine';
        bySpecies[species].push({ x, z, y, s: 0.8 + hash2(gx, gz, seed + 47) * 0.55, seed: gx * 977 + gz });
        physics.addBox(
          new THREE.Vector3(x - 0.22, y, z - 0.22),
          new THREE.Vector3(x + 0.22, y + 5.5, z + 0.22),
          'tree'
        );
        count++;
      }
    }

    for (const species of ['broadleaf', 'pine'] as const) {
      const list = bySpecies[species];
      if (list.length === 0) continue;
      const proto = treeGeometry(species, seed + (species === 'pine' ? 5 : 9));
      const trunkMat = new THREE.MeshStandardMaterial({
        color: species === 'pine' ? 0x4a3826 : 0x6b5a48,
        roughness: 0.95,
      });
      const trunks = new THREE.InstancedMesh(proto.trunk, trunkMat, list.length);
      trunks.castShadow = true;
      list.forEach((t, i) => {
        this.dummy.position.set(t.x, t.y, t.z);
        this.dummy.rotation.set(0, hash2(t.seed, 1) * Math.PI * 2, 0);
        this.dummy.scale.setScalar(t.s);
        this.dummy.updateMatrix();
        trunks.setMatrixAt(i, this.dummy.matrix);
      });
      this.group.add(trunks);

      const cardGeo = new THREE.PlaneGeometry(1, 1);
      // Tilt normals up so canopy lights from the sky, not edge-on.
      const nrm = cardGeo.getAttribute('normal') as THREE.BufferAttribute;
      for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 0.85, 0.53);
      const cardMat = new THREE.MeshStandardMaterial({
        map: makeFoliageTexture(species, seed + 3),
        alphaTest: 0.45,
        side: THREE.DoubleSide,
        roughness: 0.9,
        metalness: 0,
      });
      const cards = new THREE.InstancedMesh(cardGeo, cardMat, list.length * proto.cards.length);
      cards.castShadow = true;
      let ci = 0;
      for (const t of list) {
        for (const [cx, cy, cz, yaw, w, h] of proto.cards) {
          this.dummy.position.set(t.x + cx * t.s, t.y + cy * t.s, t.z + cz * t.s);
          this.dummy.rotation.set(0, yaw + hash2(t.seed, ci) * 0.6, 0);
          this.dummy.scale.set(w * t.s, h * t.s, 1);
          this.dummy.updateMatrix();
          cards.setMatrixAt(ci++, this.dummy.matrix);
        }
      }
      cards.count = ci;
      this.group.add(cards);
    }
  }

  /** Rebuilds the camera-local grass ring when the camera crosses a cell. */
  private refreshGrass(): void {
    const ccx = Math.floor(this.camera.position.x / CELL);
    const ccz = Math.floor(this.camera.position.z / CELL);
    if (ccx === this.lastCellX && ccz === this.lastCellZ) return;
    this.lastCellX = ccx;
    this.lastCellZ = ccz;

    let idx = 0;
    const half = Math.floor(GRID / 2);
    const density = quality.grassDensity;
    for (let dz = -half; dz <= half; dz++) {
      for (let dx = -half; dx <= half; dx++) {
        const cellX = ccx + dx;
        const cellZ = ccz + dz;
        for (let k = 0; k < CLUMPS_PER_CELL; k++) {
          const hx = hash2(cellX * 31 + k, cellZ * 17, 71);
          const hz = hash2(cellX * 13 - k, cellZ * 29, 73);
          const x = cellX * CELL + hx * CELL;
          const z = cellZ * CELL + hz * CELL;
          const g = this.mask.sample(this.mask.grass, x, z);
          if (g * density < hash2(k, cellX ^ cellZ, 77)) continue;
          const y = this.hf.height(x, z);
          const s = 0.55 + hash2(k, cellX + cellZ, 79) * 0.75;
          this.dummy.position.set(x, y - 0.03, z);
          this.dummy.rotation.set(0, 0, 0);
          this.dummy.scale.setScalar(s);
          this.dummy.updateMatrix();
          this.grassMesh.setMatrixAt(idx++, this.dummy.matrix);
        }
      }
    }
    this.grassMesh.count = idx;
    this.grassMesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    this.grassMat.uniforms.uTime.value += dt;
    this.refreshGrass();
  }
}
