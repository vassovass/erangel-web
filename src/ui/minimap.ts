import { MAP_SIZE, type Heightfield } from '../gen/terraingen';
import type { ZoneController } from '../match/zonecontroller';
import type { PlayerController } from '../player/controller';
import { COLOR, DOCK_H, FONT, MAP_CSS, MAP_DPR, MAP_VIEW_M } from './theme';
import { STR, settlementNames } from './strings';
import { worldInfo } from './worldinfo';
import { PAL } from './palette';

// Cartographic map baked once on the CPU from the heightfield (splat colours,
// parcel tints, hillshade, roads, sea), shown as a framed corner minimap in the
// bottom-RIGHT corner and an M-toggled tactical map with live zone circles.
//
// Four rules govern the panel, and three of them are corrections:
//
//  1. VALUE HIERARCHY IS ROADS > BUILDINGS > TERRAIN. The cycle-2 bake measured
//     roads L=73, terrain L=97-105, buildings L=128 - exactly backwards. Roads
//     are the lightest feature on any real BR map because they are the primary
//     orientation aid when you are running a compass bearing, and a 1.35:1
//     road-vs-terrain delta at 208px panel width does not resolve at all. So
//     terrain is multiplied down into the L 55-80 band and roads are composited
//     LAST, light, over the top, with a dark casing.
//  2. THE PANEL MUST ANSWER "WHICH SIDE IS SAFE". Rings alone never did: with
//     a countdown running and a dashed arc clipped into one corner there is no
//     way to read which side you want. The region outside the play zone is now
//     tinted blue and the region outside the next circle is knocked back, so
//     safe and unsafe are readable without tracing a line.
//  3. EVERY map-content pass runs inside one save/clip/restore against the
//     panel rect, and every stroke begins with an explicit beginPath(). Nothing
//     can escape the panel and no leftover subpath can be re-stroked.
//  4. Chrome (north glyph, scale bar) is DOM, not canvas, and now sits on the
//     panel RIM rather than floating over map content.
//
// When a ring is wholly outside the panel - the common case in phase 1, where
// the radius is 690m and the panel shows 340m - a chevron clamped to the border
// carries the bearing, so the map always answers "which way do I run". That
// chevron is deliberately zone-blue and is NOT a second north marker; the north
// glyph now lives in the panel's top-left corner so the two cannot be confused.

// 640 keeps the corner crop legible (340m across ~181 source px) while the
// height grid below removes 4 of the ~10 height queries the old bake spent
// per pixel, so the whole bake stays cheaper than a naive 440 pass was.
const BAKE_RES = 640;
const GRID_M = 100;
const CONTOUR_M = 20;
const FULL_RES = 880;

/** The zone accent. Circle geometry only, never type. See palette.ts. */
const ZONE_BLUE = PAL.zone;
/** Danger wash applied OUTSIDE the play-zone boundary, on BOTH maps. */
const OUTSIDE_PLAY = PAL.zoneWash;
/** Knock-back applied OUTSIDE the next circle. */
const OUTSIDE_NEXT = 'rgba(0,0,0,0.18)';
const NEXT_WHITE = '#ffffff';

/** Two building weights, so a barn does not render as the same pill as a shed. */
const BLD_BIG = 'rgba(208,212,215,0.95)';
const BLD_SMALL = 'rgba(150,156,160,0.90)';
const BLD_LINE = 'rgba(20,23,26,0.75)';
/** Footprint area (m^2) above which a structure counts as a landmark. */
const BLD_BIG_AREA = 90;

/** Settlement clustering: single-link at this radius, min members to name it. */
const CLUSTER_M = 72;
const CLUSTER_MIN = 3;
const CLUSTER_MAX = 12;

/** Terrain multiplier that clears the value band for roads and buildings. */
const TERRAIN_VALUE = 0.72;
/** Road core / casing, composited after everything else. */
const ROAD_CORE: readonly [number, number, number] = [201, 191, 166];
const ROAD_CASE: readonly [number, number, number] = [110, 101, 82];

/** Hermite ramp, so road edges do not alias into a stair. */
function smooth01(t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return k * k * (3 - 2 * k);
}

/** World -> canvas transform for one draw pass. */
interface View {
  /** pixels per metre */
  s: number;
  /** canvas x of world x=0 */
  ox: number;
  /** canvas y of world z=0 */
  oy: number;
}

