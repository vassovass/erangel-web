import type { MaterialRecipe } from '../gen/texgen';
import { quality } from '../core/settings';

// Building surface recipes — owned by the buildings stream (3), separate from
// the terrain stream's library.ts. Erangel rural kit: weathered plaster,
// rusted sheet-metal roofs, sun-bleached plank wood, fired brick, straw.
//
// Scale discipline: these textures are read at 1-4 m. Anything with a feature
// larger than ~1 m belongs in per-building vertex colour (world/buildings.ts
// tints each building and darkens the band under the eaves), NOT in the tile —
// macro-scale noise inside a 2.6 m tile is what made the walls read blotchy.

/**
 * WORLD-REFERENCED relief strength.
 *
 * texgen's sobel pass computes `uStrength = normalStrength * size * 0.012`, so
 * the baked normal's slope is tied to texture RESOLUTION rather than to world
 * scale: at 1024 that multiplier is 12.29x, which turned brick's 0.55 height
 * step at a mortar joint into a surface normal tilted ~82 degrees off the face
 * (the village well read as loose LEGO blocks with mutually contradictory
 * shading). texgen is owned by another lane, so the coupling is inverted HERE:
 * relief(k) returns the normalStrength that makes uStrength come out as k
 * whatever the texture size is. Every recipe below states its relief in those
 * world-referenced units, and doubling textureSize no longer doubles the bump.
 *
 * Read through a getter because quality.textureSize can be changed by boot
 * params after this module is evaluated but before anything is baked.
 */
function relief(k: number): number {
  return k / (Math.max(64, quality.textureSize) * 0.012);
}

