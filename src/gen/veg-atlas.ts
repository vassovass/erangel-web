import * as THREE from 'three';
import { hash2 } from './noise';

// Canvas-drawn vegetation atlases, all deterministic in the seed.
//
// Three earned rules live here and none of them are optional:
//
//  1. NOTHING is allowed to bake a "grounding" gradient into the bottom of a
//     billboard tile. Cycle 1 did, and once mip filtering averaged that band it
//     rose above the fragment discard threshold, turning the foot of every
//     clump into a solid ground-coloured rectangle that wrote depth. Root
//     darkening is a SHADER job (it has the vRoot varying) — never a texture job.
//
//  2. Alpha coverage has to be preserved down the mip chain by hand
//     (Castano's alpha-tested magnification). A box-filtered cutout loses
//     coverage every level, so mid-distance foliage dissolves into speckle and
//     near foliage fattens into slabs. `alphaMips` rescales each level's alpha
//     so the fraction of texels above the cutoff matches level 0.
//
//  3. Colour must be dilated under the transparent texels BEFORE mipping, or
//     the filtered edge drags (0,0,0,0) into the silhouette and every card gets
//     a dark or bright fringe.

export const COVER_TILE = 256;
/** Tiles in the ground-cover atlas. 0-4 + 7 are clumps, 5-6 + 8-9 are swathes. */
export const COVER_TILES = 10;
/**
 * Wide multi-clump tiles used by the far grass tier. Two was not enough: with
 * a per-instance mirror that is four apparent silhouettes across the whole
 * mid-to-far band, and the critics could read the repeat as a pattern. Four
 * tiles mirrored is eight.
 */
export const SWATH_TILES = [5, 6, 8, 9];
/** Single-clump tiles used by the mid grass tier. */
export const CLUMP_TILES = [0, 1, 2, 3, 4, 7];

export const LEAF_TILE = 256;
export const LEAF_TILES = 5;
export const LEAF_OAK = 0;
export const LEAF_BIRCH = 1;
export const LEAF_PINE = 2;
export const LEAF_BRAMBLE = 3;
/** Waist-high broadleaf shrub — deliberately GREENER than the ochre sward, so
 *  the mid-height stratum reads as a different plant, not as tall grass. */
export const LEAF_SHRUB = 4;

/** Alpha cutoff every foliage shader discards below. */
export const ALPHA_CUTOFF = 0.42;

function stream(seed: number): () => number {
  let i = 1;
  return () => hash2(seed, i++);
}

function rgb(r: number, g: number, b: number, a = 1): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

function newCanvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  return { c, ctx };
}