export class Minimap {
  private world: HTMLCanvasElement;
  private corner: HTMLCanvasElement;
  private wrap: HTMLElement;
  private full: HTMLCanvasElement;
  private fullWrap: HTMLElement;
  private fullVisible = false;
  /** Named settlement clusters, computed lazily on the first tactical-map draw. */
  private places: Array<{ x: number; z: number; name: string }> | null = null;

  constructor(private hf: Heightfield) {
    this.world = document.createElement('canvas');
    this.world.width = this.world.height = BAKE_RES;
    this.bake();

    const hud = document.getElementById('hud')!;

    // ---- corner map: canvas + DOM chrome ----
    // Bottom RIGHT, with the weapon readout immediately to its left: the
    // cycle-2 build mirrored the genre and anyone who has played a BR reads
    // that as the wrong game inside the first second.
    // The wrap encloses the map AND the zone dock beneath it, so ONE frame
    // closes on all four sides. Cycle 3 ran a 1px hairline on top/left/right
    // that stopped dead at the PHASE strip, so the instrument never closed and
    // the dock read as a separate object that happened to be adjacent.
    this.wrap = document.createElement('div');
    this.wrap.id = 'minimapwrap';
    this.wrap.style.cssText =
      'position:absolute;right:var(--hud-safe);bottom:var(--hud-safe);' +
      `width:${MAP_CSS}px;height:${MAP_CSS + DOCK_H}px;font-family:${FONT};` +
      'box-shadow:0 0 0 1px rgba(255,255,255,0.18),0 0 0 2px rgba(0,0,0,0.65),' +
      '0 6px 18px rgba(0,0,0,0.45);';

    this.corner = document.createElement('canvas');
    this.corner.id = 'minimap';
    this.corner.width = this.corner.height = Math.round(MAP_CSS * MAP_DPR);
    this.corner.style.cssText = `display:block;width:${MAP_CSS}px;height:${MAP_CSS}px;`;
    this.wrap.appendChild(this.corner);

    // North: a 12px triangle pinned to the OUTER top edge of the frame, in
    // white. Cycle 3 put a cyan triangle inside the map body near the top,
    // which read as a second player marker sitting on the terrain - and it
    // borrowed the zone accent, which belongs to circle geometry alone.
    const north = document.createElement('div');
    north.style.cssText =
      'position:absolute;left:50%;top:-11px;margin-left:-6px;width:0;height:0;' +
      'border-left:6px solid transparent;border-right:6px solid transparent;' +
      'border-bottom:10px solid rgba(255,255,255,0.92);' +
      'filter:drop-shadow(0 0 1.5px rgba(0,0,0,0.95));';
    // Scale bar in the bottom-RIGHT of the map body, on its own plate: at
    // bottom-left it collided with the next-circle dash every time the circle
    // clipped that corner, and the "100 M" label sat straight on top of it.
    const scaleLen = Math.round((GRID_M / MAP_VIEW_M) * MAP_CSS);
    const scale = document.createElement('div');
    scale.style.cssText =
      `position:absolute;right:6px;top:${MAP_CSS - 22}px;font-size:9px;letter-spacing:0.08em;` +
      'line-height:1;color:rgba(255,255,255,0.9);background:rgba(0,0,0,0.45);' +
      'border-radius:2px;padding:3px 5px;display:flex;align-items:center;gap:5px;';
    scale.innerHTML =
      `<i style="display:block;width:${scaleLen}px;height:5px;box-sizing:border-box;` +
      'border:1px solid rgba(255,255,255,0.85);border-top:none"></i>100 M';
    this.wrap.appendChild(north);
    this.wrap.appendChild(scale);
    hud.appendChild(this.wrap);

    // ---- tactical (full) map ----
    this.fullWrap = document.createElement('div');
    this.fullWrap.id = 'fullmap';
    this.fullWrap.style.cssText =
      'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
      `font-family:${FONT};color:${COLOR.ink};`;
    const backdrop = document.createElement('div');
    backdrop.style.cssText =
      'position:absolute;inset:0;background:radial-gradient(ellipse at center,' +
      'rgba(5,8,11,0.62),rgba(3,5,7,0.88));';
    const frame = document.createElement('div');
    frame.style.cssText =
      'position:relative;display:flex;flex-direction:column;gap:6px;';
    const head = document.createElement('div');
    head.style.cssText =
      'display:flex;align-items:baseline;justify-content:space-between;' +
      `padding:0 2px 5px;border-bottom:1px solid ${COLOR.lineSoft};`;
    // Header name comes from the string table, which derives it from the world
    // seed. Nothing in this file may hard-code a map name.
    head.innerHTML =
      `<span style="font-size:16px;letter-spacing:0.24em;font-weight:700">${STR.mapHeader}</span>` +
      `<span style="font-size:11px;letter-spacing:0.12em;color:${COLOR.dim}">${STR.mapScale}</span>`;
    const foot = document.createElement('div');
    foot.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;' +
      `padding:5px 2px 0;border-top:1px solid ${COLOR.lineSoft};font-size:11px;letter-spacing:0.12em;color:${COLOR.dim};`;
    foot.innerHTML =
      `<span><i style="display:inline-block;width:14px;height:0;border-top:2px solid ${ZONE_BLUE};` +
      `vertical-align:middle;margin-right:6px"></i>${STR.mapPlayZone}` +
      '<i style="display:inline-block;width:14px;height:0;border-top:2px dashed rgba(255,255,255,0.9);' +
      `vertical-align:middle;margin:0 6px 0 18px"></i>${STR.mapNextCircle}` +
      `<span style="margin-left:18px;color:${COLOR.dim}">${STR.mapGrid}</span></span>` +
      `<span>${STR.mapClose.replace('<b>', `<b style="color:${PAL.action}">`)}</span>`;

    this.full = document.createElement('canvas');
    this.full.width = this.full.height = FULL_RES;
    this.full.style.cssText =
      'display:block;width:74vmin;height:74vmin;box-sizing:border-box;' +
      `border:1px solid ${COLOR.line};box-shadow:0 8px 46px rgba(0,0,0,0.75);`;

    frame.appendChild(head);
    frame.appendChild(this.full);
    frame.appendChild(foot);
    this.fullWrap.appendChild(backdrop);
    this.fullWrap.appendChild(frame);
    hud.appendChild(this.fullWrap);
  }