export const plasterRecipe: MaterialRecipe = {
  name: 'plaster',
  period: 6,
  get normalStrength() { return relief(5.0); },
  aoStrength: 0.95,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;

  // Stucco tooth: two high-frequency layers at low amplitude. This is the only
  // grain that should survive at wall scale. The micro layer used to run at
  // p*41 which mips to flat grey below ~4 px/cell on a 1024 tile — 23 keeps it
  // resolvable at the range a wall is actually read.
  float grain = fbm(p * 17.0, uPeriod * 17.0, 3, 0.5);
  float micro = fbm(p * 23.0, uPeriod * 23.0, 2, 0.5);
  // Trowel mottling at two incommensurate scales so the blob cluster does not
  // repeat visibly across one gable. Both stay on the tiling lattice.
  float mottle = wfbm(p * 3.0, uPeriod * 3.0, 0.7, 3);
  float mottleB = wfbm(p * 7.0 + 13.3, uPeriod * 7.0, 0.9, 3);
  mottle = mottle * 0.62 + mottleB * 0.38;

  // Rain streaking: high frequency across the wall, very low frequency down it,
  // which reads as long vertical smears. Two scales so the streaks vary in width.
  float streakA = fbm(vec2(p.x * 21.0, p.y * 0.40), uPeriod * 21.0, 3, 0.6);
  float streakB = fbm(vec2(p.x * 31.0, p.y * 0.85), uPeriod * 31.0, 2, 0.5);
  float streak = smoothstep(0.48, 0.78, streakA) + smoothstep(0.60, 0.88, streakB) * 0.6;

  // Render fallen away in patches, exposing the brick-toned scratch coat. The
  // old 0.805 threshold was above what this wfbm reaches in practice, so none of
  // the damage grammar ever made it to screen.
  float dmgN = wfbm(p * 3.8 + 7.7, uPeriod * 3.8, 1.1, 4);
  float dmg = smoothstep(0.66, 0.76, dmgN);
  float dmgLip = smoothstep(0.58, 0.67, dmgN) * (1.0 - dmg);
  float crack = smoothstep(0.78, 0.90, ridged(p * 3.6, uPeriod * 3.6, 4));
  float hair = smoothstep(0.86, 0.97, ridged(p * 9.0 + 3.1, uPeriod * 9.0, 3));

  // Held well below white: at 16:30 sun with ACES a 0.8 albedo wall clips to
  // paper and takes the eave AO band with it. Erangel plaster is dirty cream,
  // and it has to stay off the top of the range now that a real key lands on it.
  vec3 clean = vec3(0.595, 0.575, 0.525);
  vec3 soiled = vec3(0.420, 0.392, 0.336);
  vec3 scratch = vec3(0.385, 0.290, 0.226);

  albedo = mix(clean, soiled, smoothstep(0.28, 0.72, mottle) * 0.66);
  albedo *= 0.94 + grain * 0.10 + micro * 0.05;
  albedo *= 1.0 - clamp(streak, 0.0, 1.0) * 0.28;
  albedo = mix(albedo, scratch, dmg);
  albedo *= 1.0 - dmgLip * 0.20;
  albedo *= 1.0 - crack * 0.46;
  albedo *= 1.0 - hair * 0.22;

  height = 0.64 + grain * 0.07 + micro * 0.03 - dmg * 0.34 - crack * 0.30 - hair * 0.10;
  rough = 0.88 - dmg * 0.04 + clamp(streak, 0.0, 1.0) * 0.05;
  metal = 0.0;
}
`,
};

export const roofMetalRecipe: MaterialRecipe = {
  name: 'roofMetal',
  period: 8,
  get normalStrength() { return relief(11.0); },
  aoStrength: 0.8,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // RIB AXIS. gableRoof builds the slab as BoxGeometry(slope, t, runD) and maps
  // UVs BEFORE the rotate, so on the top face uv.x runs DOWN-SLOPE and uv.y runs
  // along the ridge. A rib is a line of constant phase, so varying the sinusoid
  // along uv.y makes ribs that run down-slope — which is the direction water has
  // to leave by. Varying along uv.x (the old code) dammed the roof and, at
  // uPeriod*6 = 48 cycles across a 2.8 m tile (21 texels/cycle at 1024), moired
  // into the diagonal chevron hatch on every slope in the set. At 3.0 the rib
  // pitch is ~11.6 cm / 42 texels per cycle, which is plausible sheet and does
  // not alias. Panel end-laps then run ACROSS the slope, i.e. along uv.x.
  float corr = sin(uv.y * uPeriod * 6.2831 * 3.0) * 0.5 + 0.5;
  float seam = smoothstep(0.04, 0.0, abs(fract(uv.x * uPeriod) - 0.5) - 0.46);
  float rustMask = wfbm(p * 1.1, uPeriod * 1.1, 2.0, 4);
  float rust = smoothstep(0.45, 0.75, rustMask);
  float deepRust = smoothstep(0.65, 0.88, rustMask);
  float speck = fbm(p * 20.0, uPeriod * 20.0, 3, 0.5);
  // Streaks of rust bleeding down the corrugations.
  float bleed = smoothstep(0.58, 0.86, fbm(vec2(p.x * 0.5, p.y * 24.0), uPeriod * 24.0, 2, 0.55));

  vec3 paint = vec3(0.42, 0.24, 0.18);      // faded oxide-red paint
  vec3 rustCol = vec3(0.44, 0.26, 0.12);
  vec3 deepRustCol = vec3(0.28, 0.15, 0.08);
  albedo = mix(paint, rustCol, rust);
  albedo = mix(albedo, deepRustCol, deepRust * (0.5 + speck * 0.5));
  albedo = mix(albedo, rustCol * 0.8, bleed * 0.35);
  albedo *= 0.85 + corr * 0.2 + speck * 0.1;
  albedo *= 1.0 - seam * 0.35;

  height = 0.5 + corr * 0.22 - seam * 0.25 - deepRust * 0.1;
  // A sheet-metal roof under a low sun carries a broad grazing sheen; the old
  // 0.55 floor with metalness dropping to 0.20 over rust made every slope read
  // as matte paper. Clean sheet is smooth and properly metallic, rust patches
  // break the highlight into bands rather than washing it out everywhere. The
  // corrugation modulates roughness along its own axis so the sheen is striped.
  // Floor raised to 0.44: below that a mip-averaged rib normal on a distant roof
  // resolves as single-pixel specular sparkle rather than as a sheen.
  rough = 0.44 + rust * 0.30 + deepRust * 0.14 + speck * 0.05 + bleed * 0.05 - corr * 0.05;
  // Held under 0.5: past that the diffuse term all but disappears and a drum or
  // a roof slope becomes a black mirror of a dim environment.
  metal = 0.46 - rust * 0.24 - deepRust * 0.12;
}
`,
};

