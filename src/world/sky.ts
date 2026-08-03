import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { parseBootParams } from '../core/settings';

// Analytic sky + sun + atmosphere. The sky gets rendered once into a PMREM
// environment map so every PBR material receives plausible ambient and
// reflections without any HDRI download.
//
// Three things are layered onto the stock Preetham dome:
//   1. A cloud deck (warped cumulus + stretched cirrus) written straight into
//      the sky fragment shader — no extra mesh, no extra draw call.
//   2. A horizon haze band applied AFTER tone mapping, in the same display
//      space and from the same colour as scene.fog, so the sea, the fogged land
//      and the sky all meet on one value instead of three.
//   3. A sun glow lobe on top of the analytic mie term.
//
// The dome is also pushed to renderOrder 1000 so it draws after the terrain:
// depthWrite is off and its depth is pinned to the far plane, so every pixel
// already covered by land fails the depth test and never runs the cloud maths.

export interface Atmosphere {
  sky: Sky;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sunDir: THREE.Vector3;
  /** Re-renders the environment map (call once after setup or on tod change). */
  bakeEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void;
}

/** Sun elevation in degrees for a 0..24 time of day. */
export function sunElevationFor(timeOfDay: number): number {
  const dayT = (timeOfDay - 6) / 12;
  return Math.sin(Math.PI * Math.min(Math.max(dayT, 0.02), 0.98)) * 62;
}

