import type { MaterialRecipe } from '../gen/texgen';

// Terrain surface category recipes. Albedo is authored in sRGB; the factory
// linearizes. Height drives both the normal map and cavity AO, so give it
// real structure. PUBG Erangel palette: dry khaki-to-ochre fields, warm dirt,
// grey-brown rock, compacted dirt road.
//
// THREE RULES, all learned from captures that looked wrong in a specific way:
//
// 1. TILING RULE. The GLSL noise lattice takes ONE scalar period, so any
//    non-uniform scale on p must have its axes in an integer ratio and must
//    pass the SMALLER scale as the period. `fbm(p * vec2(8.0, 24.0),
//    uPeriod * 8.0, ...)` tiles once in x and three times in y — correct.
//    `fbm(p * vec2(0.8, 3.4), uPeriod * 3.4, ...)` does not tile at all.
//
// 2. LOW-FREQUENCY BOUND. Nothing that drives ALBEDO may run below ~16 lattice
//    cells per tile. A 3m texture carrying 1m blobs shows those blobs marching
//    across the field in lockstep, and no amount of stochastic sampling hides
//    it. All large-scale variation — patchiness, hue drift, crop parcels — is
//    generated in the terrain shader at world scale instead.
//
// 3. HIGH-FREQUENCY BOUND (this is the one that was missing). No octave may
//    exceed textureSize/4 lattice cells, i.e. 4 pixels per cell at the top
//    octave. `p = uv * uPeriod` with uPeriod 8, so a multiplier m and N octaves
//    reach `8 * m * 2^(N-1)` cells; at textureSize 1024 that must stay <= 256,
//    so `m * 2^(N-1) <= 32`. Break it and the aliasing is BAKED INTO the
//    texture, where no mip chain and no anisotropy can ever recover it — the
//    near field becomes permanent salt-and-pepper static. Every recipe below
//    notes its cell count.