  toggleFull(): void {
    this.fullVisible = !this.fullVisible;
    this.fullWrap.style.display = this.fullVisible ? 'flex' : 'none';
    // The tactical map owns the frame: the persistent HUD (this minimap
    // included) hides rather than sitting muted under the backdrop scrim.
    document.getElementById('hud')?.classList.toggle('mapopen', this.fullVisible);
  }

  private bake(): void {
    const ctx = this.world.getContext('2d')!;
    const img = ctx.createImageData(BAKE_RES, BAKE_RES);
    const d = img.data;
    const sunX = -0.6, sunZ = -0.5;
    const step = MAP_SIZE / BAKE_RES;
    // One height query per cell, reused for both the sea test and the
    // hillshade normal (a hf.normal() call would cost four more).
    const PAD = 2;
    const G = BAKE_RES + PAD * 2;
    const grid = new Float32Array(G * G);
    for (let j = 0; j < G; j++) {
      const z = ((j - PAD + 0.5) / BAKE_RES - 0.5) * MAP_SIZE;
      for (let i = 0; i < G; i++) {
        grid[j * G + i] = this.hf.height(((i - PAD + 0.5) / BAKE_RES - 0.5) * MAP_SIZE, z);
      }
    }
    // Parcel tone per pixel, so a second (hf-free) pass can ink the field
    // boundaries - the thing that makes the real Erangel map read as a map.
    const tones = new Float32Array(BAKE_RES * BAKE_RES);
    const land = new Uint8Array(BAKE_RES * BAKE_RES);
    // Road pixels are excluded from the parcel-edge inking below. The tone map
    // used to fold w.road in, which guaranteed a tone discontinuity along every
    // road and therefore inked every road edge at 0.74 - fine when roads were
    // the darkest feature, fatal now they are the lightest (it was knocking the
    // measured core from 191 down to 141, half the delta the inversion buys).
    const roadPx = new Uint8Array(BAKE_RES * BAKE_RES);
    let p = 0;
    for (let j = 0; j < BAKE_RES; j++) {
      for (let i = 0; i < BAKE_RES; i++) {
        const x = ((i + 0.5) / BAKE_RES - 0.5) * MAP_SIZE;
        const z = ((j + 0.5) / BAKE_RES - 0.5) * MAP_SIZE;
        const gi = (j + PAD) * G + (i + PAD);
        const h = grid[gi];
        let r: number, g: number, b: number;
        if (h < 0.4) {
          const deep = Math.min(1, (0.4 - h) / 14);
          r = 42 - deep * 16; g = 84 - deep * 28; b = 100 - deep * 26;
        } else {
          const s = this.hf.surface(x, z);
          const w = s.splat;
          // Base: parcel-tinted grass.
          const tone = s.field.tone;
          tones[j * BAKE_RES + i] = tone + 8 * w.rock;
          land[j * BAKE_RES + i] = 1;
          if (w.road > 0.28) roadPx[j * BAKE_RES + i] = 1;
          r = 118 + tone * 42; g = 128 + tone * 26; b = 66 + tone * 14;
          // Dirt / rock overlays. The ROAD is deliberately NOT composited here:
          // it goes on last, after the terrain has been valued down, so it can
          // be the lightest thing on the sheet.
          r = r * (1 - w.dirt) + 141 * w.dirt;
          g = g * (1 - w.dirt) + 116 * w.dirt;
          b = b * (1 - w.dirt) + 84 * w.dirt;
          r = r * (1 - w.rock) + 132 * w.rock;
          g = g * (1 - w.rock) + 126 * w.rock;
          b = b * (1 - w.rock) + 118 * w.rock;
          // Beach.
          const beach = Math.max(0, 1 - Math.abs(h - 1.4) / 1.4);
          r = r * (1 - beach) + 190 * beach;
          g = g * (1 - beach) + 174 * beach;
          b = b * (1 - beach) + 136 * beach;
          // Hillshade from the cached grid (central differences at ~4m, the
          // eps the old hf.normal() call used).
          const dx = (grid[gi + 2] - grid[gi - 2]) / (4 * step);
          const dz = (grid[gi + G * 2] - grid[gi - G * 2]) / (4 * step);
          const inv = 1 / Math.hypot(dx, 1, dz);
          const nx = -dx * inv, ny = inv, nz = -dz * inv;
          const shade = 0.72 + Math.max(0, nx * sunX + nz * sunZ) * 0.75 + (ny - 0.9) * 1.4;
          r *= shade; g *= shade; b *= shade;
          // Altitude tint.
          const alt = Math.min(1, h / 90);
          r += alt * 26; g += alt * 20; b += alt * 18;
          // Contour lines every 20m, read straight off the cached grid - but
          // only where the ground is gentle enough for them to stay separate
          // lines. On a cliff the 20m bands land in adjacent pixels and every
          // pixel qualifies, which is why the highland used to bake as a black
          // scribble instead of reading as relief.
          const slope = Math.hypot(dx, dz);
          const band = Math.floor(h / CONTOUR_M);
          if (
            slope < 0.75 &&
            (band !== Math.floor(grid[gi + 1] / CONTOUR_M) || band !== Math.floor(grid[gi + G] / CONTOUR_M))
          ) {
            r *= 0.8; g *= 0.8; b *= 0.82;
          }
          // Gentle contrast so the map reads as cartography, not camouflage.
          r = 128 + (r - 128) * 1.14;
          g = 128 + (g - 128) * 1.14;
          b = 128 + (b - 128) * 1.14;
          // Value floor: push terrain into the L 55-80 band so the two features
          // that matter for navigation have somewhere brighter to live.
          r *= TERRAIN_VALUE; g *= TERRAIN_VALUE; b *= TERRAIN_VALUE;
          // ROADS LAST, and LIGHT. A dark casing ramp comes in first over the
          // shoulders of the splat's tent profile, then the light core over the
          // crown, so the network reads as a cased line rather than a smear.
          if (w.road > 0.28) {
            const kc = smooth01((w.road - 0.28) / 0.3);
            r += (ROAD_CASE[0] - r) * kc;
            g += (ROAD_CASE[1] - g) * kc;
            b += (ROAD_CASE[2] - b) * kc;
            if (w.road > 0.5) {
              const kk = smooth01((w.road - 0.5) / 0.26);
              r += (ROAD_CORE[0] - r) * kk;
              g += (ROAD_CORE[1] - g) * kk;
              b += (ROAD_CORE[2] - b) * kk;
            }
          }
        }
        d[p] = Math.max(0, Math.min(255, r));
        d[p + 1] = Math.max(0, Math.min(255, g));
        d[p + 2] = Math.max(0, Math.min(255, b));
        d[p + 3] = 255;
        p += 4;
      }
    }

    // Pass 2 (no heightfield queries): ink parcel/road boundaries and lay a
    // faint deterministic paper grain over the whole sheet.
    for (let j = 0; j < BAKE_RES; j++) {
      for (let i = 0; i < BAKE_RES; i++) {
        const k = j * BAKE_RES + i;
        if (!land[k]) continue;
        const t = tones[k];
        const tr = i + 1 < BAKE_RES && land[k + 1] ? tones[k + 1] : t;
        const td = j + 1 < BAKE_RES && land[k + BAKE_RES] ? tones[k + BAKE_RES] : t;
        // Roads carry their own casing and must keep their full value. 0.84,
        // not 0.74: the terrain underneath is already valued down, so the old
        // multiplier stacked to 0.53 and the field boundaries read as stained
        // glass instead of as hedgerows.
        const edge =
          !roadPx[k] && (Math.abs(t - tr) > 0.055 || Math.abs(t - td) > 0.055) ? 0.84 : 1;
        // Hash grain: stable for a given seed because it only reads i/j.
        const n = ((i * 73856093) ^ (j * 19349663)) >>> 0;
        const grain = 0.97 + ((n % 64) / 64) * 0.06;
        const q = k * 4;
        d[q] = Math.min(255, d[q] * edge * grain);
        d[q + 1] = Math.min(255, d[q + 1] * edge * grain);
        d[q + 2] = Math.min(255, d[q + 2] * edge * grain);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---- shared vocabulary -------------------------------------------------

  private grid(ctx: CanvasRenderingContext2D, v: View, size: number, alpha: number): void {
    const minX = (0 - v.ox) / v.s;
    const maxX = (size - v.ox) / v.s;
    const minZ = (0 - v.oy) / v.s;
    const maxZ = (size - v.oy) / v.s;
    ctx.strokeStyle = `rgba(232,240,245,${alpha})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    for (let x = Math.ceil(minX / GRID_M) * GRID_M; x <= maxX; x += GRID_M) {
      const px = Math.round(v.ox + x * v.s) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, size);
    }
    for (let z = Math.ceil(minZ / GRID_M) * GRID_M; z <= maxZ; z += GRID_M) {
      const py = Math.round(v.oy + z * v.s) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(size, py);
    }
    ctx.stroke();
  }

  /**
   * Building blocks, straight off the same collider list the world renderer
   * feeds. A BR minimap exists to tell you where cover is; a village that
   * renders as blank field is the map failing at its one job.
   */
  private buildings(ctx: CanvasRenderingContext2D, v: View, size: number, lw: number): void {
    const fps = worldInfo.footprints;
    if (fps.length === 0) return;
    ctx.strokeStyle = BLD_LINE;
    ctx.lineWidth = lw;
    for (const f of fps) {
      const x = v.ox + f.x0 * v.s;
      const y = v.oy + f.z0 * v.s;
      // 1.5*lw floor, not 3*lw: at 3 every shed inflated to the same 12x7 pill
      // as a barn, so the map lost the one cue that tells you which building is
      // worth running to.
      const w = Math.max(1.5 * lw, (f.x1 - f.x0) * v.s);
      const h = Math.max(1.5 * lw, (f.z1 - f.z0) * v.s);
      if (x + w < 0 || y + h < 0 || x > size || y > size) continue;
      const area = (f.x1 - f.x0) * (f.z1 - f.z0);
      ctx.fillStyle = area >= BLD_BIG_AREA ? BLD_BIG : BLD_SMALL;
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.stroke();
    }
  }

  /**
   * Deterministic settlement clusters, computed once from the footprint list.
   *
   * A BR map with no place names cannot support a callout, which is the
   * primary job the map exists to do - and map.png carried no location label
   * anywhere on the landmass. Single-link clustering at 72m groups a village's
   * buildings without merging two villages a field apart.
   */
  private settlements(): Array<{ x: number; z: number; name: string }> {
    if (this.places) return this.places;
    const fps = worldInfo.footprints;
    const n = fps.length;
    const cx = new Float32Array(n);
    const cz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      cx[i] = (fps[i].x0 + fps[i].x1) / 2;
      cz[i] = (fps[i].z0 + fps[i].z1) / 2;
    }
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (a: number): number => {
      while (parent[a] !== a) {
        parent[a] = parent[parent[a]];
        a = parent[a];
      }
      return a;
    };
    const r2 = CLUSTER_M * CLUSTER_M;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = cx[i] - cx[j];
        const dz = cz[i] - cz[j];
        if (dx * dx + dz * dz > r2) continue;
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
    const groups = new Map<number, { x: number; z: number; n: number }>();
    for (let i = 0; i < n; i++) {
      const k = find(i);
      const g = groups.get(k) ?? { x: 0, z: 0, n: 0 };
      g.x += cx[i];
      g.z += cz[i];
      g.n++;
      groups.set(k, g);
    }
    const kept = [...groups.values()]
      .filter((g) => g.n >= CLUSTER_MIN)
      .map((g) => ({ x: g.x / g.n, z: g.z / g.n, n: g.n }))
      // Stable order regardless of map iteration: names must not shuffle
      // between runs for one seed.
      .sort((a, b) => (b.n - a.n) || (a.x - b.x) || (a.z - b.z))
      .slice(0, CLUSTER_MAX);
    const names = settlementNames(kept.length);
    this.places = kept.map((g, i) => ({ x: g.x, z: g.z, name: names[i] }));
    return this.places;
  }

  /** Uppercase caps with the same black contour every other white mark uses. */
  private inkText(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
    px: number, alpha: number, track = 0
  ): void {
    ctx.font = `600 ${px}px ${FONT}`;
    const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    if (track && 'letterSpacing' in spaced) spaced.letterSpacing = `${track}px`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, px * 0.26);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.fillText(text, x, y);
    if (track && 'letterSpacing' in spaced) spaced.letterSpacing = '0px';
  }

  private placeLabels(ctx: CanvasRenderingContext2D, v: View): void {
    const places = this.settlements();
    if (places.length === 0) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of places) {
      this.inkText(ctx, p.name, v.ox + p.x * v.s, v.oy + p.z * v.s - 15, 11, 0.94, 1.1);
    }
    ctx.restore();
  }

  /** True when a world circle has any part inside the [0,size] panel square. */
  private circleVisible(cx: number, cy: number, r: number, size: number): boolean {
    const nx = Math.max(0, Math.min(size, cx));
    const ny = Math.max(0, Math.min(size, cy));
    const dMin = Math.hypot(cx - nx, cy - ny);
    let dMax = 0;
    for (const [px, py] of [[0, 0], [size, 0], [0, size], [size, size]]) {
      dMax = Math.max(dMax, Math.hypot(cx - px, cy - py));
    }
    return r >= dMin && r <= dMax;
  }

  /**
   * Region shading: the thing that turns two rings into an answer.
   *
   * Filled as "panel rect MINUS circle" with reversed winding, so when the
   * circle is wholly off-panel the whole visible area washes (correct: you are
   * entirely outside), and when the panel sits wholly inside the circle nothing
   * fills (also correct). No branch needed for the two cases that used to leave
   * the player with a dashed arc in one corner and no idea which side it was.
   */
  private shadeOutside(
    ctx: CanvasRenderingContext2D, size: number, cx: number, cy: number, r: number, fill: string
  ): void {
    if (r <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  }

  /** Triangle clamped to the panel border, pointing at an off-panel target. */
  private edgeChevron(
    ctx: CanvasRenderingContext2D, size: number, tx: number, ty: number, color: string, scale: number
  ): void {
    const cx = size / 2;
    const cy = size / 2;
    const a = Math.atan2(ty - cy, tx - cx);
    // Flush to the border and flat: cycle 3 drew it as an outlined solid blob
    // 10px inside the rim, which is the same visual grammar as the player
    // arrowhead and read as a second marker rather than as a bearing.
    const rad = size / 2 - 7 * scale;
    const px = cx + Math.cos(a) * rad;
    const py = cy + Math.sin(a) * rad;
    const s = 5 * scale;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(s * 0.6, 0);
    ctx.lineTo(-s * 0.9, s * 0.62);
    ctx.lineTo(-s * 0.9, -s * 0.62);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  /**
   * Zone layer: two shaded regions, then two rings, then chevrons for whatever
   * is off-panel. The shading goes down FIRST so the rings sit on top of their
   * own washes and stay the crispest edges in the panel.
   */
  private zoneGeometry(
    ctx: CanvasRenderingContext2D, zone: ZoneController, v: View, size: number, w: number, scale: number
  ): void {
    const nx = v.ox + zone.targetCenter.x * v.s;
    const ny = v.oy + zone.targetCenter.z * v.s;
    const nr = zone.targetRadius * v.s;
    const cx = v.ox + zone.center.x * v.s;
    const cy = v.oy + zone.center.z * v.s;
    const cr = zone.radius * v.s;
    const hasNext = !zone.finished && zone.targetRadius > 0;

    // Regions: everything outside the next circle knocked back, everything
    // outside the play zone washed blue. Blue over black reads as "leave".
    if (hasNext) this.shadeOutside(ctx, size, nx, ny, nr, OUTSIDE_NEXT);
    this.shadeOutside(ctx, size, cx, cy, cr, OUTSIDE_PLAY);

    // Next circle: white dashed, 1.5px on a 4/4 pattern. Cycle 3 ran it at 3px
    // on a 6/5 pattern, which is heavier than the play-zone boundary itself -
    // exactly backwards, since the boundary is the one that kills you now.
    if (hasNext) {
      if (this.circleVisible(nx, ny, nr, size)) {
        ctx.setLineDash([4 * scale, 4 * scale]);
        ctx.strokeStyle = NEXT_WHITE;
        ctx.lineWidth = 1.5 * scale;
        ctx.beginPath();
        ctx.arc(nx, ny, nr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        this.edgeChevron(ctx, size, nx, ny, 'rgba(255,255,255,0.9)', scale);
      }
    }
    // Play-zone boundary: solid zone accent over a dark casing.
    if (this.circleVisible(cx, cy, cr, size)) {
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = w + 2 * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = ZONE_BLUE;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      this.edgeChevron(ctx, size, cx, cy, ZONE_BLUE, scale);
    }
  }

  private playerMark(
    ctx: CanvasRenderingContext2D, v: View, player: PlayerController, r: number, cone: number
  ): void {
    const px = v.ox + player.position.x * v.s;
    const py = v.oy + player.position.z * v.s;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-player.yaw);
    ctx.setLineDash([]);
    // 60-degree FOV cone at 40% of the panel radius. Facing is the second
    // thing the panel has to answer and cycle 3's cone was 19% of the panel at
    // 0.30 falling to nothing - under pressure it read as a smudge.
    if (cone > 0) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, cone);
      g.addColorStop(0, 'rgba(255,255,255,0.22)');
      g.addColorStop(0.62, 'rgba(255,255,255,0.16)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, cone, -Math.PI / 2 - Math.PI / 6, -Math.PI / 2 + Math.PI / 6);
      ctx.closePath();
      ctx.fill();
    }
    // Arrowhead. Pure white inside a black outline: with buildings dropped to
    // mid grey and terrain valued down, this is now the highest-contrast object
    // in the panel, which is the only correct answer for "where am I".
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.68, r * 0.86);
    ctx.lineTo(0, r * 0.42);
    ctx.lineTo(-r * 0.68, r * 0.86);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineJoin = 'miter';
    ctx.lineWidth = Math.max(2, r * 0.3);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  /**
   * North indicator, in white and clear of the graticule.
   *
   * Cycle 3 drew it at the very top of the canvas, where it landed on the
   * column-letter row and read as part of the graticule. `top` puts it below
   * that row on open water, and the mark carries the same black contour every
   * other white element in this file uses instead of a blur shadow.
   */
  private northMark(ctx: CanvasRenderingContext2D, size: number, top: number): void {
    const x = size / 2;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x + 7, top + 12);
    ctx.lineTo(x - 7, top + 12);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.stroke();
    // White, not blue: blue is the zone accent and nothing else may borrow it.
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    this.inkText(ctx, 'N', x, top + 15, 13, 0.92);
    ctx.restore();
  }

  /** Bottom-RIGHT, clear of the row-number gutter it used to sit on top of. */
  private scaleBar(ctx: CanvasRenderingContext2D, size: number, pxPerM: number, scale: number): void {
    const len = GRID_M * pxPerM;
    const x = size - len - 14 * scale;
    const y = size - 11 * scale;
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + len, y);
    ctx.moveTo(x, y - 3 * scale); ctx.lineTo(x, y + 3 * scale);
    ctx.moveTo(x + len, y - 3 * scale); ctx.lineTo(x + len, y + 3 * scale);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1 * scale;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + len, y);
    ctx.moveTo(x, y - 3 * scale); ctx.lineTo(x, y + 3 * scale);
    ctx.moveTo(x + len, y - 3 * scale); ctx.lineTo(x + len, y + 3 * scale);
    ctx.stroke();
    ctx.font = `${8 * scale}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 3 * scale;
    ctx.fillText(`${GRID_M} m`, x, y - 4 * scale);
    ctx.restore();
  }

  private vignette(ctx: CanvasRenderingContext2D, size: number): void {
    const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.32, size / 2, size / 2, size * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    // Lighter than before: the terrain is already valued down, and stacking a
    // 0.30 vignette on top of that is how a map ends up in a 60-point band.
    g.addColorStop(1, 'rgba(0,0,0,0.20)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  // ---- per-frame ---------------------------------------------------------

  update(player: PlayerController, zone: ZoneController): void {
    const c = this.corner.getContext('2d')!;
    const size = this.corner.width;
    const scale = size / MAP_CSS; // device px per CSS px
    const s = size / MAP_VIEW_M; // device px per metre
    const v: View = {
      s,
      ox: size / 2 - player.position.x * s,
      oy: size / 2 - player.position.z * s,
    };
    const srcSize = (MAP_VIEW_M / MAP_SIZE) * BAKE_RES;
    const wx = (player.position.x / MAP_SIZE + 0.5) * BAKE_RES;
    const wz = (player.position.z / MAP_SIZE + 0.5) * BAKE_RES;

    // ONE clipped pass for all map content. Nothing drawn here can reach the
    // panel chrome, and no subpath survives into the next frame.
    c.save();
    c.beginPath();
    c.rect(0, 0, size, size);
    c.clip();
    c.setLineDash([]);
    c.fillStyle = '#15242c';
    c.fillRect(0, 0, size, size);
    c.imageSmoothingQuality = 'high';
    c.drawImage(this.world, wx - srcSize / 2, wz - srcSize / 2, srcSize, srcSize, 0, 0, size, size);
    this.grid(c, v, size, 0.10);
    this.buildings(c, v, size, scale);
    this.zoneGeometry(c, zone, v, size, 2 * scale, scale);
    this.playerMark(c, v, player, 8 * scale, 0.4 * MAP_CSS * scale);
    this.vignette(c, size);
    c.restore();

    if (!this.fullVisible) return;

    const f = this.full.getContext('2d')!;
    const fs = FULL_RES / MAP_SIZE;
    const fv: View = { s: fs, ox: FULL_RES / 2, oy: FULL_RES / 2 };
    f.save();
    f.beginPath();
    f.rect(0, 0, FULL_RES, FULL_RES);
    f.clip();
    f.setLineDash([]);
    f.imageSmoothingQuality = 'high';
    f.drawImage(this.world, 0, 0, FULL_RES, FULL_RES);
    this.grid(f, fv, FULL_RES, 0.1);
    this.buildings(f, fv, FULL_RES, 1);
    this.zoneGeometry(f, zone, fv, FULL_RES, 2.4, 1.2);
    this.playerMark(f, fv, player, 11, 58);
    this.vignette(f, FULL_RES);
    // Type LAST, over the vignette and the zone wash, so a label never has to
    // fight a translucent region fill for its own contrast.
    this.gridLabels(f, fv);
    this.placeLabels(f, fv);
    f.restore();
    // Chrome last, so geometry can never overdraw the scale label.
    this.northMark(f, FULL_RES, 26);
    this.scaleBar(f, FULL_RES, fs, 2.0);
  }

  /**
   * Lettered graticule on the tactical map (A..L / 1..12 at 100m spacing).
   *
   * Cycle 3 drew both label runs from the cell's top-left corner, so the "A"
   * and the "1" landed on the same pixel and the row sequence appeared to start
   * at 2 - it was not an off-by-one in the loop, it was a collision. Labels are
   * now CENTRED in their cell on both axes, which is standard graticule
   * practice and removes the overlap by construction. 12px at 0.7 white with a
   * contour, up from 9px at 0.42 which did not resolve at 1x at all.
   */
  private gridLabels(ctx: CanvasRenderingContext2D, v: View): void {
    const cells = Math.round(MAP_SIZE / GRID_M);
    const cell = GRID_M * v.s;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let i = 0; i < cells; i++) {
      const x = v.ox + (-MAP_SIZE / 2 + i * GRID_M) * v.s + cell / 2;
      this.inkText(ctx, String.fromCharCode(65 + i), x, 11, 12, 0.7);
    }
    ctx.textAlign = 'left';
    for (let i = 0; i < cells; i++) {
      const y = v.oy + (-MAP_SIZE / 2 + i * GRID_M) * v.s + cell / 2;
      this.inkText(ctx, String(i + 1), 6, y, 12, 0.7);
    }
    ctx.restore();
  }
}
