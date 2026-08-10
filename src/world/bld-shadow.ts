import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { quality } from '../core/settings';
import { terrainSurfaceY, type Heightfield } from '../gen/terraingen';

// Sun shadowing and ground contact for the settlement layer, in two parts.
//
// 1. fitSunShadowPre() — refits the one directional shadow's ortho box from
//    scene.onBeforeRender, which is the only hook that runs BEFORE
//    WebGLRenderer's shadowMap.render for the same frame.
//
//    THE CYCLE-2 BUG, and why not one object in the build cast a shadow:
//    three's DirectionalLightShadow.updateMatrices() places the shadow camera
//    from `light.matrixWorld`, not from `light.position`. scene.updateMatrixWorld()
//    has already run by the time onBeforeRender fires, so writing sun.position
//    here left matrixWorld holding the position main.ts set — 500 m up-sun —
//    while near/far were computed for a light 2200 m out. The visible depth
//    slice therefore started ~1150 m BEYOND the village and every caster in the
//    scene, buildings, props and trees alike, was clipped in front of the near
//    plane. The map rendered, and it rendered nothing. Forcing matrixWorld after
//    the write is the whole fix.
//
// 2. buildContactDecals() — a projected ground skirt at every footprint, merged
//    into ONE draw call. This is deliberately NOT a second copy of the cast
//    shadow (which the shadow map now delivers): it is the ambient-occlusion
//    crease and dirt apron where a structure meets the ground, which a 2048 map
//    shared with a 1200 m landscape can never resolve, and which is what stops a
//    wall terminating on a razor-clean line across lit grass. Blended as
//    dst * (1 - a), a straight multiply, in the linear composite space the rest
//    of the frame is authored in (see the colour-space note atop sky.ts).

const UP = new THREE.Vector3(0, 1, 0);
const _target = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _lightM = new THREE.Matrix4();
const _viewM = new THREE.Matrix4();

/** Distance the shadow "camera" is pulled back along the sun vector, metres. */
const LIGHT_DIST = 900;

function fitSunShadowPre(sun: THREE.DirectionalLight, camera: THREE.Camera): void {
  const cam = camera as THREE.PerspectiveCamera;
  if (!cam.isPerspectiveCamera) return;

  // Unit vector TOWARD the sun, read off the light itself so this stays correct
  // whatever time of day the boot params asked for.
  _dir.copy(sun.position).sub(sun.target.position);
  if (_dir.lengthSq() < 1e-6) return;
  _dir.normalize();

  cam.getWorldDirection(_fwd);
  const camH = Math.max(cam.position.y, 1.0);
  const pitchDown = Math.max(-_fwd.y, 0);
  // Kept deliberately short. A 74-degree frustum is 2.7x as wide as it is deep,
  // so every metre of range costs 2.7 m of ortho box and the whole 2048 map is
  // spent before the village is resolved. 105 m of casters at ~0.14 m/texel
  // reads as architecture; 300 m at 0.4 m/texel reads as grey smudges.
  const dist = Math.min(quality.shadowDistance, Math.max(105, 74 + camH * 5.0 + pitchDown * 420));

  _target.set(cam.position.x, 0, cam.position.z);
  _eye.copy(_dir).multiplyScalar(LIGHT_DIST).add(_target);
  _lightM.lookAt(_eye, _target, UP);
  _lightM.setPosition(_eye);
  _viewM.copy(_lightM).invert();

  // Vertical clamp, relative to the eye. This map carries the settlement layer
  // only (landform self-shadowing is baked into the terrain control map), and
  // nothing in the kit stands taller than ~9 m, so 24 m of headroom is generous
  // — while an unclamped frustum at 105 m reaches +/-79 m and spends most of the
  // texels on empty sky.
  const yLo = cam.position.y - 13;
  const yHi = cam.position.y + 24;

  const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const d of [Math.max(cam.near, 0.5), dist]) {
    const hh = tanH * d;
    const hw = hh * cam.aspect;
    for (let s = 0; s < 4; s++) {
      const sx = s & 1 ? 1 : -1;
      const sy = s & 2 ? 1 : -1;
      _corner.set(sx * hw, sy * hh, -d).applyMatrix4(cam.matrixWorld);
      _corner.y = Math.min(Math.max(_corner.y, yLo), yHi);
      _corner.applyMatrix4(_viewM);
      if (_corner.x < minX) minX = _corner.x;
      if (_corner.x > maxX) maxX = _corner.x;
      if (_corner.y < minY) minY = _corner.y;
      if (_corner.y > maxY) maxY = _corner.y;
      if (_corner.z < minZ) minZ = _corner.z;
      if (_corner.z > maxZ) maxZ = _corner.z;
    }
  }
  if (!isFinite(minX) || !isFinite(minZ)) return;

  // Snap to whole shadow texels so the box does not swim under camera motion.
  const texel = Math.max(maxX - minX, maxY - minY) / quality.shadowMapSize;
  if (!(texel > 0)) return;
  minX = Math.floor(minX / texel) * texel;
  maxX = Math.ceil(maxX / texel) * texel;
  minY = Math.floor(minY / texel) * texel;
  maxY = Math.ceil(maxY / texel) * texel;

  const cs = sun.shadow.camera;
  cs.left = minX; cs.right = maxX; cs.bottom = minY; cs.top = maxY;
  // Pull the near plane back so casters between the light and the visible slice
  // still write into the map, and never let the slice collapse or invert.
  cs.near = Math.max(1, -maxZ - 260);
  cs.far = -minZ + 120;
  if (!(cs.far > cs.near + 1)) cs.far = cs.near + 1;
  cs.updateProjectionMatrix();

  // shadow.bias is in normalised [0,1] depth, so its metric size scales with the
  // depth range. At a 1300 m range the inherited -0.0006 was 0.8 m of
  // peter-panning, which detaches every contact shadow it does not erase.
  const range = cs.far - cs.near;
  sun.shadow.bias = -Math.min(0.0005, 0.09 / range);
  // ~1 texel of normal offset. Above that a 0.14 m fence post is offset clean
  // off its own shadow; below it a 30 cm-tessellated plaster wall acnes.
  sun.shadow.normalBias = Math.min(0.14, Math.max(0.02, texel));

  sun.target.position.copy(_target);
  sun.position.copy(_eye);
  // THE fix. Without these two lines the shadow camera is placed from a stale
  // matrixWorld and the near/far computed above describe a slice that contains
  // nothing. See the note at the top of this file.
  sun.updateMatrixWorld(true);
  sun.target.updateMatrixWorld(true);
}