export const grassFieldRecipe: MaterialRecipe = {
  name: 'grassField',
  period: 8,
  // NOTE: texgen multiplies this by size * 0.012, i.e. ~12 at 1024. The first
  // pass ran 0.75-1.6 here, which tilted the surface normal tens of degrees per
  // TEXEL — the detail normal then dominated N.L and randomised the form
  // shading, which is a large part of why two opposite hill faces measured
  // 1.05:1. These values are deliberately gentle.
  normalStrength: 0.34,
  aoStrength: 0.8,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Tile is 3m of world (DETAIL_TILE), so cells -> metres is 3 / cells.
  // fine  88 cells x2 oct -> 176 top  (3.4cm blade speckle, 5.8 px/cell)
  // mid   22 cells x3 oct ->  88 top  (13.6cm clods and thatch)
  // lay   48/96 cells x2  -> 192 top  (directional lay, 2:1 not 3:1)
  float fine = fbm(p * 11.0, uPeriod * 11.0, 2, 0.5);
  float mid = fbm(p * 2.75, uPeriod * 2.75, 3, 0.5);
  // The lay term is a 2:1 anisotropic field, so its comb direction is the SAME
  // everywhere in the world — it is baked into the tile, and the tile is applied
  // in world XZ. That is the global "combed filament smear at one screen angle"
  // the capture picks up across the fields, the gravel and the pond banks
  // alike. Cut 0.18 -> 0.07; the anisotropy that is left reads as grass lay
  // rather than as a smudge tool.
  float lay = fbm(p * vec2(6.0, 12.0), uPeriod * 6.0, 2, 0.5);
  float blades = fine * 0.36 + mid * 0.57 + lay * 0.07;

  // Real 15-40cm structure so the near field has FORM instead of noise: soil
  // clods, and thresholded bare-earth scars.
  //
  // The clod term used to be smoothstep(0.34, 0.06, F2 - F1), which is a cell
  // WALL network — F2-F1 goes to zero exactly on the boundary — so grass and
  // dirt were each wearing their own 15cm polygonal lattice and the capture
  // reads one continuous cell pattern running under both. Now it is F1, i.e.
  // blobs at cell CENTRES, which is what a clod actually is, and its weight is
  // halved.
  vec3 vor = voronoi(p * 2.5, uPeriod * 2.5);
  float clod = smoothstep(0.30, 0.04, vor.x);
  float bare = smoothstep(0.56, 0.74, fbm(p * 2.0 + 11.3, uPeriod * 2.0, 2, 0.5));
  // Sparse soil shows through where blades thin out.
  float soil = clamp(smoothstep(0.40, 0.22, blades) * 0.7 + bare * 0.55 + clod * 0.25, 0.0, 1.0);

  // Erangel is khaki-to-ochre, not sage. The value range is deliberately ~1.5x
  // wider than the first pass: a narrow pastel ramp is what made the plains
  // read as one tonal wash at every distance.
  vec3 lush = vec3(0.360, 0.400, 0.225);
  vec3 dry = vec3(0.600, 0.550, 0.400);
  vec3 straw = vec3(0.735, 0.660, 0.455);
  vec3 grassCol = mix(lush, dry, smoothstep(0.26, 0.70, mid));
  grassCol = mix(grassCol, straw, smoothstep(0.48, 0.86, blades) * 0.62);
  vec3 soilCol = vec3(0.330, 0.258, 0.172);
  albedo = mix(grassCol, soilCol, soil * 0.62);
  albedo *= 0.90 + 0.20 * fine;

  height = blades * 0.76 + clod * 0.11 - bare * 0.12;
  rough = 0.88 + 0.1 * (1.0 - blades);
  metal = 0.0;
}
`,
};

export const dirtRecipe: MaterialRecipe = {
  name: 'dirt',
  // 0.50 -> 0.28. See the crack note below: with the cell-wall network gone the
  // remaining signal is genuine soil grain, and at 0.50 that grain was still
  // tilting the surface enough to read as embossed plastic in the near field.
  normalStrength: 0.28,
  period: 8,
  aoStrength: 1.0,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // grain 80 cells x2 -> 160 top;  clod 20 x3 -> 80;  pebbles 60-cell voronoi;
  // aggregate 24-cell voronoi for mixed stone in the soil.
  float grain = fbm(p * 10.0, uPeriod * 10.0, 2, 0.5);
  float clod = fbm(p * 2.5, uPeriod * 2.5, 3, 0.5);
  // PEBBLES AS PEBBLES, NOT AS A LATTICE.
  //
  // This was smoothstep(0.10, 0.28, F2 - F1), which is high in cell INTERIORS
  // and zero on every boundary — i.e. a filled polygon tiling with dark gutters
  // between the cells, at 60 cells on a 2.4m tile (4cm). Driving both albedo and
  // 0.34 of height with it gave every cell a bevelled rim, and that is the
  // Voronoi crocodile skin still visible across the near road after the crack
  // network came out of this recipe. F1 instead gives round blobs at cell
  // CENTRES, and gating on the per-cell random leaves gaps between them, so it
  // reads as scattered aggregate sitting in soil rather than as crazy paving.
  vec3 vor = voronoi(p * 7.5, uPeriod * 7.5);
  float pebble = smoothstep(0.17, 0.03, vor.x) * step(0.48, vor.z);

  // THE CRACK NETWORK IS GONE FROM THIS RECIPE.
  //
  // It used to be smoothstep(0.05, 0.0, abs(vnoise(p*2.0) - 0.5) - 0.02) at
  // 16 cells per tile. The terrain samples this map at a 2.4m tile, so those
  // were 15cm polygonal cells with a bevelled rim, at ONE frequency, covering
  // every square metre of verge and road shoulder in the world — the crocodile
  // skin the near field reads as. And because it also drove HEIGHT at -0.25,
  // it fed the terrain's category height-blend, so grass won inside every cell
  // gutter and green bled through the lattice, which is the tell that the blend
  // mask and the crack function were the same signal.
  //
  // It cannot be fixed here: rule 2 above forbids anything under ~16 cells per
  // tile in albedo, which forces the cell size to 15cm. It now lives in the
  // terrain shader at WORLD scale (0.6-1.1m cells, albedo only, masked by an
  // independent dryness field, faded out by 26m).
  //
  // What replaces it is what dirt actually looks like: a mixed-grain aggregate
  // and two decorrelated soil-mottle octaves.
  vec3 agg = voronoi(p * 3.0, uPeriod * 3.0);
  float stone = smoothstep(0.20, 0.03, agg.x) * step(0.62, agg.z);
  float mottleA = fbm(p * 4.5 + 13.7, uPeriod * 4.5, 3, 0.5);
  float mottleB = fbm(p * vec2(6.0, 12.0) + 41.3, uPeriod * 6.0, 2, 0.5);

  vec3 dark = vec3(0.268, 0.204, 0.140);
  vec3 mid = vec3(0.432, 0.348, 0.242);
  vec3 light = vec3(0.556, 0.470, 0.344);
  vec3 stoneCol = vec3(0.470, 0.442, 0.398);
  albedo = mix(dark, mid, clod);
  albedo = mix(albedo, light, pebble * (0.55 + 0.45 * vor.z) * 0.30);
  albedo = mix(albedo, stoneCol, stone * 0.34);
  albedo *= 0.90 + mottleA * 0.20;
  albedo *= 0.94 + mottleB * 0.12;
  albedo *= 0.9 + grain * 0.2;

  height = clod * 0.44 + pebble * 0.12 + stone * 0.14 + grain * 0.26 + mottleA * 0.12;
  rough = 0.93 - pebble * 0.08 - stone * 0.06;
  metal = 0.0;
}
`,
};

