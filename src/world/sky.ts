import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { parseBootParams, quality } from '../core/settings';

// Analytic sky + sun + atmosphere. The sky gets rendered once into a PMREM
// environment map so every PBR material receives plausible ambient and
// reflections without any HDRI download.
//
// COLOUR SPACE — the one fact everything here depends on. The frame is composed
// by an EffectComposer into a HalfFloat render target, and three DISABLES its
// own tone mapping whenever the render target is not the canvas. The post stack
// therefore carries the tone curve itself: an ACES ToneMappingEffect is the
// first display-referred effect in src/post/pipeline.ts, and renderer
// .toneMappingExposure (0.6) cancels the ACES `exposure / 0.6` term so the
// mapper runs at unity. Two consequences:
//   1. Everything written by a scene shader is SCENE-REFERRED LINEAR RADIANCE
//      with real headroom above 1.0. The dome only needs enough compression to
//      keep its 0.65 -> 12 raw range inside the mapper's useful window;
//      `skyCurve()` is a gentle bounded pre-compression, NOT a display curve.
//      Before the global mapper existed it had to be a display curve, and that
//      is what flattened the bottom third of the sky into one chroma-free value.
//   2. Every haze / fog colour in the build is authored as LINEAR, not display
//      sRGB, and the terrain and water run their own fog so they share it.
//
// Layered onto the stock dome:
//   1. A cloud deck (warped cumulus + curl-warped cirrus + a low stratus band)
//      written straight into the sky fragment shader — no mesh, no draw call.
//      Composited in RAW radiance so the curve grades cloud and sky together.
//   2. A horizon haze band applied AFTER the curve, from the same linear colour
//      the terrain/water aerial perspective uses, so land, sea and sky meet on
//      one value instead of three.
//   3. Our own sun disc + mie halo added after the curve so it survives above
//      1.0 and reaches the bloom threshold.
//
// The dome is pushed to renderOrder 1000 so it draws after the terrain:
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

/**
 * ONE colour curve for the sun, shared by the visible disc, the directional
 * key and the Mie in-scatter. Cycle 3 had the disc drawn pure white with a cold
 * halo while the key was warm straw, so the light and its source disagreed
 * about colour temperature — a tell you cannot un-see once it is pointed out.
 * Linear, normalised to 1.0 in red.
 */
export function sunTintFor(timeOfDay: number): THREE.Vector3 {
  const e = sunElevationFor(timeOfDay);
  // < 5 deg: deep orange. 5-15: amber. > 15: warm daylight — never neutral, and
  // never anywhere near 6500K at this elevation.
  //
  // RETUNED (cycle 5). The old ramp put the 23.7-degree default sun at
  // (1.00, 0.91, 0.81), i.e. roughly 6400K, and the capture measured lit rock at
  // channel ratios 1.00:0.97:0.94 — an achromatic noon white. Every PUBG
  // reference frame measures its lit ground at 1.00:0.81-0.83:0.59-0.65
  // (Erangel wheat 1.00:0.82:0.63, coastal sand 1.00:0.82:0.64), which is a
  // ~4300K beam. The build was solving for brightness by pushing the light
  // toward white; the correct lever is exposure, not chromaticity.
  //
  // This ramp lands e=24 on (1.00, 0.79, 0.60) and still reaches (1.00, 0.90,
  // 0.78) at a 62-degree noon, so the atmosphere warms automatically as the sun
  // drops rather than being one fixed colour.
  const lowT = THREE.MathUtils.clamp(e / 5, 0, 1);
  const midT = THREE.MathUtils.clamp((e - 5) / 10, 0, 1);
  const highT = THREE.MathUtils.clamp((e - 15) / 30, 0, 1);
  const g = 0.42 + (0.62 - 0.42) * lowT + (0.75 - 0.62) * midT + (0.90 - 0.75) * highT;
  const b = 0.16 + (0.34 - 0.16) * lowT + (0.52 - 0.34) * midT + (0.78 - 0.52) * highT;
  return new THREE.Vector3(1.0, g, b);
}