/**
 * Hooks the fit onto the scene, keeping whatever callback was already there.
 * `group` is the settlement group; it is used only to find the scene once it has
 * been parented, since this module is constructed before that happens.
 */
export function installSunShadowFit(group: THREE.Object3D): void {
  let tries = 0;
  const attempt = (): void => {
    let node: THREE.Object3D | null = group;
    while (node && !(node as THREE.Scene).isScene) node = node.parent;
    const scene = node as THREE.Scene | null;
    if (!scene) {
      if (tries++ < 240) requestAnimationFrame(attempt);
      return;
    }
    let sun: THREE.DirectionalLight | null = null;
    scene.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (l.isDirectionalLight && l.castShadow) sun = l;
    });
    if (!sun) {
      if (tries++ < 240) requestAnimationFrame(attempt);
      return;
    }
    const found: THREE.DirectionalLight = sun;
    // WebGLRenderer calls scene.onBeforeRender with (renderer, scene, camera,
    // renderTarget) — a shorter list than Object3D's own hook, hence the cast.
    type SceneHook = (r: THREE.WebGLRenderer, s: THREE.Scene, c: THREE.Camera, t: unknown) => void;
    const prev = scene.onBeforeRender as unknown as SceneHook;
    const next: SceneHook = function (this: THREE.Scene, renderer, sc, camera, rt) {
      prev.call(this, renderer, sc, camera, rt);
      fitSunShadowPre(found, camera);
    };
    scene.onBeforeRender = next as unknown as THREE.Object3D['onBeforeRender'];
    (window as unknown as Record<string, unknown>).__BSHADOW__ = (px = 0, py = 0, pz = 0) => {
      const cs = found.shadow.camera;
      // Light-space depth of a probe point, so a capture can prove the village
      // actually sits inside [near, far] instead of assuming it.
      const v = new THREE.Vector3(px, py, pz).applyMatrix4(cs.matrixWorldInverse);
      return {
        ortho: [cs.left, cs.right, cs.bottom, cs.top, cs.near, cs.far],
        probeDepth: -v.z,
        probeXY: [v.x, v.y],
        sun: found.position.toArray(),
        target: found.target.position.toArray(),
        bias: found.shadow.bias,
        normalBias: found.shadow.normalBias,
        hasMap: !!found.shadow.map,
      };
    };
  };
  attempt();
}

// ------------------------------------------------------ contact decals ----

export interface ShadowCaster {
  x: number;
  z: number;
  /** Half-extent along world X of the footprint. */
  hx: number;
  /** Half-extent along world Z of the footprint. */
  hz: number;
  /** Height of the caster above the ground at (x, z). */
  h: number;
  /** Round footprint (haystack, barrel, pole, well). */
  round?: boolean;
  /** Peak opacity at the contact line, 0..1. */
  k?: number;
}

