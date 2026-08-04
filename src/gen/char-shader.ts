import * as THREE from 'three';

// Character surface shader.
//
// One MeshStandardMaterial, one program, one draw call per bot — but the
// vertices carry an `aSurf` stream (roughness, metalness, rimWeight) and an
// `aAO` cavity term, so skin, cotton, ballistic nylon, leather, helmet shell
// and gun steel each get their own response out of the SAME program.
//
// Cycle 3 adds the thing whose absence did more to kill the AAA read than any
// geometry problem: an INDIRECT term. The scene key runs at intensity 22 while
// the whole ambient budget (hemi 0.15 + a 0.42 sky PMREM) lands near 0.2, i.e.
// under 1% of the key — so every shadow side crushed to ~RGB(15,12,10) and the
// figures read as black cut-outs with one lit face. Three terms fix it:
//
//  - a hemispheric irradiance probe lerped on the WORLD normal between sky and
//    ground-bounce colour, at ~12% of key irradiance, multiplied by the baked
//    cavity AO (indirect only — AO must never touch direct light);
//  - a wrap term on the key, saturate((NdotL + w)/(1 + w)) minus plain lambert,
//    so a limb cylinder's terminator does not fall to zero across two vertex
//    rings;
//  - a downward-biased ground bounce, which is what puts light back under a
//    jaw, a helmet brim and a pack flap.
//
// Plus, from cycle 2: a procedural two-octave cloth micro-normal computed as a
// real world-space gradient (scale-invariant, faded past ~24m), and a
// sky-tinted fresnel rim weighted per vertex.

const NOISE = /* glsl */ `
float csHash(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453123);
}
float csNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = csHash(i);
  float n100 = csHash(i + vec3(1.0, 0.0, 0.0));
  float n010 = csHash(i + vec3(0.0, 1.0, 0.0));
  float n110 = csHash(i + vec3(1.0, 1.0, 0.0));
  float n001 = csHash(i + vec3(0.0, 0.0, 1.0));
  float n101 = csHash(i + vec3(1.0, 0.0, 1.0));
  float n011 = csHash(i + vec3(0.0, 1.0, 1.0));
  float n111 = csHash(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}
`;

export interface CharShaderKnobs {
  /** Sky-tinted rim colour (linear radiance). */
  rim: THREE.Color;
  /** Global rim gain. */
  rimK: number;
  /** Global micro-normal gain, in metres of "height" per unit gradient. */
  detail: number;
  /** Up-facing indirect irradiance (linear, same units as light.intensity). */
  skyIrradiance: THREE.Color;
  /** Down-facing indirect irradiance — warm ground bounce. */
  groundIrradiance: THREE.Color;
  /** Wrap width on the key's diffuse terminator. */
  wrap: number;
  /** How much of the wrap delta is added back (0..1). */
  wrapK: number;
}

export const CHAR_SHADER: CharShaderKnobs = {
  rim: new THREE.Color(0.34, 0.45, 0.62),
  rimK: 0.34,
  detail: 0.0044,
  // ~18% of the 22.0 key, split cool over warm. The split is what makes a
  // turned-away cheek read as turned away rather than merely darker.
  //
  // Cycle 3 ran this at ~12% and the panel still measured a backlit figure's
  // shadow side at mean RGB [26,21,17] with a minimum of [1,0,0] — i.e. a flat
  // black cut-out with no form in it. The reference keeps its backlit sniper
  // legible at roughly 60-90, held up by sky fill and bounce. 18% plus a wider
  // wrap puts the terminator roll-off back and stops the shadow side from
  // reaching true black anywhere on the figure.
  skyIrradiance: new THREE.Color(2.10, 2.75, 4.02),
  groundIrradiance: new THREE.Color(2.46, 1.98, 1.27),
  wrap: 0.38,
  wrapK: 0.70,
};