export const rockRecipe: MaterialRecipe = {
  name: 'rock',
  period: 6,
  normalStrength: 0.55,
  aoStrength: 1.0,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Tile is ~6m of world (the terrain samples rock at duv * 0.5).
  // strata 18/72 cells x2 -> 36/144;  fracture 24 x3 -> 96;  chips 36-cell vor.
  // Axes kept in a 1:4 ratio so the strata still tile (TILING RULE above).
  float strata = fbm(p * vec2(3.0, 12.0), uPeriod * 3.0, 2, 0.5);
  float fracture = ridged(p * 4.0, uPeriod * 4.0, 3);
  vec3 vor = voronoi(p * 6.0, uPeriod * 6.0);
  float chip = smoothstep(0.05, 0.24, vor.x);
  float blocky = smoothstep(0.12, 0.02, vor.y - vor.x);
  float fine = fbm(p * 10.0, uPeriod * 10.0, 2, 0.5);

  // Erangel rock is a warm grey-brown schist, NOT neutral: an unsaturated grey
  // at this value reads as unpainted polystyrene under a low sun.
  // Values pulled ~18% down from the previous set. With a real tone curve and a
  // key that actually lands, the old mid (0.49) put a sunlit face at display
  // 0.85+ and the peak read as chalk rather than schist.
  // CYCLE 5: the cool ramp sat at hue 214 — literally slate BLUE — and it was
  // mixed in at 0.30 over the darker half of the strata. Stacked on a sky
  // irradiance that was itself blue-dominant, the measured mid-tone rock came
  // out hue 215 and the whole ridge read as denim rather than stone. The
  // reference's rock is hue 25-30 lit and hue 25 in crevice: it does not change
  // hue at all, only value. The cool ramp is now a NEUTRAL grey-brown at the same
  // value, so the material stays inside hue 25-40 everywhere on the ramp.
  vec3 dark = vec3(0.352, 0.318, 0.272);
  vec3 mid = vec3(0.480, 0.434, 0.372);
  vec3 warm = vec3(0.575, 0.484, 0.354);
  vec3 cool = vec3(0.392, 0.376, 0.352);
  albedo = mix(dark, mid, strata);
  albedo = mix(albedo, warm, smoothstep(0.5, 0.9, fracture) * 0.55);
  albedo = mix(albedo, cool, smoothstep(0.62, 0.24, strata) * 0.30);
  albedo *= 0.82 + chip * 0.20 + fine * 0.10;
  // Deep crevice darkening between blocks — the cavity read the flat grey lost.
  // 0.24 -> 0.15, and the dark/mid ends of the ramp lifted ~25%: with the
  // lighting split fixed, the FLOOR of this material is what a sun-shadowed
  // rock face is made of, and at 0.048 linear it could not clear 40/255 under
  // any physically sane skylight. The lit end is untouched, so the sunward
  // face does not go back to reading as chalk.
  albedo *= 1.0 - blocky * 0.15;
  // Lichen and moss in the cavities: rock is never one flat grey.
  float moss = smoothstep(0.35, 0.1, fracture) * vnoise(p * 9.0, uPeriod * 9.0);
  albedo = mix(albedo, vec3(0.225, 0.240, 0.150), moss * 0.42);

  height = fracture * 0.48 + strata * 0.28 + chip * 0.18 - blocky * 0.22;
  rough = 0.84 - smoothstep(0.6, 1.0, fracture) * 0.10 + fine * 0.08;
  metal = 0.0;
}
`,
};

export const asphaltRecipe: MaterialRecipe = {
  name: 'asphalt',
  period: 8,
  // 0.35 -> 0.20 alongside the aggregate flattening above.
  normalStrength: 0.20,
  aoStrength: 0.9,
  glsl: /* glsl */ `
