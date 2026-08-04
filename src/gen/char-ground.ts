import * as THREE from 'three';

// Per-character CONTACT OCCLUSION.
//
// Every review cycle so far has been told the same thing in different words:
// "characters read as decals pasted over the terrain rather than standing on
// it". The contact solve in charactergen.ts is not the problem — it puts the
// soles within 8mm of the deck and the harness measures that every run. The
// problem is that NOTHING DARKENS where the boot meets the ground.
//
// A cascaded shadow map at this budget cannot resolve a boot-scale contact: the
// first cascade covers hundreds of metres, its texel is far larger than a sole,
// and the depth bias needed to stop acne displaces the whole cast shadow by
// roughly a boot length (which the panel measured directly). Real engines solve
// this with SSAO or a contact-hardening shadow term; neither is affordable on
// an HD 620 that already benches at 30fps on bare terrain.
//
// So this is the cheap option done properly: one screen-facing... no, one
// GROUND-PLANE disc per character, multiplied into the frame under the feet,
// scaled to the actual stance width and faded by how far the lowest contact
// sample is off the deck (so it vanishes mid-stride instead of sliding along
// under a swinging boot).
//
// Cost: one draw call and two triangles per character, no texture, no depth
// write. Geometry and material are shared across every character in the world.
//
// It is MultiplyBlending on purpose. An alpha-blended black quad has to know
// the ground's colour to avoid greying it; a multiply cannot get that wrong,
// and it composites identically over lit grass, road, mud or a building floor.

let sharedGeo: THREE.BufferGeometry | null = null;
let sharedMat: THREE.ShaderMaterial | null = null;

function geometry(): THREE.BufferGeometry {
  if (!sharedGeo) {
    sharedGeo = new THREE.PlaneGeometry(1, 1);
    sharedGeo.rotateX(-Math.PI / 2);
  }
  return sharedGeo;
}

function materialFor(): THREE.ShaderMaterial {
  if (!sharedMat) {
    sharedMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.MultiplyBlending,
      // three's WebGLState console.errors MultiplyBlending without this, and a
      // console.error is a hard gate failure in this lane's harness. The maths
      // is unaffected: alpha is always 1 here and the darkening rides entirely
      // in the colour channels.
      premultipliedAlpha: true,
      // The disc is coplanar-ish with terrain that curves under it; a negative
      // offset pulls it toward the camera so it cannot z-fight on a slope.
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
      uniforms: { uStrength: { value: 0.0 } },
      vertexShader: /* glsl */ `
        varying vec2 vXz;
        void main() {
          vXz = position.xz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vXz;
        uniform float uStrength;
        void main() {
          // Two lobes: a tight near-black core right under the sole and a wide
          // soft ambient occlusion bowl. One lobe alone reads either as a
          // painted dot or as a grey smudge.
          float r = length(vXz) * 2.0;
          float core = 1.0 - smoothstep(0.10, 0.46, r);
          float bowl = 1.0 - smoothstep(0.24, 1.0, r);
          float a = clamp(core * 0.72 + bowl * bowl * 0.52, 0.0, 1.0);
          float k = 1.0 - uStrength * a;
          gl_FragColor = vec4(k, k, k, 1.0);
        }
      `,
    });
  }
  return sharedMat;
}

/**
 * A contact patch parented to a character root. `NAME` is what the review
 * harness excludes from its silhouette / backface passes — a solid black quad
 * lying under a figure would otherwise be counted as character area and would
 * make the presence gate certify an empty frame.
 */
export const CONTACT_NAME = 'char-contact';

export function makeContactShadow(): THREE.Mesh {
  // Cloned per character because uStrength is per-figure (it tracks that
  // figure's own foot height). three caches the compiled program off the shader
  // SOURCE for a ShaderMaterial, so N clones still compile exactly once.
  const m = new THREE.Mesh(geometry(), materialFor().clone());
  m.name = CONTACT_NAME;
  m.castShadow = false;
  m.receiveShadow = false;
  m.frustumCulled = false;
  // After opaque terrain, before the transparent sort matters much: it is
  // flat on the ground and nothing else lives at that depth.
  m.renderOrder = 1;
  m.matrixAutoUpdate = true;
  return m;
}

/**
 * @param mesh    the contact patch
 * @param cx,cz   centroid of the weight-bearing contacts, in root space
 * @param halfW   half the stance width  (x)
 * @param halfD   half the stance depth  (z)
 * @param lift    how far the lowest contact sample sits off the deck, metres
 * @param opacity peak darkening (0 disables)
 */
export function placeContactShadow(
  mesh: THREE.Mesh,
  cx: number,
  cz: number,
  halfW: number,
  halfD: number,
  lift: number,
  opacity: number
): void {
  // A patch has to be wider than its caster or the penumbra reads as a hard
  // edge, and it must never be narrower than a single boot.
  const w = Math.max(0.30, halfW * 2 + 0.30);
  const d = Math.max(0.34, halfD * 2 + 0.30);
  mesh.position.set(cx, 0.012, cz);
  mesh.scale.set(w, 1, d);
  // Contact fades out as the caster leaves the ground: a shadow that keeps its
  // density under a boot at the top of a stride is the giveaway that it is a
  // decal and not occlusion.
  const fade = 1 - Math.min(1, Math.max(0, lift) / 0.30);
  const mat = mesh.material as THREE.ShaderMaterial;
  mat.uniforms.uStrength.value = opacity * (0.30 + 0.70 * fade * fade);
}