/** Signed distance to a convex rect/ellipse footprint: positive inside. */
function footprintDist(c: ShadowCaster, x: number, z: number): number {
  const dx = Math.abs(x - c.x);
  const dz = Math.abs(z - c.z);
  if (c.round) {
    const r = (c.hx + c.hz) * 0.5;
    return r - Math.hypot(dx, dz);
  }
  // Exact exterior distance for a box, approximate (Chebyshev) inside.
  const ox = dx - c.hx;
  const oz = dz - c.hz;
  if (ox <= 0 && oz <= 0) return -Math.max(ox, oz);
  return -Math.hypot(Math.max(ox, 0), Math.max(oz, 0));
}

/**
 * Vertical clearance over the terrain. The grid samples hf.height at its own
 * corners, so between samples a decal vertex can drop under the rendered
 * terrain triangle and be depth-rejected — which is exactly what happened at
 * LIFT = 0.055 with a 1.6 m grid step. 0.14 m plus a step held under 0.6 m
 * keeps every vertex above the surface without the skirt visibly floating.
 */
const LIFT = 0.14;

/**
 * One merged mesh carrying every ground contact skirt in the settlement layer.
 * Returns null when there is nothing to draw.
 */
export function buildContactDecals(casters: ShadowCaster[], hf: Heightfield): THREE.Mesh | null {
  const geos: THREE.BufferGeometry[] = [];
  let budget = 190000;   // hard vertex ceiling, so a dense farm cannot run away

  for (const c of casters) {
    if (budget <= 0) break;
    const size = Math.max(c.hx, c.hz);
    // Tight AO crease at the wall line, then a wider dirt apron. A haystack gets
    // a 40 cm crease; a barn gets a metre and a 2.4 m apron of worn ground.
    const crease = Math.min(1.15, 0.30 + size * 0.16);
    const apron = crease * (size > 1.6 ? 2.6 : 1.7);
    const k = Math.min(0.62, (c.k ?? 0.55) * 0.72);

    const minX = c.x - c.hx - apron;
    const maxX = c.x + c.hx + apron;
    const minZ = c.z - c.hz - apron;
    const maxZ = c.z + c.hz + apron;
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;
    const step = Math.min(0.58, Math.max(0.22, Math.max(spanX, spanZ) / 30));
    const nx = Math.min(32, Math.max(2, Math.ceil(spanX / step)));
    const nz = Math.min(32, Math.max(2, Math.ceil(spanZ / step)));
    const vcount = (nx + 1) * (nz + 1);
    budget -= vcount;

    const pos = new Float32Array(vcount * 3);
    const alpha = new Float32Array(vcount);
    let any = false;
    let p = 0;
    for (let j = 0; j <= nz; j++) {
      const z = minZ + (spanZ * j) / nz;
      for (let i = 0; i <= nx; i++) {
        const x = minX + (spanX * i) / nx;
        const d = footprintDist(c, x, z);
        let a: number;
        if (d >= 0) {
          a = 1;
        } else {
          const t = Math.min(1, -d / crease);
          const near = 1 - t * t * (3 - 2 * t);
          const u = Math.min(1, -d / apron);
          const wide = 1 - u * u * (3 - 2 * u);
          a = near * 0.70 + wide * 0.30;
        }
        if (a > 0.004) any = true;
        pos[p * 3] = x;
        // The RENDERED plane, not the analytic curve: see terrainSurfaceY. On
        // hf.height the decal sank under the terrain triangle across every
        // hollow and only fragments surfaced, which is what put hard-edged
        // black shards across the near field.
        pos[p * 3 + 1] = terrainSurfaceY(hf, x, z) + LIFT;
        pos[p * 3 + 2] = z;
        alpha[p] = a * k;
        p++;
      }
    }
    if (!any) continue;

    const idx: number[] = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a0 = j * (nx + 1) + i;
        const b0 = a0 + 1;
        const c0 = a0 + nx + 1;
        const d0 = c0 + 1;
        if (alpha[a0] <= 0.004 && alpha[b0] <= 0.004 && alpha[c0] <= 0.004 && alpha[d0] <= 0.004) continue;
        idx.push(a0, c0, b0, b0, c0, d0);
      }
    }
    if (idx.length === 0) continue;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    g.setIndex(idx);
    geos.push(g);
  }

  if (geos.length === 0) return null;
  const merged = mergeGeometries(geos.map((g) => g.toNonIndexed()), false);
  for (const g of geos) g.dispose();
  if (!merged) return null;
  merged.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    uniforms: { uFade: { value: new THREE.Vector2(150, 430) } },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      uniform vec2 uFade;
      varying float vA;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float dist = length(wp.xyz - cameraPosition);
        vA = aAlpha * (1.0 - smoothstep(uFade.x, uFade.y, dist));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, vA); }
    `,
    transparent: true,
    depthWrite: false,
    // dst * (1 - srcAlpha): a pure multiply, which is what occlusion is.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });

  const mesh = new THREE.Mesh(merged, mat);
  mesh.renderOrder = 4;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}