void materialSample(in vec2 uv, out vec3 albedo, out float height, out float rough, out float metal) {
  vec2 p = uv * uPeriod;
  // Tile is 2.6m of world. aggregate 48-cell voronoi (5.4cm gravel);
  // wear 24 x3 -> 96;  crack 24 x3 -> 96;  fine 96 x2 -> 192.
  vec3 vor = voronoi(p * 6.0, uPeriod * 6.0);
  float aggregate = smoothstep(0.02, 0.16, vor.x);
  float wear = fbm(p * 3.0, uPeriod * 3.0, 3, 0.5);
  float crackNoise = ridged(p * 3.0, uPeriod * 3.0, 3);
  // Narrowed 0.86-0.99 -> 0.91-0.995 and thinned in the wear mask. At the old
  // width the ridged network covered the whole surface at one constant ~11cm
  // cell size and the near road read as a dried lakebed rather than a track.
  // Narrowed again (0.91 -> 0.955) and the wear gate tightened. This is the
  // same defect as the dirt recipe's crack network, one octave down: a ridged
  // web at a single ~11cm cell across the entire metalled strip. The road's
  // compaction story is carried by the ruts and crown in the terrain shader,
  // not by crazing.
  float crack = smoothstep(0.955, 0.998, crackNoise) * smoothstep(0.60, 0.82, wear);
  float fine = fbm(p * 12.0, uPeriod * 12.0, 2, 0.5);
  // Compacted fines: the surface a vehicle actually polishes. Carries the
  // albedo where the crack network used to.
  float fines = fbm(p * 5.0, uPeriod * 5.0, 3, 0.55);

  // A compacted DIRT road, not tarmac. The previous slate-blue base multiplied
  // against the field tint came out at hue ~214 degrees and read as wet denim;
  // this base sits at hue ~34 degrees, which is what a rural Erangel track is.
  vec3 fresh = vec3(0.360, 0.300, 0.228);
  vec3 faded = vec3(0.550, 0.478, 0.372);
  albedo = mix(fresh, faded, smoothstep(0.28, 0.74, wear));
  // Aggregate contrast 0.28 -> 0.11. At 48 cells on a 2.6m tile these are 5.4cm
  // stones, and at 0.28 of albedo swing each one carried a full pillow-emboss
  // dome — which is the polygonal lattice the near road still reads as after the
  // crack network came out. Real gravel at this scale is a subtle speckle.
  albedo *= 0.90 + (1.0 - aggregate) * 0.11 + fine * 0.1;
  albedo *= 0.90 + fines * 0.22;
  albedo *= 1.0 - crack * 0.20;

  height = 0.5 + (1.0 - aggregate) * 0.035 + fine * 0.05 - crack * 0.10 + wear * 0.05 + fines * 0.06;
  // Polish where the fines pack down; grit stays matte.
  rough = 0.90 + crack * 0.06 - (1.0 - aggregate) * 0.08 - fines * 0.14;
  metal = 0.0;
}
`,
};

export const TERRAIN_RECIPES = [grassFieldRecipe, dirtRecipe, rockRecipe, asphaltRecipe];