export const woodPlankRecipe: MaterialRecipe = {
  name: 'woodPlank',
  period: 6,
  get normalStrength() { return relief(6.5); },
  aoStrength: 0.9,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;

  // BOARDS. This used to call brickGrid(uv.yx, vec2(uPeriod*0.5, uPeriod*4.0))
  // whose second axis gets its joint width scaled by count.x/count.y — 3/24 —
  // so the 24 board joints across the tile were 0.7 texels wide and mipped to
  // nothing past ~8 m, while the 3 "courses" on the other axis got a 44-texel
  // joint that banded every shed wall horizontally. Explicit here instead: 24
  // vertical boards per tile (0.19 m boards at WOOD_TILE 4.6 m) with a real
  // 10 mm gap, and NO cross-course at all — planks run the full height.
  float bcount = uPeriod * 4.0;
  float bpos = uv.x * bcount;
  float bid = floor(bpos);
  float bf = fract(bpos);
  float brnd = hash12(pmod(vec2(bid, 5.0), bcount));
  // 0.055 of a board on each edge = ~10 mm at a 0.19 m board.
  float joint = smoothstep(0.0, 0.055, bf) * smoothstep(1.0, 0.945, bf);

  float grain = fbm(vec2(p.x * 2.0 + brnd * 13.0, p.y * 22.0), uPeriod * 22.0, 4, 0.55);
  float knot = smoothstep(0.12, 0.02, voronoi(p * vec2(2.0, 4.0) + brnd * 9.0, uPeriod * 4.0).x);
  float weather = wfbm(p * 1.2, uPeriod * 1.2, 1.6, 3);

  // Weathered farm timber, not fresh pine: the old palette went salmon in
  // sunlight, so this pulls the red down and lets the grey dominate. The dark
  // mix is held off black — fence rails and log piles measured 2/255 against a
  // lit plaster wall, which is a legibility problem as much as a look one.
  vec3 fresh = vec3(0.330, 0.262, 0.186);
  vec3 grey = vec3(0.322, 0.308, 0.284);     // sun-bleached
  vec3 dark = vec3(0.140, 0.112, 0.084);
  albedo = mix(fresh, grey, smoothstep(0.18, 0.62, weather));
  // Joint contrast has to carry the board read on its own once the 10 mm gap
  // mips away, so it is hard (0.85) and the per-board tone spread is wide
  // enough (+/-0.17) to survive to the first few mips.
  albedo = mix(albedo, dark, (1.0 - joint) * 0.85 + knot * 0.45);
  albedo *= 0.87 + grain * 0.20 + (brnd - 0.5) * 0.34;

  height = joint * 0.42 + grain * 0.10 - knot * 0.16 - (1.0 - joint) * 0.30;
  rough = 0.80 + weather * 0.10 - grain * 0.05;
  metal = 0.0;
}
`,
};

/** Fired brick — chimneys, yard walls, the village well. */
export const brickRecipe: MaterialRecipe = {
  name: 'brick',
  period: 4,
  get normalStrength() { return relief(3.2); },
  aoStrength: 1.0,
  glsl: /* glsl */ `
// Local brick grid. The shared brickGrid() scales the SECOND axis' joint by
// count.x/count.y, which for an 8 x 28 course grid makes bed joints 12x too
// thin — the reason the coursing was carried almost entirely by an over-driven
// normal map and vanished to a mushy brown post at 40 m. Both joints are stated
// in cell fractions here, so both come out ~12 mm on a 0.225 x 0.064 m brick.
vec4 bkGrid(vec2 uvw, vec2 count, float jointU, float jointV) {
  vec2 q = uvw * count;
  float crs = floor(q.y);
  q.x += mod(crs, 2.0) * 0.5;
  vec2 cel = floor(q);
  vec2 f = fract(q);
  float mu = smoothstep(0.0, jointU, f.x) * smoothstep(1.0, 1.0 - jointU, f.x);
  float mv = smoothstep(0.0, jointV, f.y) * smoothstep(1.0, 1.0 - jointV, f.y);
  return vec4(mu * mv, hash12(pmod(cel, max(count.x, count.y))), f.x, f.y);
}