/** Unit vector toward the sun for a 0..24 time of day. */
export function sunDirectionFor(timeOfDay: number): THREE.Vector3 {
  const dayT = (timeOfDay - 6) / 12;
  const elevation = sunElevationFor(timeOfDay);
  // At the default tod this lands the sun on heading ~320 degrees. The two hero
  // vista poses look along heading ~36, so the key rakes across them at ~76
  // degrees: shadows run left-to-right ACROSS the frame instead of hiding
  // behind their own casters. The previous base (120 -> heading 169) sat 133
  // degrees off forward, i.e. almost directly behind every vista camera, which
  // is frontal light — the single largest reason the landform read flat no
  // matter how the key/fill ratio was tuned. 320 also puts the sun 31 degrees
  // off the coast-line pose's forward vector, which is what the sea needs for a
  // specular glitter track to exist at all.
  const azimuth = 271 + (dayT - 0.5) * 130;
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

// --- atmosphere colours (LINEAR, post sky-curve) ----------------------------
// One source of truth. The sky's horizon band, scene.fog, the terrain's aerial
// perspective and the water's distance tint all read from these two.

/**
 * Near/mid in-scatter: low-sun dust. Pulled COOL and roughly 30% down in cycle
 * 5. This is the colour that gets added into the sky's bottom two degrees, and
 * at (0.60, 0.53, 0.45) it was single-handedly responsible for a chunk of the
 * warm achromatic slab the horizon measured (177,176,173, saturation 0.029)
 * against a reference horizon of (146,167,190) at saturation 0.255.
 */
export function hazeNearLinearFor(timeOfDay: number): [number, number, number] {
  const warm = 1 - Math.min(sunElevationFor(timeOfDay) / 50, 1);
  const cool: [number, number, number] = [0.30, 0.40, 0.60];
  const hot: [number, number, number] = [0.55, 0.45, 0.40];
  return [
    cool[0] + (hot[0] - cool[0]) * warm,
    cool[1] + (hot[1] - cool[1]) * warm,
    cool[2] + (hot[2] - cool[2]) * warm,
  ];
}

/**
 * Far in-scatter: the blue-shifted end of the aerial-perspective ladder. Far
 * ridges have to come out COOLER and with B > R, which a single-colour fog can
 * never do — that was the "everything past 250m goes white" failure.
 */
export function hazeFarLinearFor(timeOfDay: number): [number, number, number] {
  const warm = 1 - Math.min(sunElevationFor(timeOfDay) / 50, 1);
  return [0.22 + 0.10 * warm, 0.29 + 0.06 * warm, 0.44 - 0.02 * warm];
}

/**
 * Base extinction density for FogExp2 and the custom terrain/water fog.
 *
 * three's FogExp2 is `1 - exp(-(d*density)^2)`, and the terrain and water fog
 * use the SAME quadratic form, so one number governs every surface in the build
 * and land, trees, buildings and sea cannot disagree about depth any more.
 *
 * 0.00168 -> 0.00100 (cycle 5). 0.00168 put 50% extinction at 495m and 81% at
 * 800m, and the vista capture measured the mid field already ~70% washed out
 * while the reference frames stay legible past 800m. The reference's distant
 * hills sit at value 0.47 against a sky of 0.75 — they are roughly 60% fogged
 * at ~1km, NOT 95%. At 0.00100 the curve is 2% at 150m, 15% at 400m, 47% at
 * 800m, 63% at 1km and 90% at 1.6km, which is that ladder.
 *
 * The other half of the fix is chromatic: the fog colour is now the sky's own
 * horizon radiance, and that radiance is no longer a warm achromatic wash (see
 * the horizon tint block in CLOUD_BODY), so distant land goes BLUE with the
 * atmosphere instead of grey with a desaturation hack.
 */
export const FOG_DENSITY = 0.00100;
/**
 * Scale height of the exponential height fog, metres.
 *
 * 330 -> 200. At 330 a valley floor at 10m and a ridge crest at 90m attenuated
 * by 0.97 and 0.76 of the base density — a 20% spread that is invisible, so
 * fog was effectively a pure function of range and a ridge top hazed exactly
 * like the valley beneath it. At 200 the same pair runs 0.95 / 0.64 and haze
 * visibly pools in the low ground, which is most of what reads as "depth".
 */
export const FOG_HEIGHT = 200.0;

/**
 * What the sea converges to at the horizon. Only a fallback now: the water and
 * the terrain both sample the SKY CUBE for their in-scatter colour (see
 * skyCubeUniform), so the land/sea/sky junction converges by construction
 * rather than by three hand-matched constants that drifted apart.
 */
export const SEA_HORIZON_LINEAR: [number, number, number] = [0.395, 0.470, 0.630];

/**
 * EXPLICIT SKY IRRADIANCE — the single number that decides whether a shadow is
 * a shadow or a hole.
 *
 * Cycle 3 delivered its whole ambient through the PMREM at envMapIntensity 0.72
 * plus a 0.17-irradiance hemisphere light, i.e. roughly 1.0 total against a key
 * of 22. That is a 20:1 split before the baked terrain occlusion, and on a rock
 * albedo of 0.05 linear it puts a sun-shadowed face at 4/255 — 64% of the
 * measured ridge came out at literally (0,0,0). No outdoor surface under an open
 * sky can do that.
 *
 * These two terms are added to the terrain's `irradiance` DIRECTLY and are never
 * multiplied by the shadow term. Sky is blue-shifted (a shadow's chroma is the
 * only thing that says "the sun was removed" rather than "the exposure fell");
 * ground is the warm bounce that keeps downward-facing facets off zero.
 *
 * Budgeted against a horizontal surface: direct = sin(elev) * SUN_INTENSITY,
 * ambient = sky. At the default 16.5 tod that is 0.402 * 8.0 = 3.2 against 1.1,
 * a 2.9:1 split — a clear-sky cast shadow removes ~74% of the illuminance, which
 * is what the reference frame measures (shadowed wheat p50 57.8 against a lit
 * p50 of 95.9, i.e. 0.60 in display bytes ~ 0.30 in linear).
 */
export function skyAmbientFor(timeOfDay: number): {
  sky: [number, number, number];
  ground: [number, number, number];
} {
  const e = sunElevationFor(timeOfDay);
  // Skylight falls off far more slowly than the direct beam as the sun sets:
  // at 5 degrees the sky is still delivering roughly a third of its noon value
  // while the beam has lost 90%. That is why late light reads blue in shadow.
  const lift = 0.34 + 0.66 * THREE.MathUtils.clamp(e / 45, 0, 1);

  // CYCLE 5 REBALANCE. The previous pair was (3.02, 4.77, 8.58) sky and
  // (1.59, 1.54, 1.40) ground at the default time of day. Two things were wrong
  // and they compounded:
  //
  //   1. BLUE OUT-DELIVERED THE SUN. Direct blue irradiance on a horizontal
  //      face was 22 * sin(23.7) * 0.81 = 7.0; sky blue was 8.6. Ambient was
  //      literally the dominant source in the blue channel, everywhere, lit or
  //      not. The capture measured a sunlit rock face at ratios 1.00:0.97:0.94
  //      (achromatic) and the SAME material's shade at 1.00:1.12:1.26, hue 212
  //      — a 185-degree hue swing into navy. PUBG's reference does the opposite:
  //      lit 26.6 deg / shadow 25.2 deg, a 1.4-degree swing, value alone drops.
  //   2. TOTAL LEVEL was ~0.64 of the direct luminance rather than ~0.4, so
  //      nothing had a real shaded side.
  //
  // The rebuild is parameterised on ONE number, A, the red-channel sky
  // irradiance on an up-facing surface, and picks the sky/ground chromaticities
  // so a VERTICAL face (0.55 sky + 0.45 ground, per the two-lobe split in the
  // terrain's lights_fragment_maps patch) lands on 1.00:0.95:0.94 — the
  // acceptance target. Solving that pair gives ground = 0.66 * sky in red with
  // a warm khaki bounce, which is what a dry Erangel field actually returns.
  //
  // Budget at the default tod (e = 23.7, A = 3.02):
  //   direct  luminance = 22 * sin(23.7) * lum(1.00,0.79,0.60) = 7.28
  //   ambient luminance = A * lum(1.00,1.02,1.15)              = 3.10
  //   -> 0.43, i.e. a clear-sky cast shadow removes ~70% of the illuminance
  //      and a shadowed patch renders at ~0.5 of a lit one in display bytes.
  const A = 4.40 * lift;
  return {
    // Mildly blue, not steeply. An up-facing surface reads 1.00:1.02:1.15.
    sky: [A, A * 1.02, A * 1.15],
    // Warm khaki bounce off the sunlit ground — this is the term whose absence
    // let shaded rock collapse to the sky's own hue at low value.
    ground: [A * 0.66, A * 0.66 * 0.82, A * 0.66 * 0.55],
  };
}

/**
 * The sky rendered into a small cube map at boot, shared as ONE uniform object
 * so the terrain and the water can bind it before it exists.
 *
 * This is what closes findings 2/11/13/16 by construction rather than by
 * tuning: a fogged pixel takes its in-scatter colour from the same dome the
 * camera sees behind it, sampled along the same view ray, so at the far plane
 * land, sea and sky converge on ONE value and the horizon cannot carry a seam.
 * Cycle 3 fogged the land toward one hand-authored cool constant and the sea
 * toward another, and the sky toward a third — hence a sea 33/255 darker than
 * the sky it met and a dead grey plateau above both.
 */
export const skyCubeUniform: { value: THREE.CubeTexture | null } = { value: null };

/**
 * The sky's PMREM. Materials that call useSkyEnv() get it bound DIRECTLY rather
 * than inheriting scene.environment, because three overwrites
 * material.envMapIntensity with scene.environmentIntensity for any standard
 * material whose own envMap is null (WebGLRenderer.setProgram). That silently
 * pinned every surface in the build at env intensity 1.0 — the terrain asked
 * for 0.075 and got 1.0, so sky IBL out-delivered the key roughly 4:1 and no
 * hill had a lit side. Binding the map per material makes the authored
 * intensity real again.
 */
export const skyEnv: {
  map: THREE.Texture | null;
  pending: THREE.MeshStandardMaterial[];
} = { map: null, pending: [] };

/** Bind the sky PMREM to this material as its own envMap (see skyEnv). */
export function useSkyEnv(mat: THREE.MeshStandardMaterial): void {
  if (skyEnv.map) {
    mat.envMap = skyEnv.map;
    mat.needsUpdate = true;
  } else {
    skyEnv.pending.push(mat);
  }
}

const CLOUD_HELPERS = /* glsl */ `
uniform vec3 uHaze;          // LINEAR, matched to the terrain/water fog
uniform float uHazeStrength;
uniform float uCloudCover;   // threshold: higher = less cloud
uniform float uCloudDensity;
uniform float uCloudLum;     // raw-radiance scale for lit cloud
uniform vec3 uSunTint;
uniform float uSunDisc;
uniform float uSkyExposure;
uniform float uSkyWhite;

// Henyey-Greenstein, normalised to 1.0 straight down the sun vector. g is kept
// well under the physical 0.75-0.9 of a water droplet because the un-normalised
// lobe spans two orders of magnitude between forward and side scatter and turns
// every cloud away from the sun into a hole.
float hg( float mu, float g ) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * mu;
  float fwd = pow( 1.0 + g2 - 2.0 * g, 1.5 );
  return fwd / max( pow( max( d, 1e-4 ), 1.5 ), 1e-4 );
}

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

// Bounded PRE-compression, not a display curve. The dome spans 0.65 -> 12 raw
// and the global ACES mapper wants its input inside roughly 0..3; this maps
// that range onto ~0.14..0.87 with a monotonic gradient the whole way. The old
// dial pair (0.48 / 7.0) was tuned when this WAS the display curve, and it put
// the entire lower dome inside a 0.85-0.90 window — 115 vertical pixels of one
// value, brighter than every land pixel in the frame.
vec3 skyCurve( vec3 c ) {
  c *= uSkyExposure;
  return c * ( 1.0 + c / ( uSkyWhite * uSkyWhite ) ) / ( 1.0 + c );
}
`;

const CLOUD_BODY = /* glsl */ `
	// Cloud deck: projected onto a flat plane so it converges toward the horizon
	// the way real cover does. Composited in RAW radiance, before the curve, so
	// cloud and sky are graded by one function and cannot disagree.
	float cosSun = dot( direction, vSunDirection );
	float cloudMask = 0.0;

	if ( direction.y > - 0.01 ) {
		// Bounded projection. A true flat plane (xz / y) compresses without
		// limit toward the horizon. The floor caps the compression; it has to
		// be low enough that an eye-height camera — which spends most of its
		// frame under 15 degrees — still sees a deck at all.
		vec2 cuv = direction.xz / ( max( direction.y, 0.0 ) * 0.9 + 0.09 );
		float drift = time * 0.0035;
		// Octave count by screen footprint: the horizon band is compressed ~11x
		// and would alias into static at full octaves.
		float comp = length( cuv );
		int oct = comp > 9.0 ? 3 : 5;

		// Cumulus: domain-warped fbm thresholded by coverage, then eroded so the
		// bases are ragged rather than one soft blob.
		vec2 p = cuv * 1.6 + vec2( drift, drift * 0.4 );
		float w = cfbm( p * 0.5, 3 );
		float cum = cfbm( p + vec2( w, w * 0.8 ) * 1.7, oct );
		float mask = smoothstep( uCloudCover, uCloudCover + 0.16, cum );
		mask *= 1.0 - smoothstep( 0.45, 0.95, cfbm( p * 3.1 + 9.0, 3 ) ) * 0.45;

		// Cirrus: warped PER OCTAVE, otherwise every streak radiates from the
		// projection's single vanishing point and reads as one stretched sheet.
		vec2 q = vec2( cuv.x * 0.22, cuv.y * 1.25 ) * 1.3 + drift * 0.6;
		vec2 cw = vec2( cfbm( q * 0.35 + 4.2, 3 ), cfbm( q * 0.28 - 2.1, 3 ) ) - 0.5;
		q += cw * 2.4;
		float cir = cfbm( q, 4 );
		cir = smoothstep( 0.44, 0.76, abs( cir - 0.5 ) * 2.0 );
		cir *= smoothstep( 0.54, 0.30, cum );

		// Low stratus band: its own drift rate, so the 2-15 degree band that an
		// eye-height camera lives in carries structure instead of one value.
		vec2 sv = cuv * vec2( 0.38, 0.9 ) * 0.55 - drift * 1.9;
		float strat = cfbm( sv + vec2( cfbm( sv * 0.6, 2 ), 0.0 ) * 1.4, 4 );
		strat = smoothstep( 0.60, 0.84, strat );
		strat *= smoothstep( 0.005, 0.055, direction.y ) * ( 1.0 - smoothstep( 0.10, 0.24, direction.y ) );

		// Clouds thin toward the horizon but must NOT vanish there.
		float horizonFade = smoothstep( 0.004, 0.13, direction.y );
		mask *= horizonFade;
		cir *= horizonFade * 0.8;

		// --- LIGHT the layer, do not stain the sky with it ---------------------
		// Cycle 3 alpha-blended a grey ramp over the dome, and every cloud in all
		// five shots measured DARKER than the sky behind it (73,77,85 against a
		// 61,111,142 sky: 23% down), so the deck read as dirt on the lens. A
		// cloud is a lit body: it emits its own radiance and is composited OVER
		// the sky, and on the sun side its top has to WIN.
		//
		// Everything here is RAW radiance, pre-curve, where the dome spans about
		// 0.65 at the zenith to 12 at the horizon. uCloudLum is therefore the
		// raw value of a fully sunlit cloud top and has to live in that range —
		// at cycle 3's 2.1 the brightest possible cloud was dimmer than the sky
		// below 25 degrees no matter what the shading did.
		float thickness = smoothstep( uCloudCover + 0.01, uCloudCover + 0.34, cum );
		// Beer (extinction into the cloud) x Powder (the dark-edge effect that
		// makes real cumulus read as volume rather than cotton wool).
		float beer = exp( - thickness * 2.3 );
		float powder = 1.0 - exp( - thickness * 5.0 );
		// Thin edges are the BRIGHT part of a cloud — light gets through them.
		// The first shape here peaked at 0.44, so nothing in the deck ever got
		// within half of the lit value and the layer still measured level with
		// the sky it sat on.
		float depthLit = beer * ( 0.45 + 0.55 * powder ) + 0.25 * ( 1.0 - thickness );
		// Forward scatter: the sun side of the deck is brighter than the far side.
		float fwd = hg( cosSun, 0.55 );
		vec3 lit = uSunTint * uCloudLum * ( 0.72 + 0.55 * fwd );
		// Bases take the sky, not black — a shaded cumulus base is blue-grey.
		vec3 shade = vec3( 0.34, 0.40, 0.52 ) * uCloudLum * 0.30;
		vec3 cloudCol = mix( shade, lit, clamp( depthLit, 0.0, 1.0 ) );
		// Silver lining: thin edges within a few degrees of the sun blow out.
		float rim = pow( max( cosSun, 0.0 ), 8.0 ) * 1.5 * ( 1.0 - thickness );
		cloudCol += uSunTint * uCloudLum * rim * 0.55;

		cloudMask = clamp( mask * uCloudDensity, 0.0, 1.0 );
		texColor = mix( texColor, cloudCol, cloudMask );
		// Cirrus is optically thin: nearly all of it is lit, none of it is base.
		texColor = mix( texColor, lit * 0.92 + uSunTint * uCloudLum * rim * 0.4, clamp( cir, 0.0, 1.0 ) );
		texColor = mix( texColor, mix( shade, lit, 0.62 ), clamp( strat * 0.22, 0.0, 1.0 ) );
		cloudMask = max( cloudMask, clamp( cir, 0.0, 1.0 ) );
	}

	// Grade the dome. Everything after this line is display-linear.
	texColor = skyCurve( texColor );

	// HORIZON CHROMA as a MULTIPLY, not a mix toward a constant.
	//
	// Cycle 4's version warmed the whole low band toward (1.10, 0.985, 0.855)
	// regardless of where the sun was, and the capture measured the sky just
	// above the horizon at (177, 176, 173) — saturation 0.029, hue 38, i.e. a
	// warm achromatic slab. The Erangel reference measures (146, 167, 190),
	// saturation 0.255, hue 212. Since BOTH the terrain and the sea take their
	// aerial-perspective colour from this dome, that one error was also the sea
	// reading grey (saturation 0.024), the distant hills reading grey, and the
	// horizon line ceasing to exist.
	//
	// Rayleigh is the away-from-sun term and it is BLUE; Mie is the toward-sun
	// term and it is warm. Interpolating between the two by the azimuth angle to
	// the sun is the cheap version of that split, and it is directional, so the
	// coast pose still gets its gold sun-side horizon while the vista pose gets
	// a blue one.
	//
	// The cool tint is solved backwards from the measurement: current dome
	// horizon is ~(0.302, 0.298, 0.290) scene-linear and the target is
	// ~(0.192, 0.255, 0.365), a ratio of (0.64, 0.86, 1.26). Its luminance is
	// 0.84, so the band darkens ~16% as well, which is what lets ground read
	// against it at all.
	{
		float sunAz = pow( max( dot( normalize( direction.xz + 1e-5 ), normalize( vSunDirection.xz + 1e-5 ) ), 0.0 ), 2.0 );
		// Widened 0.095 -> 0.28 (5.4 -> 16 degrees). The achromatic band in the
		// vista capture ran from the horizon to roughly 17 degrees up; a 5-degree
		// correction left most of it untouched.
		// Widened again to 0.42 (24 degrees) and the cool tint strengthened after
		// measuring the first pass: at edge 0.28 the effective band strength at
		// the screen row where the haze slab actually sits back-solved to only
		// 0.40, so the correction landed at under half the intended amount
		// (B-R moved -11.8 -> +9.0 where it needed to reach roughly +45).
		float band = smoothstep( 0.42, - 0.02, direction.y );
		vec3 cool = vec3( 0.56, 0.84, 1.38 );
		vec3 warm = vec3( 1.30, 1.02, 0.72 );
		vec3 tint = mix( cool, warm, sunAz * 0.88 );
		texColor *= mix( vec3( 1.0 ), tint, band * uHazeStrength );
		// A small lift right at the waterline only (dust and spray), two degrees
		// deep. uHaze is now itself a cool colour, so this can no longer drag the
		// band back toward grey.
		texColor += uHaze * smoothstep( 0.030, - 0.010, direction.y ) * 0.07;
	}

	// Sun disc + aureole, added AFTER the curve so the disc stays above 1.0 and
	// reaches the bloom threshold instead of being compressed into the sky.
	{
		// ANGLE, from the cross product rather than from acos or a dot-product
		// threshold. |a x b| = sin(theta) is well conditioned at theta -> 0,
		// where 1 - dot is catastrophic cancellation, and it is circular by
		// construction — cycle 3's disc measured 1.35:1 wide because a
		// threshold at cos = 0.99996 is 4e-5 from the top of the float and the
		// isoline broke up along the screen axes.
		float sinA = length( cross( direction, vSunDirection ) );
		float front = step( 0.0, cosSun );
		// 0.53 degrees of angular diameter, i.e. the real one, plus half a
		// pixel of edge so it does not stair-step.
		float disc = ( 1.0 - smoothstep( 0.0040, 0.0058, sinA ) ) * front;
		float aureole = ( exp( - sinA * 26.0 ) * 0.85 + exp( - sinA * 4.2 ) * 0.11 ) * front;
		// Disc gain 16 -> 10.5 and the aureole widened. At 16 the core clipped to
		// a flat (235,235,235) dot with no chromaticity left in it, which is
		// physically impossible for a 20-degree sun; at 10.5 the tone curve still
		// blows the core but the first few pixels of falloff keep the light's own
		// warm colour, so the disc and the key finally agree.
		texColor += uSunTint * ( disc * 10.5 + aureole * 2.1 ) * uSunDisc * ( 1.0 - cloudMask * 0.85 );
	}

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
  skyExposure: number;
  skyWhite: number;
}

/** Injects the cloud/curve/haze layer into a Sky instance's shader. */
function patchSky(sky: Sky, d: SkyDials, sunDir: THREE.Vector3, showSunDisc: boolean): void {
  const mat = sky.material as THREE.ShaderMaterial;
  const u = mat.uniforms;
  u.sunPosition.value.copy(sunDir);
  u.turbidity.value = d.turbidity;
  u.rayleigh.value = d.rayleigh;
  u.mieCoefficient.value = d.mieCoefficient;
  u.mieDirectionalG.value = d.mieDirectionalG;
  // The addon's own disc is a 19000x spike inside the pre-curve radiance; ours
  // rides on top of the curve instead.
  u.showSunDisc.value = 0;
  u.uHaze = { value: new THREE.Vector3(...d.haze) };
  u.uHazeStrength = { value: d.hazeStrength };
  u.uCloudCover = { value: d.cloudCover };
  u.uCloudDensity = { value: d.cloudDensity };
  u.uCloudLum = { value: d.cloudLum };
  u.uSunTint = { value: d.sunTint.clone() };
  u.uSunDisc = { value: showSunDisc ? 1 : 0 };
  u.uSkyExposure = { value: d.skyExposure };
  u.uSkyWhite = { value: d.skyWhite };

  const src = mat.fragmentShader;
  const head = src.indexOf('// Clouds');
  const tailMarker = 'gl_FragColor = vec4( texColor, 1.0 );';
  const tail = src.indexOf(tailMarker);
  if (head < 0 || tail < 0) return; // addon changed shape: keep the stock dome

  mat.fragmentShader = (src.slice(0, head) + CLOUD_BODY + src.slice(tail)).replace(
    'void main() {',
    `${CLOUD_HELPERS}\nvoid main() {`
  );
}

// --- shadow frustum fitting -------------------------------------------------
// One directional shadow whose ortho box is refitted to the camera's frustum
// every frame. It carries PROPS ONLY — buildings, poles, fences, trees — and
// the terrain is no longer in its caster set.
//
// That split is deliberate. A single 2048 map stretched over a 700m vista is
// 0.9 m/texel, which is too coarse for a fence post's contact shadow and too
// close to the light plane for a ridge 600m up-sun to even be inside the
// frustum. Landform self-shadowing now comes from a CPU horizon-march baked
// into the terrain control map (terrain.ts buildOcclusion), which is exact to
// 1.2m over the whole 1200m island, costs one texture fetch, and takes 524K
// triangles back out of the depth pass. What is left for the real-time map is
// the near field, so the fit range collapses to ~250m and buys 0.12 m/texel.

const UP = new THREE.Vector3(0, 1, 0);
const _target = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _lightM = new THREE.Matrix4();
const _viewM = new THREE.Matrix4();

function fitSunShadow(sun: THREE.DirectionalLight, sunDir: THREE.Vector3, camera: THREE.Camera): void {
  const cam = camera as THREE.PerspectiveCamera;
  if (!cam.isPerspectiveCamera) return;

  cam.getWorldDirection(_fwd);
  const groundY = 0;
  const camH = Math.max(cam.position.y - groundY, 1.0);
  const pitchDown = Math.max(-_fwd.y, 0);
  const dist = Math.min(
    quality.shadowDistance,
    Math.max(70, 55 + camH * 2.4 + pitchDown * 180)
  );

  _target.set(cam.position.x, 0, cam.position.z);
  _eye.copy(sunDir).multiplyScalar(500).add(_target);
  _lightM.lookAt(_eye, _target, UP);
  _lightM.setPosition(_eye);
  _viewM.copy(_lightM).invert();

  const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const d of [Math.max(cam.near, 0.5), dist]) {
    const hh = tanH * d;
    const hw = hh * cam.aspect;
    for (let s = 0; s < 4; s++) {
      const sx = s & 1 ? 1 : -1;
      const sy = s & 2 ? 1 : -1;
      _corner.set(sx * hw, sy * hh, -d).applyMatrix4(cam.matrixWorld).applyMatrix4(_viewM);
      if (_corner.x < minX) minX = _corner.x;
      if (_corner.x > maxX) maxX = _corner.x;
      if (_corner.y < minY) minY = _corner.y;
      if (_corner.y > maxY) maxY = _corner.y;
      if (_corner.z < minZ) minZ = _corner.z;
      if (_corner.z > maxZ) maxZ = _corner.z;
    }
  }
  // Snap the box to whole shadow texels so it does not swim under camera motion.
  const texel = Math.max(maxX - minX, maxY - minY) / quality.shadowMapSize;
  minX = Math.floor(minX / texel) * texel;
  maxX = Math.ceil(maxX / texel) * texel;
  minY = Math.floor(minY / texel) * texel;
  maxY = Math.ceil(maxY / texel) * texel;

  const cs = sun.shadow.camera;
  cs.left = minX; cs.right = maxX; cs.bottom = minY; cs.top = maxY;
  // Normal-offset bias scaled to the CURRENT texel footprint (~1.5 texels). The
  // fit range moves with the camera, so a constant bias is either acne at vista
  // range or detached contact shadows at eye level.
  sun.shadow.normalBias = texel * 1.5;
  // main.ts parks the light 500m up-sun of the camera's ground point, so the
  // whole 250m fit box sits comfortably in front of it. Pull near back to the
  // light plane and push far past the box so nothing standing between the two
  // is clipped out of the depth pass.
  cs.near = Math.max(0.5, -maxZ - 260);
  cs.far = -minZ + 260;
  cs.updateProjectionMatrix();

  sun.target.position.copy(_target);
  sun.position.copy(_eye);
}

export function createAtmosphere(timeOfDay: number): Atmosphere {
  const sky = new Sky();
  sky.scale.setScalar(45000);
  // Draw after the opaque terrain: the dome is pinned to the far plane with
  // depthWrite off, so covered pixels get rejected before the cloud maths runs.
  sky.renderOrder = 1000;

  const elevation = sunElevationFor(timeOfDay);
  const sunDir = sunDirectionFor(timeOfDay);
  const haze = hazeNearLinearFor(timeOfDay);

  const sunTint = sunTintFor(timeOfDay);
  const dials: SkyDials = {
    // Rayleigh up 2.6 -> 3.1: the measured zenith was RGB 96,138,155 at B/R
    // 1.62 against a reference zenith of 65,101,138 at B/R 2.14, i.e. the dome
    // was a pale wash rather than a deep blue. Mie is no longer suppressed
    // (0.0011 -> 0.0017) because the horizon band needs a residual gradient of
    // its own now that the flat haze mix that used to cover it is gone.
    turbidity: 1.9,
    rayleigh: 3.4,
    mieCoefficient: 0.0013,
    mieDirectionalG: 0.80,
    cloudCover: 0.535,
    cloudDensity: 0.96,
    // RAW radiance of a fully sunlit cloud top, in the dome's own 0.65-12 range.
    // 2.1 made the brightest possible cloud dimmer than the sky under 25
    // degrees of elevation, which is why every cloud measured as a grey stain.
    cloudLum: 13.0,
    haze,
    // Weight on the horizon chroma multiply. 1.0 so the solved-backwards tint
    // above lands exactly on its measured target rather than 85% of the way.
    hazeStrength: 1.0,
    sunTint,
    // Both dials re-chosen for the global ACES mapper (see skyCurve).
    skyExposure: 0.235,
    skyWhite: 5.0,
  };
  patchSky(sky, dials, sunDir, true);

  // Sun colour is authored LINEAR. setHSL()/hex go through sRGB decode, which
  // silently cost the old key ~3.4 stops and left it a colourless straw. The
  // key is chromatically WARM and the fill chromatically COOL — that split is
  // half of what makes a face read as turned away from the sun rather than just
  // darker.
  // Disc and key now come off ONE curve, so the visible sun and the light it
  // casts cannot disagree about colour temperature.
  const sunColor = new THREE.Color().setRGB(sunTint.x, sunTint.y, sunTint.z);
  // HELD at 22 — deliberately, after measuring. The contrast defect was never
  // that the key was too hot: solving the two captures simultaneously for the
  // ridge slope gave a rock albedo of 0.059 LINEAR and a direct term already
  // carrying ~95% of the light there, so pulling the key down (a cycle-4 trial
  // at 8.0) simply took 1.7 stops off the whole frame and left the ratio
  // exactly where it was. The fix is entirely on the fill side: skyAmbientFor
  // now delivers ~3.9 of irradiance against this key's 8.84 on a horizontal
  // surface, a 2.3:1 split, so a clear-sky cast shadow removes ~70% of the
  // illuminance instead of ~90%+.
  const sun = new THREE.DirectionalLight(sunColor, 22.0);
  sun.position.copy(sunDir).multiplyScalar(500);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 1400;
  sun.shadow.bias = -0.0006;
  // 0.4 was ~20 shadow texels — it detached every contact shadow the moment
  // anything actually cast one.
  sun.shadow.normalBias = 0.08;

  // The sky half of the fill is carried by the PMREM (which is directional, so
  // it actually shades), and this light only adds the GROUND BOUNCE the IBL
  // cannot see: warm, weak, and biased downward. Running both at full strength
  // double-counts the sky and flattens everything back out.
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.00);
  // Sky side pulled off blue and down: it stacks on top of the explicit sky
  // irradiance the terrain adds, and at (0.07,0.10,0.15) it was one more cold
  // term nudging every shaded surface toward the same navy.
  hemi.color.setRGB(0.055, 0.062, 0.076);
  hemi.groundColor.setRGB(0.22, 0.190, 0.145);

  // Frame-stepped clock: capture waits a fixed frame count, so a fixed dt keeps
  // every screenshot byte-comparable between cycles.
  let frame = 0;
  sky.onBeforeRender = (_r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera) => {
    (sky.material as THREE.ShaderMaterial).uniforms.time.value = frame++ / 60;
    // The shadow map renders before the scene, so this lands one frame later —
    // harmless for a static capture and imperceptible in motion.
    fitSunShadow(sun, sunDir, camera);
  };
  (window as unknown as Record<string, unknown>).__PROBE__ = () => {
    const cs = sun.shadow.camera;
    return {
      sunPos: sun.position.toArray(),
      tgt: sun.target.position.toArray(),
      intensity: sun.intensity,
      color: sun.color.toArray(),
      castShadow: sun.castShadow,
      ortho: [cs.left, cs.right, cs.bottom, cs.top, cs.near, cs.far],
      mapSize: sun.shadow.mapSize.toArray(),
      hasMap: !!sun.shadow.map,
    };
  };

  return {
    sky,
    sun,
    hemi,
    sunDir,
    bakeEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
      (window as unknown as Record<string, unknown>).__RS__ = { renderer, scene };
      const pmrem = new THREE.PMREMGenerator(renderer);
      const skyScene = new THREE.Scene();
      const skyClone = new Sky();
      skyClone.scale.setScalar(45000);
      // Sun disc off for the bake: a hot texel smears into a blotch.
      patchSky(skyClone, dials, sunDir, false);
      skyScene.add(skyClone);
      const envRT = pmrem.fromScene(skyScene, 0.0);
      scene.environment = envRT.texture;
      // The global default for every material that does NOT bind the map
      // itself (buildings, vegetation, characters). It used to be an implicit
      // 1.0, which is a full-strength sky bounce on every surface in the world
      // and the reason nothing had a shaded side. 0.42 -> 0.62 alongside the
      // sky irradiance being tripled for the terrain: the sun:sky split for the
      // OTHER lanes was running near 26:1 on a horizontal surface, which is
      // roughly ten times the clear-sky physical value and is why their shadow
      // sides crushed. 1.30 puts them at ~5:1, close to the terrain's own.
      scene.environmentIntensity = 1.30;
      skyEnv.map = envRT.texture;

      // The sky as a cube, for in-scatter and for the sea's mirror. 128px per
      // face is plenty: it is only ever read as a fog colour or through a wave
      // normal, and both are low-frequency reads. Disc off (a hot texel would
      // smear into the fog); the haze band and the cloud deck are in, so a fog
      // sample under a cloud is correctly duller than one under blue sky.
      const cubeRT = new THREE.WebGLCubeRenderTarget(128, {
        type: THREE.HalfFloatType,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      const cubeCam = new THREE.CubeCamera(1.0, 120000, cubeRT);
      cubeCam.update(renderer, skyScene);
      skyCubeUniform.value = cubeRT.texture;
      for (const m of skyEnv.pending) {
        m.envMap = envRT.texture;
        m.needsUpdate = true;
      }
      skyEnv.pending.length = 0;
      pmrem.dispose();
    },
  };
}

/**
 * Extinction for the stock fog path (buildings, vegetation). The terrain and
 * the water replace <fog_fragment> with a distance-dependent in-scatter that
 * uses hazeNear/hazeFar; this keeps everything else on the same near colour.
 *
 * The colour is LINEAR because the composite path is linear (see the note at
 * the top of this file) — authoring it as a display value is what made the
 * distance read as one flat achromatic wash.
 */
export function createFog(timeOfDay = parseBootParams().timeOfDay): THREE.FogExp2 {
  const [r, g, b] = hazeMidLinearFor(timeOfDay);
  const color = new THREE.Color().setRGB(r, g, b);
  return new THREE.FogExp2(color, FOG_DENSITY);
}

/**
 * The single colour every OTHER lane's fog converges on: the sky's own horizon
 * radiance in scene-linear, measured off the dome (display 0.44 at the horizon
 * band, i.e. ~0.62 scene-referred through the inverse of the ACES curve).
 *
 * Cycle 3 pointed the stock fog at hazeNear — a warm low-sun dust colour of
 * (0.74,0.55,0.34) — so distant trees fogged toward orange while the terrain
 * behind them fogged toward a cool blue and the sky sat somewhere else again.
 * Land and vegetation at equal depth disagreed by about 3x, which is why the
 * treeline reads as floating in front of the island rather than standing in it.
 */
export function hazeMidLinearFor(timeOfDay: number): [number, number, number] {
  const warm = 1 - Math.min(sunElevationFor(timeOfDay) / 50, 1);
  // Retargeted in cycle 5 onto the dome's NEW horizon radiance. The old triple
  // resolved to (0.664, 0.646, 0.667) at the default tod — achromatic, and
  // roughly 2.5x too bright, so every tree LOD and every building faded into a
  // pale grey that the terrain behind them (which fogs toward the sky cube) no
  // longer matched. This is the scene-linear value that tone-maps onto the
  // reference's (146,167,190) horizon.
  return [0.17 + 0.10 * warm, 0.24 + 0.04 * warm, 0.40 - 0.09 * warm];
}