/** Dilates opaque colour outward into transparent texels (see rule 3). */
function bleedAlpha(ctx: CanvasRenderingContext2D, w: number, h: number, passes = 3): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = d[i * 4 + 3] > 6 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const srcFilled = filled.slice();
    const src = new Uint8ClampedArray(d);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (srcFilled[idx]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (!srcFilled[q]) continue;
            r += src[q * 4]; g += src[q * 4 + 1]; b += src[q * 4 + 2]; n++;
          }
        }
        if (n > 0) {
          d[idx * 4] = r / n; d[idx * 4 + 1] = g / n; d[idx * 4 + 2] = b / n;
          filled[idx] = 1;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

function coverageOf(data: Uint8ClampedArray, cut: number, scale: number): number {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (Math.min(255, data[i] * scale) >= cut) n++;
  return n / (data.length / 4);
}

/**
 * Builds the full mip chain by hand, rescaling alpha per level so the coverage
 * at ALPHA_CUTOFF stays equal to level 0's. Returns canvases (level 0 first)
 * for THREE.Texture.mipmaps.
 */
function alphaMips(src: HTMLCanvasElement): HTMLCanvasElement[] {
  const cut = ALPHA_CUTOFF * 255;
  const base = src.getContext('2d')!.getImageData(0, 0, src.width, src.height);
  const target = coverageOf(base.data, cut, 1);
  const levels: HTMLCanvasElement[] = [src];
  let prev = src;
  let w = src.width;
  let h = src.height;
  while (w > 1 || h > 1) {
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    const { c, ctx } = newCanvas(w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(prev, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    // Binary-search the alpha scale that restores level 0's coverage.
    let lo = 0.25, hi = 6.0;
    for (let it = 0; it < 12; it++) {
      const mid = (lo + hi) * 0.5;
      if (coverageOf(img.data, cut, mid) < target) lo = mid;
      else hi = mid;
    }
    const s = (lo + hi) * 0.5;
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = Math.min(255, d[i] * s);
    ctx.putImageData(img, 0, 0);
    levels.push(c);
    prev = c;
  }
  return levels;
}

function cutoutTexture(c: HTMLCanvasElement, aniso: number): THREE.Texture {
  const tex = new THREE.Texture(c);
  tex.mipmaps = alphaMips(c) as unknown as THREE.Texture['mipmaps'];
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Ground-cover billboard atlas (mid + far grass tiers)
// ---------------------------------------------------------------------------

/**
 * One blade: narrow sheath, widest near 40% height, drawn to a point, with a
 * per-blade lean. Straight vertical spikes are the single strongest non-AAA
 * tell in a still frame, so `lean` is never zero.
 */
function blade(
  ctx: CanvasRenderingContext2D,
  bx: number, by: number, h: number, lean: number, w: number,
  base: [number, number, number], tip: [number, number, number], alpha: number
): void {
  const tipX = bx + lean;
  const tipY = by - h;
  const mx = bx + lean * 0.16;
  const my = by - h * 0.44;
  const wb = w * 0.26;
  const grad = ctx.createLinearGradient(bx, by, tipX, tipY);
  grad.addColorStop(0, rgb(base[0], base[1], base[2], alpha));
  grad.addColorStop(0.5, rgb((base[0] + tip[0]) * 0.5, (base[1] + tip[1]) * 0.5, (base[2] + tip[2]) * 0.5, alpha));
  grad.addColorStop(1, rgb(tip[0], tip[1], tip[2], alpha));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(bx - wb, by);
  ctx.quadraticCurveTo(mx - w * 0.5, my, tipX, tipY);
  ctx.quadraticCurveTo(mx + w * 0.5, my, bx + wb, by);
  ctx.closePath();
  ctx.fill();
}

interface ClumpStyle {
  blades: number;
  hMin: number; hMax: number;
  spread: number;
  dry: number;       // fraction of straw blades
  widthMul: number;
  lean: number;      // lean magnitude multiplier
  broad: number;     // fraction drawn as broadleaf paddles
  flowers: number;
}

// Measured against the Erangel field reference: the build's cycle-1 grass sat
// at hue 69 deg / sat 0.45, the reference field at hue 45 / sat 0.39. These
// stops put the lush ramp at hue ~54 and the straw ramp at ~40, both a little
// desaturated, which is what stops the meadow reading as spring-green stickers
// on khaki ground.
// Cycle 3 re-measured these against the reference field and moved them again:
// the build sat at hue 48-60 / S 53-64% where the Erangel field reads hue 30-34
// / S 33-46%. Rotating the tips down toward hue 32-46 and lifting the BLUE
// floor ~20% is what takes the sward off chartreuse and onto sun-bleached straw
// — and blue is also the only channel the sky ambient has to work with.
const GREEN_BASE: [number, number, number] = [46, 50, 34];
const GREEN_TIP: [number, number, number] = [138, 128, 96];
const STRAW_BASE: [number, number, number] = [78, 72, 56];
const STRAW_TIP: [number, number, number] = [184, 148, 107];

function drawClump(
  ctx: CanvasRenderingContext2D, ox: number, cx: number, floorY: number,
  scale: number, seed: number, st: ClumpStyle
): void {
  const r = stream(seed);
  // A short, SPARSE root band. Cycle 1 packed 44 filler blades in here; mip
  // filtering then averaged them into a solid slab. Twelve is enough to stop
  // the base reading stalky and never saturates a mip level.
  for (let i = 0; i < 12; i++) {
    const off = (r() + r() - 1) * 22 * scale;
    const by = floorY - r() * 8;
    const h = (16 + r() * 34) * scale;
    const lean = off * 0.9 + (r() - 0.5) * h * 0.7;
    const w = (2.0 + r() * 2.4) * st.widthMul * scale;
    const k = r();
    blade(ctx, cx + off, by, h, lean, w, [30, 33, 26], [48 + k * 18, 54 + k * 18, 36 + k * 14], 0.9);
  }

  for (let i = 0; i < st.blades; i++) {
    const depth = i / st.blades;
    const off = (r() + r() - 1) * 34 * st.spread * scale;
    const by = floorY - r() * 10;
    const h = (st.hMin + r() * (st.hMax - st.hMin)) * (0.70 + depth * 0.42) * scale;
    // Lean is deliberately large and signed off the root offset: blades fan out
    // of the tuft and arch over, which is what a frozen frame needs to read as
    // grass rather than as a bundle of skewers.
    const lean = (off * (0.5 + r() * 0.8) + (r() - 0.5) * h * 0.44) * st.lean;
    const lit = 0.62 + depth * 0.38;
    const k = r();
    const isBroad = r() < st.broad;
    const isDry = r() < st.dry;
    let base: [number, number, number];
    let tip: [number, number, number];
    if (isDry) {
      base = [STRAW_BASE[0] + k * 16, STRAW_BASE[1] + k * 14, STRAW_BASE[2] + k * 10];
      tip = [(STRAW_TIP[0] + k * 22) * lit, (STRAW_TIP[1] + k * 20) * lit, (STRAW_TIP[2] + k * 16) * lit];
    } else {
      // A few cooler blades break the flatness; the blue channel is what keeps
      // ACES from swinging bright yellow-greens to orange.
      const cool = r() < 0.20 ? 1 : 0;
      base = [GREEN_BASE[0] + k * 14, GREEN_BASE[1] + k * 16, GREEN_BASE[2] + k * 10 + cool * 8];
      tip = [
        (GREEN_TIP[0] + k * 26 - cool * 16) * lit,
        (GREEN_TIP[1] + k * 26) * lit,
        (GREEN_TIP[2] + k * 18 + cool * 22) * lit,
      ];
    }
    const w = isBroad
      ? (10 + r() * 12) * st.widthMul * scale
      : (2.0 + r() * 3.0) * st.widthMul * (0.8 + depth * 0.4) * scale;
    blade(ctx, cx + off, by, isBroad ? h * 0.55 : h, lean, w, base, tip, 0.88 + r() * 0.12);

    // Seed heads: thin spikelets only. Anything chunkier reads as orange
    // flowers once ACES has had its way with the hue.
    if (r() < 0.10 && !isBroad && h > st.hMin * scale) {
      const tipX = cx + off + lean;
      const tipY = by - h;
      const kk = r();
      ctx.fillStyle = rgb(120 + kk * 30, 114 + kk * 24, 70 + kk * 18, 0.85);
      ctx.beginPath();
      ctx.ellipse(tipX, tipY + h * 0.04, w * 0.5, h * 0.05, Math.atan2(h, lean) - Math.PI / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (let i = 0; i < st.flowers; i++) {
    const off = (r() + r() - 1) * 30 * scale;
    const h = (st.hMax * (0.6 + r() * 0.5)) * scale;
    const lean = (r() - 0.5) * h * 0.4;
    ctx.strokeStyle = rgb(72, 84, 44, 0.9);
    ctx.lineWidth = 1.3 * scale;
    ctx.beginPath();
    ctx.moveTo(cx + off, floorY);
    ctx.quadraticCurveTo(cx + off + lean * 0.3, floorY - h * 0.6, cx + off + lean, floorY - h);
    ctx.stroke();
    const k = r();
    // Cream / dusty-mauve umbels, never a saturated primary — and never near
    // white: at 214 they resolved as a scatter of paper flecks on the ridge.
    const fc: [number, number, number] = k < 0.6 ? [172, 166, 140] : [154, 140, 142];
    for (let p = 0; p < 6; p++) {
      ctx.fillStyle = rgb(fc[0] - r() * 24, fc[1] - r() * 24, fc[2] - r() * 20, 0.92);
      ctx.beginPath();
      ctx.arc(cx + off + lean + (r() - 0.5) * 9 * scale, floorY - h + (r() - 0.5) * 7 * scale, (1.6 + r() * 2.0) * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

const CLUMP_STYLES: ClumpStyle[] = [
  // 0 tall green tussock
  { blades: 210, hMin: 120, hMax: 236, spread: 0.85, dry: 0.14, widthMul: 1.0, lean: 1.0, broad: 0.0, flowers: 0 },
  // 1 tall dry / straw tussock
  { blades: 190, hMin: 130, hMax: 244, spread: 0.72, dry: 0.82, widthMul: 0.9, lean: 0.72, broad: 0.0, flowers: 0 },
  // 2 short green mat
  { blades: 230, hMin: 54, hMax: 128, spread: 1.05, dry: 0.10, widthMul: 1.16, lean: 1.3, broad: 0.0, flowers: 0 },
  // 3 broadleaf weed / dock rosette
  { blades: 96, hMin: 70, hMax: 150, spread: 0.95, dry: 0.06, widthMul: 1.0, lean: 1.5, broad: 0.55, flowers: 0 },
  // 4 fern-ish frond clump
  { blades: 120, hMin: 92, hMax: 178, spread: 0.9, dry: 0.04, widthMul: 1.5, lean: 1.35, broad: 0.35, flowers: 0 },
  // 5/6 swathes are drawn separately
  { blades: 0, hMin: 0, hMax: 0, spread: 0, dry: 0, widthMul: 1, lean: 1, broad: 0, flowers: 0 },
  { blades: 0, hMin: 0, hMax: 0, spread: 0, dry: 0, widthMul: 1, lean: 1, broad: 0, flowers: 0 },
  // 7 flowering herb tuft
  { blades: 130, hMin: 86, hMax: 176, spread: 0.9, dry: 0.16, widthMul: 0.95, lean: 1.1, broad: 0.05, flowers: 9 },
  // 8/9 swathes, drawn separately
  { blades: 0, hMin: 0, hMax: 0, spread: 0, dry: 0, widthMul: 1, lean: 1, broad: 0, flowers: 0 },
  { blades: 0, hMin: 0, hMax: 0, spread: 0, dry: 0, widthMul: 1, lean: 1, broad: 0, flowers: 0 },
];

/** Per-swath-tile style: green / straw / mixed-tall / mixed-low. */
const SWATH_STYLES: ClumpStyle[] = [
  { blades: 150, hMin: 175, hMax: 262, spread: 1.05, dry: 0.18, widthMul: 2.2, lean: 1.0, broad: 0.0, flowers: 0 },
  { blades: 140, hMin: 165, hMax: 256, spread: 1.05, dry: 0.74, widthMul: 2.1, lean: 0.8, broad: 0.0, flowers: 0 },
  { blades: 155, hMin: 150, hMax: 238, spread: 1.25, dry: 0.44, widthMul: 2.4, lean: 1.35, broad: 0.06, flowers: 0 },
  { blades: 165, hMin: 116, hMax: 196, spread: 1.35, dry: 0.60, widthMul: 2.0, lean: 1.15, broad: 0.0, flowers: 4 },
];

/**
 * Mean LINEAR rgb of a canvas's opaque texels.
 *
 * The mid/far card tiers divide the atlas sample by this so the tile becomes a
 * pure luminance/detail signal and both tiers can be driven by the near band's
 * one palette pair. Without it the near band coloured from uLush/uStraw while
 * the cards took colour straight off the bake, and the hand-over at ~15 m
 * carried a hard horizontal hue seam. Linear, because that is the space the
 * shader's texture fetch lands in for an sRGB texture.
 */
function meanLinearRGB(c: HTMLCanvasElement): THREE.Color {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const s2l = (v: number): number => {
    const u = v / 255;
    return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
  };
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < ALPHA_CUTOFF * 255) continue;
    r += s2l(d[i]); g += s2l(d[i + 1]); b += s2l(d[i + 2]); n++;
  }
  if (n === 0) return new THREE.Color(0.1, 0.1, 0.08);
  return new THREE.Color(r / n, g / n, b / n);
}

export interface CoverAtlas {
  tex: THREE.Texture;
  mean: THREE.Color;
}

/** Ground-cover atlas: 6 clump tiles plus 4 wide multi-clump swathes. */
export function makeCoverAtlas(seed: number): CoverAtlas {
  const W = COVER_TILE * COVER_TILES;
  const { c, ctx } = newCanvas(W, COVER_TILE);
  for (const t of CLUMP_TILES) {
    drawClump(ctx, t * COVER_TILE, t * COVER_TILE + COVER_TILE * 0.5, COVER_TILE, 1, seed + t * 977, CLUMP_STYLES[t]);
  }
  // Swathes for the far tier: a few overlapping clumps so one card covers
  // several metres of field. Keep them TALL relative to their width — a wide,
  // squat swath billboard reads as a straw bar lying across the hillside.
  for (let s = 0; s < SWATH_TILES.length; s++) {
    const t = SWATH_TILES[s];
    const ox = t * COVER_TILE;
    const st = SWATH_STYLES[s % SWATH_STYLES.length];
    // Four clumps per tile, at jittered heights so no two swathes share a
    // skyline. Cycle 2's pair of tiles gave the whole 52-152 m band one
    // silhouette motif, which is readable as a pattern from any camera.
    for (let i = 0; i < 4; i++) {
      const cx = ox + 34 + (i / 3) * (COVER_TILE - 68) + (hash2(seed + t, i * 7) - 0.5) * 22;
      const sc = 0.76 + hash2(seed + t * 3, i * 11) * 0.26;
      drawClump(ctx, ox, cx, COVER_TILE + 6, sc, seed + t * 613 + i * 47, st);
    }
  }
  // Measure BEFORE the dilation pass: bleedAlpha writes colour into texels that
  // are still transparent, and those must not drag the mean around.
  const mean = meanLinearRGB(c);
  bleedAlpha(ctx, W, COVER_TILE, 3);
  return { tex: cutoutTexture(c, 8), mean };
}

// ---------------------------------------------------------------------------
// Leaf-cluster atlas (tree crowns and bushes)
// ---------------------------------------------------------------------------
//
// These are CLUSTERS, not crowns. A crown-sized card has a closed convex
// outline and no sky reads through it; ten small clusters scattered around a
// branch skeleton give a ragged silhouette and real holes, which is the whole
// difference between a tree and a green blob at 80 m.

function leafSpray(
  ctx: CanvasRenderingContext2D, ox: number, seed: number,
  cols: [number, number, number][], leafW: number, leafH: number, count: number,
  needle: boolean
): void {
  const r = stream(seed);
  const cx = ox + LEAF_TILE * 0.5;
  const cy = LEAF_TILE * 0.5;

  // Lobes the cluster is built from. The cluster has to FILL its card: the
  // first attempt hung a few leaves off a twig and covered maybe 40% of the
  // tile, so 15 cards still left a tree looking like a bare skeleton.
  const lobes: { x: number; y: number; r: number }[] = [];
  for (let l = 0; l < 5; l++) {
    const a = (l / 5) * Math.PI * 2 + r() * 0.9;
    const d = 18 + r() * 42;
    lobes.push({ x: cx + Math.cos(a) * d * 1.05, y: cy + Math.sin(a) * d * 0.86, r: 38 + r() * 30 });
  }

  // Twig skeleton, drawn first so it reads through the gaps.
  for (let i = 0; i < 8; i++) {
    const lo = lobes[i % lobes.length];
    ctx.strokeStyle = rgb(56 + r() * 22, 46 + r() * 18, 32 + r() * 12, 0.9);
    ctx.lineWidth = 1.1 + r() * 2.0;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + (r() - 0.5) * 24, cy + 108);
    ctx.quadraticCurveTo(cx + (lo.x - cx) * 0.4, cy + 40, lo.x, lo.y);
    ctx.stroke();
  }

  // Dense dark underlayer per lobe. Scattered leaves alone never reach opacity
  // and the cluster renders as a see-through scribble at any distance. At 0.52
  // it bottomed out near sRGB 22 on the pine tile and was the floor under every
  // near-black crown in the treeline; 0.78 keeps the mass dark without letting
  // any crown pixel fall below ~sRGB 45 on the shadow side.
  if (!needle) {
    for (const lo of lobes) {
      ctx.fillStyle = rgb(cols[0][0] * 0.78, cols[0][1] * 0.78, cols[0][2] * 0.78, 0.86);
      ctx.beginPath();
      ctx.ellipse(lo.x, lo.y, lo.r * 0.74, lo.r * 0.58, (r() - 0.5) * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (let i = 0; i < count; i++) {
    const lo = lobes[Math.floor(r() * lobes.length) % lobes.length];
    const a = r() * Math.PI * 2;
    // pow < 1 pushes samples outward so the rim stays ragged, not a clean disc.
    const rad = Math.pow(r(), 0.55) * lo.r * 1.12;
    const px = lo.x + Math.cos(a) * rad * 1.1;
    const py = lo.y + Math.sin(a) * rad * 0.85;
    if (px < ox + 3 || px > ox + LEAF_TILE - 3 || py < 3 || py > LEAF_TILE - 3) continue;
    // Light rises up and outward; the interior stays dense and dark so the
    // crown shades as a volume rather than a flat cutout.
    const up = Math.min(1, Math.max(0, (LEAF_TILE - py) / LEAF_TILE));
    const out = Math.min(1, rad / lo.r);
    // Floor 0.62, not 0.46. The old range bottomed the pine tile out near
    // sRGB 22 while birch ran to 138 — a value break of the sort no sunlit
    // woodland shows, and the reason a third of the crowns rendered black.
    const lit = 0.62 + up * 0.32 + out * 0.16;
    const col = cols[Math.floor(r() * cols.length) % cols.length];
    const k = r();
    ctx.fillStyle = rgb(
      (col[0] + k * 24) * lit, (col[1] + k * 24) * lit, (col[2] + k * 14) * lit,
      0.78 + r() * 0.22
    );
    if (needle) {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1.2 + r() * 1.1;
      const ang = Math.atan2(py - cy, px - cx) + (r() - 0.5) * 0.9;
      for (let n = 0; n < 3; n++) {
        const na = ang + (n - 1) * 0.5;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(na) * leafH * (0.6 + r() * 0.7), py + Math.sin(na) * leafH * (0.6 + r() * 0.7));
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.ellipse(px, py, leafW * (0.7 + r() * 0.7), leafH * (0.7 + r() * 0.7), r() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function makeLeafAtlas(seed: number): THREE.Texture {
  const W = LEAF_TILE * LEAF_TILES;
  const { c, ctx } = newCanvas(W, LEAF_TILE);
  // Every palette below carries a real BLUE floor. Cycle 2's leaves ran blue at
  // ~40% of red, so once the crown fell into shade there was nothing left in the
  // channel for the sky to light and the mass crushed to black.
  // Oak: broad dark-green paddles.
  leafSpray(ctx, LEAF_OAK * LEAF_TILE, seed + 11,
    [[66, 86, 50], [80, 98, 58], [58, 76, 46], [102, 106, 66]], 5.6, 4.0, 620, false);
  // Birch: small bright leaves, more yellow.
  leafSpray(ctx, LEAF_BIRCH * LEAF_TILE, seed + 23,
    [[98, 112, 64], [116, 126, 74], [84, 100, 58], [136, 138, 88]], 4.0, 3.2, 760, false);
  // Scots pine: blue-green needle tufts. Value-matched to the other species —
  // the old [[48,72,56],[58,84,64],[40,60,50]] sat a full stop under birch's
  // [136,138,88] and produced the black-silhouette half of the treeline.
  leafSpray(ctx, LEAF_PINE * LEAF_TILE, seed + 37,
    [[72, 94, 74], [86, 108, 84], [62, 82, 66]], 2.6, 9.0, 620, true);
  // Dry bramble / autumn scrub.
  leafSpray(ctx, LEAF_BRAMBLE * LEAF_TILE, seed + 53,
    [[118, 104, 70], [98, 94, 60], [134, 116, 80], [84, 84, 56]], 4.6, 3.4, 560, false);
  // Shrub broadleaf: the waist-high stratum. Distinctly cooler and greener than
  // the ochre sward it stands in, which is how a shrub layer reads as a
  // different plant rather than as taller grass.
  leafSpray(ctx, LEAF_SHRUB * LEAF_TILE, seed + 67,
    [[62, 84, 52], [74, 96, 60], [52, 74, 46], [88, 102, 62]], 6.4, 4.6, 700, false);
  bleedAlpha(ctx, W, LEAF_TILE, 3);
  return cutoutTexture(c, 8);
}

// ---------------------------------------------------------------------------
// Ground-cover carpet (tiling, top-down)
// ---------------------------------------------------------------------------

/**
 * Tiling top-down grass canopy. This is the layer that stops the world reading
 * as tufts scattered on bare soil: it paints the ground itself as vegetated out
 * to the horizon so the instanced rings have nothing to reveal when they end.
 * Alpha carries coverage; RGB carries canopy colour with dark inter-blade gaps,
 * which double as the clumps' contact shadow.
 */
export function makeCanopyTexture(seed: number): THREE.CanvasTexture {
  const S = 512;
  const { c, ctx } = newCanvas(S, S);
  const r = stream(seed);

  // Base mat with soil showing through: alpha under 1 everywhere so the terrain
  // colour keeps coming through and the carpet never becomes a flat sheet.
  ctx.fillStyle = rgb(54, 55, 44, 0.34);
  ctx.fillRect(0, 0, S, S);

  const draw = (fn: (dx: number, dy: number) => void) => {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) fn(ox * S, oy * S);
  };

  // Dark gaps between tufts, drawn first. Deeper and denser than cycle 2: the
  // reference field puts ~14% of its pixels below luminance 25 and the build
  // managed 4.6%, and the missing stratum is exactly this — the shaded floor
  // under a sward, seen through the gaps.
  for (let i = 0; i < 340; i++) {
    const x = r() * S, y = r() * S, rad = 8 + r() * 28;
    const k = r();
    draw((dx, dy) => {
      ctx.fillStyle = rgb(22 + k * 12, 24 + k * 12, 19 + k * 9, 0.58);
      ctx.beginPath();
      ctx.ellipse(x + dx, y + dy, rad, rad * (0.6 + r() * 0.5), r() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Blade strokes: short directional ticks in clustered rosettes. Read from
  // above this is what a mown-to-shin meadow actually looks like.
  for (let cl = 0; cl < 340; cl++) {
    const cxp = r() * S, cyp = r() * S;
    const dry = r() < 0.30;
    const n = 7 + Math.floor(r() * 9);
    const spread = 5 + r() * 13;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const len = 5 + r() * 15;
      const k = r();
      const col: [number, number, number] = dry
        ? [126 + k * 36, 108 + k * 28, 90 + k * 22]
        : [84 + k * 40, 92 + k * 36, 72 + k * 26];
      const x0 = cxp + Math.cos(a) * spread * r();
      const y0 = cyp + Math.sin(a) * spread * r();
      draw((dx, dy) => {
        ctx.strokeStyle = rgb(col[0], col[1], col[2], 0.62 + r() * 0.3);
        ctx.lineWidth = 1.2 + r() * 1.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x0 + dx, y0 + dy);
        ctx.lineTo(x0 + dx + Math.cos(a) * len, y0 + dy + Math.sin(a) * len);
        ctx.stroke();
      });
    }
  }

  // Collapsed dead grass, leaf litter and twigs. This is the thatch stratum:
  // flattened straw lying UNDER the standing sward, half of it in its own
  // shadow, which is what stops the ground plate reading as a clean painted
  // mottle between the blades.
  for (let i = 0; i < 380; i++) {
    const x = r() * S, y = r() * S;
    const k = r();
    const a = r() * Math.PI;
    const shade = r() < 0.42;
    draw((dx, dy) => {
      ctx.fillStyle = shade
        ? rgb(48 + k * 22, 44 + k * 18, 34 + k * 14, 0.55)
        : rgb(112 + k * 34, 96 + k * 26, 68 + k * 20, 0.5);
      ctx.beginPath();
      ctx.ellipse(x + dx, y + dy, 2.5 + r() * 7, 0.9 + r() * 1.8, a, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}