/** Unit vector toward the sun for a 0..24 time of day. */
export function sunDirectionFor(timeOfDay: number): THREE.Vector3 {
  const dayT = (timeOfDay - 6) / 12;
  const elevation = sunElevationFor(timeOfDay);
  const azimuth = 180 + (dayT - 0.5) * 130;
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

/**
 * Horizon haze as raw sRGB components. One source of truth: the fog colour, the
 * sky's horizon band and the water's distance tint all read from here.
 */
export function hazeSrgbFor(timeOfDay: number): [number, number, number] {
  const warm = 1 - Math.min(sunElevationFor(timeOfDay) / 50, 1);
  const cool = [0.515, 0.600, 0.706];
  const hot = [0.780, 0.700, 0.596];
  const t = warm * 0.5;
  return [
    cool[0] + (hot[0] - cool[0]) * t,
    cool[1] + (hot[1] - cool[1]) * t,
    cool[2] + (hot[2] - cool[2]) * t,
  ];
}

const CLOUD_HELPERS = /* glsl */ `
uniform vec3 uHaze;          // sRGB display components, matched to scene fog
uniform float uHazeStrength;
uniform float uCloudCover;   // threshold: higher = less cloud
uniform float uCloudDensity;
uniform float uCloudLum;
uniform vec3 uSunTint;
float gHaze;

float chash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float cnoise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( chash( i ), chash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( chash( i + vec2( 0.0, 1.0 ) ), chash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float cfbm( vec2 p, int oct ) {
  float s = 0.0, a = 0.5;
  for ( int i = 0; i < 6; i ++ ) {
    if ( i >= oct ) break;
    s += a * cnoise2( p );
    p = p * 2.07 + 1.7;
    a *= 0.5;
  }
  return s;
}
`;

const CLOUD_BODY = /* glsl */ `
	// Cloud deck: projected onto a flat plane so it converges toward the horizon
	// the way real cover does.
	gHaze = 0.0;
	if ( direction.y > 0.002 ) {
		// Bounded projection. A true flat plane (xz / y) compresses without limit
		// toward the horizon: the deck aliases into one flat white band that eats
		// the whole lower sky. Adding a floor to the divisor keeps the
		// convergence readable and caps the compression at about 5x.
		vec2 cuv = direction.xz / ( direction.y * 0.9 + 0.22 );
		float drift = time * 0.0035;

		// Cumulus: domain-warped fbm thresholded by coverage, then eroded so the
		// bases are ragged rather than one soft blob. The frequency has to be
		// high enough to fit a dozen cells across the dome — at half this the
		// deck reads as two grey smears and swallows the blue entirely.
		vec2 p = cuv * 1.6 + vec2( drift, drift * 0.4 );
		float w = cfbm( p * 0.5, 3 );
		float cum = cfbm( p + vec2( w, w * 0.8 ) * 1.7, 5 );
		float mask = smoothstep( uCloudCover, uCloudCover + 0.16, cum );
		mask *= 1.0 - smoothstep( 0.45, 0.95, cfbm( p * 3.1 + 9.0, 3 ) ) * 0.45;

		// Cirrus: much flatter, only visible in the gaps between cumulus.
		vec2 q = vec2( cuv.x * 0.20, cuv.y * 1.3 ) * 1.4 + drift * 0.6;
		float cir = cfbm( q, 4 );
		cir = smoothstep( 0.46, 0.78, abs( cir - 0.5 ) * 2.0 );
		cir *= smoothstep( 0.54, 0.30, cum );

		// Clouds thin out toward the horizon. Wide, because that is also where
		// the projection is least trustworthy.
		float horizonFade = smoothstep( 0.03, 0.42, direction.y );
		mask *= horizonFade;
		cir *= horizonFade * 0.35;

		float rim = pow( max( dot( direction, vSunDirection ), 0.0 ), 5.0 );
		float thickness = smoothstep( uCloudCover + 0.02, uCloudCover + 0.30, cum );
		vec3 lit = mix( vec3( 1.0, 0.975, 0.94 ), vec3( 1.22, 1.10, 0.94 ), rim );
		vec3 shade = mix( vec3( 0.40, 0.44, 0.52 ), vec3( 0.74, 0.70, 0.70 ), rim );
		vec3 cloudCol = mix( lit, shade, thickness * 0.85 ) * uCloudLum;

		texColor = mix( texColor, cloudCol, clamp( mask * uCloudDensity, 0.0, 1.0 ) );
		texColor = mix( texColor, lit * uCloudLum * 0.85, clamp( cir, 0.0, 1.0 ) );
	}

	// Sun glow on top of the analytic mie lobe.
	texColor += uSunTint * pow( max( dot( direction, vSunDirection ), 0.0 ), 7.0 ) * 0.06;

	// Haze band amount; applied post-tonemap so it lands on the same value as
	// the scene fog (three applies fog after tone mapping too).
	gHaze = smoothstep( 0.11, -0.03, direction.y ) * uHazeStrength;

	`;

interface SkyDials {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  cloudCover: number;
  cloudDensity: number;
  cloudLum: number;
  haze: [number, number, number];
  hazeStrength: number;
  sunTint: THREE.Vector3;
}

/** Injects the cloud/haze layer into a Sky instance's shader. */
function patchSky(sky: Sky, d: SkyDials, sunDir: THREE.Vector3, showSunDisc: boolean): void {
  const mat = sky.material as THREE.ShaderMaterial;
  const u = mat.uniforms;
  u.sunPosition.value.copy(sunDir);
  u.turbidity.value = d.turbidity;
  u.rayleigh.value = d.rayleigh;
  u.mieCoefficient.value = d.mieCoefficient;
  u.mieDirectionalG.value = d.mieDirectionalG;
  u.showSunDisc.value = showSunDisc ? 1 : 0;
  u.uHaze = { value: new THREE.Vector3(...d.haze) };
  u.uHazeStrength = { value: d.hazeStrength };
  u.uCloudCover = { value: d.cloudCover };
  u.uCloudDensity = { value: d.cloudDensity };
  u.uCloudLum = { value: d.cloudLum };
  u.uSunTint = { value: d.sunTint.clone() };

  const src = mat.fragmentShader;
  const head = src.indexOf('// Clouds');
  const tailMarker = 'gl_FragColor = vec4( texColor, 1.0 );';
  const tail = src.indexOf(tailMarker);
  if (head < 0 || tail < 0) return; // addon changed shape: keep the stock dome

  mat.fragmentShader = (src.slice(0, head) + CLOUD_BODY + src.slice(tail))
    .replace('void main() {', `${CLOUD_HELPERS}\nvoid main() {`)
    .replace(
      '#include <colorspace_fragment>',
      '#include <colorspace_fragment>\n\tgl_FragColor.rgb = mix( gl_FragColor.rgb, uHaze, gHaze );'
    );
}

export function createAtmosphere(timeOfDay: number): Atmosphere {
  const sky = new Sky();
  sky.scale.setScalar(45000);
  // Draw after the opaque terrain: the dome is pinned to the far plane with
  // depthWrite off, so covered pixels get rejected before the cloud maths runs.
  sky.renderOrder = 1000;

  const elevation = sunElevationFor(timeOfDay);
  const sunDir = sunDirectionFor(timeOfDay);
  const warmth = 1 - Math.min(elevation / 55, 1);
  const haze = hazeSrgbFor(timeOfDay);

  const dials: SkyDials = {
    turbidity: 2.9,
    rayleigh: 2.6,
    mieCoefficient: 0.0040,
    mieDirectionalG: 0.80,
    cloudCover: 0.585,
    cloudDensity: 0.92,
    cloudLum: 2.5,
    haze,
    hazeStrength: 0.45,
    sunTint: new THREE.Vector3(1.0, 0.78, 0.52),
  };
  patchSky(sky, dials, sunDir, true);

  // Frame-stepped clock: capture waits a fixed frame count, so a fixed dt keeps
  // every screenshot byte-comparable between cycles.
  let frame = 0;
  sky.onBeforeRender = () => {
    (sky.material as THREE.ShaderMaterial).uniforms.time.value = (frame++) / 60;
  };

  // Sun colour cools as it climbs.
  const sunColor = new THREE.Color().setHSL(0.095 - warmth * 0.03, 0.55 + warmth * 0.3, 0.62 - warmth * 0.1);
  const sun = new THREE.DirectionalLight(sunColor, 3.8);
  sun.position.copy(sunDir).multiplyScalar(600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 1200;
  const s = 150;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.bias = -0.00035;
  // Long shadows at a low sun exaggerate acne; normalBias trades it for a small
  // contact offset, which nothing touches the ground yet to reveal.
  sun.shadow.normalBias = 0.4;

  // Ambient stays deliberately low. The washed-out look in the phase 0 smoke
  // shots was ambient fill, not exposure.
  // A blue sky term this strong is what turned the shaded hill faces slate; the
  // bounce off dry Erangel farmland is warm, not cold.
  const hemi = new THREE.HemisphereLight(0xb9c2c6, 0x7d6844, 0.20);

  return {
    sky,
    sun,
    hemi,
    sunDir,
    bakeEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const skyScene = new THREE.Scene();
      const skyClone = new Sky();
      skyClone.scale.setScalar(45000);
      // Sun disc off for the bake: a 19000x hot texel smears into a blotch.
      patchSky(skyClone, dials, sunDir, false);
      skyScene.add(skyClone);
      const envRT = pmrem.fromScene(skyScene, 0.0);
      scene.environment = envRT.texture;
      pmrem.dispose();
    },
  };
}

/**
 * Height fog tinted to the same haze the sky horizon uses. FogExp2 is applied
 * after tone mapping in three, so the colour is a display value.
 */
export function createFog(timeOfDay = parseBootParams().timeOfDay): THREE.FogExp2 {
  const [r, g, b] = hazeSrgbFor(timeOfDay);
  const color = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
  // Tuned so the far shore keeps its colour while the horizon still reads as
  // atmosphere; heavier than this and the whole island goes milky.
  return new THREE.FogExp2(color, 0.00054);
}