void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // At BRICK_TILE = 1.8 m an 8 x 28 grid lands on 0.225 m x 0.064 m courses with
  // a half-brick stagger.
  vec4 course = bkGrid(uv, vec2(uPeriod * 2.0, uPeriod * 7.0), 0.055, 0.19);
  float body = course.x;          // 1 inside a brick, 0 in the mortar joint
  float id = course.y;            // per-brick random

  float grit = fbm(p * 27.0, uPeriod * 27.0, 3, 0.5);
  float soot = wfbm(p * 1.9, uPeriod * 1.9, 1.3, 3);
  float chip = smoothstep(0.74, 0.90, fbm(p * 9.5 + id * 21.0, uPeriod * 9.5, 3, 0.5));

  // Old, damp, soot-stained brick. Bright red reads as toy plastic at 30 m.
  vec3 red = vec3(0.320, 0.183, 0.140);
  vec3 pale = vec3(0.415, 0.290, 0.225);
  vec3 burnt = vec3(0.205, 0.122, 0.098);
  vec3 face = mix(red, pale, id);
  face = mix(face, burnt, step(0.87, id));
  face *= 0.86 + grit * 0.24;
  face *= 1.0 - chip * 0.20;

  // Mortar lifted and the joint widened so the COURSING lives in albedo and
  // survives mip-down, instead of being carried by relief that disappears.
  vec3 mortar = vec3(0.52, 0.50, 0.47) * (0.84 + grit * 0.26);
  albedo = mix(mortar, face, body);
  albedo = mix(albedo, albedo * 0.62, smoothstep(0.56, 0.88, soot));

  // 10 mm proud on a 225 mm brick — not the 0.55 step that tilted every joint
  // normal 82 degrees off the wall.
  height = body * 0.16 + grit * 0.05 - chip * 0.08;
  rough = 0.90 - body * 0.06;
  metal = 0.0;
}
`,
};

/** Baled/piled straw — haystacks and barn bales. */
export const strawRecipe: MaterialRecipe = {
  name: 'straw',
  period: 4,
  get normalStrength() { return relief(6.0); },
  aoStrength: 1.0,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Strands run around the stack, so the noise is heavily anisotropic. The
  // frequency used to put a strand every 11 mm, which on a 2.5 m rick at 12 m
  // is sub-pixel — it mipped to one flat mustard gradient and the anisotropy,
  // the whole point of the recipe, never reached screen. 16/34 lands the strand
  // courses around 30-70 mm, which is thatch-course scale and survives to 20 m.
  float strand = fbm(vec2(p.x * 2.0, p.y * 16.0), uPeriod * 16.0, 3, 0.55);
  float fine = fbm(vec2(p.x * 3.0 + 11.0, p.y * 34.0), uPeriod * 34.0, 2, 0.5);
  float clump = wfbm(p * 4.2, uPeriod * 4.2, 1.1, 3);
  float wet = smoothstep(0.56, 0.86, wfbm(p * 1.7 + 3.3, uPeriod * 1.7, 1.0, 3));

  vec3 gold = vec3(0.585, 0.470, 0.225);
  vec3 bleach = vec3(0.700, 0.610, 0.375);
  vec3 dun = vec3(0.335, 0.270, 0.145);
  // Contrast-stretched: the raw fbm hovers near 0.5 for most of its range, so
  // mix(gold, bleach, strand) averaged to one flat mustard the moment the tile
  // mipped, and the strand DIRECTION — the whole point of an anisotropic noise —
  // stopped reading past about 6 m.
  albedo = mix(gold, bleach, smoothstep(0.25, 0.75, strand));
  albedo = mix(albedo, dun, wet * 0.65 + (1.0 - clump) * 0.22);
  albedo *= 0.84 + fine * 0.30;

  height = strand * 0.55 + fine * 0.25 + clump * 0.16;
  rough = 0.95 - strand * 0.05;
  metal = 0.0;
}
`,
};