/** Patches a MeshStandardMaterial to read the per-vertex `aSurf` stream. */
export function patchCharacterMaterial(m: THREE.MeshStandardMaterial): void {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = { value: CHAR_SHADER.rim };
    shader.uniforms.uRimK = { value: CHAR_SHADER.rimK };
    shader.uniforms.uDetail = { value: CHAR_SHADER.detail };
    shader.uniforms.uSkyIrr = { value: CHAR_SHADER.skyIrradiance };
    shader.uniforms.uGndIrr = { value: CHAR_SHADER.groundIrradiance };
    shader.uniforms.uWrap = { value: CHAR_SHADER.wrap };
    shader.uniforms.uWrapK = { value: CHAR_SHADER.wrapK };

    shader.vertexShader =
      'attribute vec3 aSurf;\nattribute float aAO;\n' +
      'varying vec3 vSurf;\nvarying vec3 vBindP;\nvarying float vAO;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\tvSurf = aSurf;\n\tvBindP = transformed;\n\tvAO = aAO;'
    );

    shader.fragmentShader =
      'varying vec3 vSurf;\nvarying vec3 vBindP;\nvarying float vAO;\n' +
      'uniform vec3 uRim;\nuniform float uRimK;\nuniform float uDetail;\n' +
      'uniform vec3 uSkyIrr;\nuniform vec3 uGndIrr;\nuniform float uWrap;\nuniform float uWrapK;\n' +
      NOISE +
      shader.fragmentShader;

    // --- albedo break-up ------------------------------------------------------
    // Cycle 3 had ZERO albedo variation: every slot rendered as one exact flat
    // vertex colour, and the only relief in the whole program was an isotropic
    // micro-NORMAL that faded out at 14m — i.e. the surface response died at the
    // bottom of the 8-40m band it exists to serve, leaving every bot at 20m and
    // 40m a pure flat silhouette. Three terms, all in bind space so they stick
    // to the cloth as the skeleton moves:
    //   grain  3 octaves of value noise at 2-6 cycles/m, remapped 0.84..1.10
    //   grime  cavity soiling, cloth/leather/nylon only, mix(0.74,1.0,ao)
    //   wear   edge lightening where the cavity term says a surface is proud
    // The reference jacket swings roughly 30% in value from grime at the cuffs
    // and elbows; this is that, driven off geometry rather than a hand-painted
    // map there is no budget to author.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
	{
		float gA = csNoise(vBindP * 2.4);
		float gB = csNoise(vBindP * 6.3);
		float gC = csNoise(vBindP * 16.5);
		float grain = 0.84 + (gA * 0.50 + gB * 0.32 + gC * 0.18) * 0.26;
		// Fabric-family mask: high roughness, non-metal. Skin (0.62) and helmet
		// shell stay out of the grime pass; cotton, nylon and pack take it all.
		float clothK = smoothstep(0.66, 0.86, vSurf.x) * (1.0 - vSurf.y);
		float grime = mix(1.0, mix(0.74, 1.0, vAO), clothK);
		float wear = pow(1.0 - vAO, 3.0) * 0.20 * clothK;
		diffuseColor.rgb *= grain * grime * (1.0 + wear);
	}`
    );

    // Per-vertex roughness/metalness. Both factors exist by this point.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\n\troughnessFactor = clamp(vSurf.x, 0.04, 1.0);'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      '#include <metalnessmap_fragment>\n\tmetalnessFactor = vSurf.y;'
    );

    // Micro-normal. The height field is sampled in BIND space so the weave
    // sticks to the cloth as the skeleton moves; the gradient is resolved into
    // real per-metre slope, so the strength does not depend on screen scale.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `#include <normal_fragment_maps>
	{
		float dist = length(vViewPosition);
		// 14->30 killed the micro-relief at 14m, which is the BOTTOM of the band
		// these characters are judged in. It now survives to 60m.
		float fade = 1.0 - smoothstep(28.0, 60.0, dist);
		if (fade > 0.004) {
			// An ANISOTROPIC weave, not isotropic noise. Isotropic noise on skin
			// is the "cottage cheese" read at close range and on cloth it is
			// lumpy latex; a woven grain has two axes and a per-surface pitch, so
			// cotton, nylon and skin stop sharing one texture.
			//
			// AMPLITUDE IS THE WHOLE GAME HERE. A two-axis sinusoid resolves into
			// a hard plaid the moment its gradient rivals the noise term's, and
			// at 0.17 it turned every garment into gingham. It has to stay a
			// grain you read as texture, never as a pattern you can count.
			float wk = 70.0 + 130.0 * vSurf.x;
			float weave = (sin(vBindP.x * wk) + sin(vBindP.y * wk * 0.79)) * 0.045;
			float h = weave + csNoise(vBindP * 46.0) * 0.36 + csNoise(vBindP * 13.0) * 0.32;
			vec3 vp = -vViewPosition;
			vec3 dpx = dFdx(vp);
			vec3 dpy = dFdy(vp);
			float dhx = dFdx(h);
			float dhy = dFdy(h);
			vec3 N = normalize(normal);
			vec3 T = dpx - N * dot(N, dpx);
			float tl = length(T);
			if (tl > 1e-7) {
				T /= tl;
				vec3 B = cross(N, T);
				vec2 ax = vec2(dot(dpx, T), dot(dpx, B));
				vec2 ay = vec2(dot(dpy, T), dot(dpy, B));
				float det2 = ax.x * ay.y - ax.y * ay.x;
				if (abs(det2) > 1e-12) {
					vec2 g = vec2(dhx * ay.y - dhy * ax.y, ax.x * dhy - ay.x * dhx) / det2;
					g = clamp(g, vec2(-320.0), vec2(320.0));
					float bs = uDetail * fade * (0.30 + 1.30 * smoothstep(0.36, 0.94, vSurf.x));
					normal = normalize(N - bs * (T * g.x + B * g.y));
				}
			}
		}
	}`
    );

    // --- indirect: hemispheric probe + key wrap -------------------------------
    // `irradiance` at this point holds only the ambient/hemisphere lights, and
    // is consumed by RE_IndirectDiffuse below. Adding here is diffuse-only, so
    // the probe cannot blow out a metal or helmet specular. `normal` is in VIEW
    // space; `n * mat3(viewMatrix)` is transpose(V) * n, i.e. back to world.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      /* glsl */ `
	{
		vec3 wN = normalize(normal * mat3(viewMatrix));
		float up = wN.y * 0.5 + 0.5;
		irradiance += mix(uGndIrr, uSkyIrr, up * up) * vAO;
		#if ( NUM_DIR_LIGHTS > 0 )
		{
			vec3 L = normalize(directionalLights[0].direction);
			float ndl = dot(normalize(normal), L);
			float wrapT = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
			float lam = clamp(ndl, 0.0, 1.0);
			irradiance += directionalLights[0].color * (max(0.0, wrapT - lam) * uWrapK);
		}
		#endif
	}
#include <lights_fragment_end>`
    );

    // Sky-tinted rim. Weighted up on helmet / pack / shoulders via aSurf.z so
    // the kit edge separates from terrain of the same value.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      /* glsl */ `#include <opaque_fragment>
	{
		float f = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
		gl_FragColor.rgb += uRim * (uRimK * vSurf.z * f * f * f);
	}`
    );
  };
  m.customProgramCacheKey = () => 'char-surf-4';
}
