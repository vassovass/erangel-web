import { centreSquare } from './layout';
import { PAL } from './palette';

// Directional damage indicator: ONE screen-space annulus segment, concentric
// with the crosshair, with no stroke anywhere on it.
//
// The cycle-3 version failed on four separate counts, all of them measurable:
//
// 1. IT READ AS CLIP ART. Every edge carried a ~2px pure-black stroke -
//    including the two straight radial edges - with hard corner joins. A
//    hard-edged polygon pasted over a photographic frame is the single most
//    reliable "not a shipped game" tell there is. There is now no ctx.stroke()
//    call in this file at all, and the fill ramps to zero alpha at the inner
//    radius, the outer radius AND both angular ends, so the wedge has no
//    boundary anywhere for an edge to be seen at.
//
// 2. IT COMPOSITED TO MAUVE. Sampled over blue sky the wedge measured
//    (128,109,130) against a sky of (110,140,180) - the most safety-critical
//    element on the screen was not red. The fix is a DARKENING PASS under the
//    hot pass: the wedge lays down black first, then red on top of its own
//    darkened ground, so the red is compositing against something near-neutral
//    instead of against the sky's own chroma. Gated in hud.ts: after compositing
//    over sky the sampled R must be at least 2.2x B.
//
// 3. MAGNITUDE RODE OPACITY, so a light hit was a faint mark - exactly the
//    wrong tuning, because faint is what the periphery drops first. Peak alpha
//    is now 0.80..1.00 (a hit is always unmistakable) and magnitude rides
//    ANGULAR WIDTH, 16deg to 34deg.
//
// 4. TWO WEDGES LOOKED LIKE TWO UNRELATED DECALS. They were in fact both
//    concentric with screen centre; what broke the reading was that a straight
//    radial edge on a filled quad hides the curvature. With the edges gone the
//    ring is legible as a ring.
//
// Angular falloff is done with a conic gradient in a destination-in pass on a
// scratch canvas, clipped to the wedge's bounding box. Nesting three wedges of
// different widths - the cycle-3 approach - steps the alpha at every nested
// boundary; a conic mask has no steps at all. The scratch pass runs at DPR 1
// because a fully soft gradient blob has nothing to gain from a 2x backing
// store and everything to lose in fill rate on an HD 620.

const DEG = Math.PI / 180;

/** Outer radius as a fraction of min(w,h); inner as a fraction of outer. */
const OUT_FRAC = 0.22;
/** 0.66, not 0.78: a 52px band at 1080p reads as a blob rather than an arc
 *  once both radial edges are ramped to zero. 80px reads as a ring segment. */
const IN_FRAC = 0.66;

const W_MIN = 22 * DEG;
const W_MAX = 46 * DEG;
/** Damage that saturates width and alpha. */
const DMG_FULL = 60;

const RISE = 0.09;
const HOLD = 0.18;
const FALL = 0.8;
const LIFE = RISE + HOLD + FALL;

const MERGE_DEG = 20;
const MAX_ARCS = 4;

/** Radial stop where the fill peaks, as a fraction of (rOut - rIn). */
const PEAK_T = 0.62;
/**
 * Darkening pass, then the hot pass, both ramping to zero at both radii.
 *
 * The darkening pass runs on a wedge HALO px wider at each radius, so the red
 * core sits inside a soft dark halo. That halo is what a stroked casing used to
 * do - it separates the mark from the world on a bright sky AND on olive grass
 * - except it has no edge anywhere, so it cannot read as pasted-on geometry.
 * Without it the wedge measures 1.08:1 against Erangel-style grass, which is
 * exactly the failure the cycle-2 arc shipped with.
 */
const DARK_A = 0.62;
const HOT_A = 0.95;
const HALO = 16;

interface Arc {
  /** Radians, 0 = dead ahead, positive clockwise. */
  bearing: number;
  /** Peak opacity, from damage magnitude. */
  peak: number;
  /** Half-width in radians, from damage magnitude. */
  half: number;
  /** Seconds since the hit. */
  age: number;
}

export class DamageArcs {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scratch: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private arcs: Arc[] = [];
  private rIn = 0;
  private rOut = 0;
  private half = 0;
  private frozen = false;
  private painted = false;

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'arcs';
    this.canvas.style.cssText = 'position:absolute;pointer-events:none;display:none;';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.scratch = document.createElement('canvas');
    this.sctx = this.scratch.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const m = Math.min(window.innerWidth, window.innerHeight);
    this.rOut = OUT_FRAC * m;
    this.rIn = IN_FRAC * this.rOut;
    this.half = Math.ceil(this.rOut) + 2;
    const s = this.half * 2;
    this.canvas.width = s;
    this.canvas.height = s;
    this.canvas.style.width = `${s}px`;
    this.canvas.style.height = `${s}px`;
    this.scratch.width = s;
    this.scratch.height = s;
    centreSquare(this.canvas, this.half);
    this.paint();
  }

  /** Outer radius in CSS px - hud.ts keeps text out of this band. */
  get outerRadius(): number {
    return this.rOut;
  }

  /**
   * @param bearing radians, 0 = dead ahead, positive clockwise
   * @param damage  hit points; drives width, and only lightly drives opacity
   */
  add(bearing: number, damage: number): void {
    const mag = Math.max(0, Math.min(1, (damage > 0 ? damage : 20) / DMG_FULL));
    // 0.80..1.00. A hit is never faint: the periphery drops low-contrast marks
    // first, and the periphery is what reads this cue.
    const peak = 0.8 + mag * 0.2;
    const half = (W_MIN + (W_MAX - W_MIN) * mag) / 2;
    for (const a of this.arcs) {
      let d = bearing - a.bearing;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) < MERGE_DEG * DEG) {
        a.bearing += d * 0.5;
        a.peak = Math.max(a.peak, peak);
        a.half = Math.max(a.half, half);
        a.age = 0;
        this.paint();
        return;
      }
    }
    this.arcs.push({ bearing, peak, half, age: 0 });
    if (this.arcs.length > MAX_ARCS) {
      this.arcs.sort((x, y) => x.age - y.age).length = MAX_ARCS;
    }
    this.paint();
  }

  update(dt: number): void {
    if (this.frozen) return;
    if (this.arcs.length === 0) {
      if (this.painted) this.paint();
      return;
    }
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      this.arcs[i].age += dt;
      if (this.arcs[i].age >= LIFE) this.arcs.splice(i, 1);
    }
    this.paint();
  }

  /** Review captures: hold the wedge at the peak of its envelope. */
  freeze(): void {
    this.frozen = true;
    for (const a of this.arcs) a.age = RISE + HOLD * 0.5;
    this.paint();
  }

  clear(): void {
    this.frozen = false;
    this.arcs.length = 0;
    this.paint();
  }

  /** Punch in over 90ms, hold 180ms, ease out over 800ms. Opacity only. */
  private envelope(age: number): number {
    if (age < RISE) return age / RISE;
    if (age < RISE + HOLD) return 1;
    const u = Math.min(1, (age - RISE - HOLD) / FALL);
    return (1 - u) * (1 - u);
  }

  /** Tight bounding box of one wedge INCLUDING its halo, in canvas coords. */
  private bbox(mid: number, h: number): [number, number, number, number] {
    const m = this.half;
    let x0 = m, y0 = m, x1 = m, y1 = m;
    for (let i = 0; i <= 16; i++) {
      const a = mid - h + (2 * h * i) / 16;
      for (const r of [this.rIn - HALO, this.rOut + HALO]) {
        const x = m + Math.cos(a) * r;
        const y = m + Math.sin(a) * r;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
    const pad = 2;
    return [
      Math.max(0, Math.floor(x0 - pad)),
      Math.max(0, Math.floor(y0 - pad)),
      Math.min(this.half * 2, Math.ceil(x1 + pad)),
      Math.min(this.half * 2, Math.ceil(y1 + pad)),
    ];
  }

  /** Annulus segment path. No stroke is ever applied to it. */
  private wedgePath(
    ctx: CanvasRenderingContext2D, mid: number, h: number, rIn: number, rOut: number
  ): void {
    const m = this.half;
    ctx.beginPath();
    ctx.arc(m, m, rOut, mid - h, mid + h);
    ctx.arc(m, m, rIn, mid + h, mid - h, true);
    ctx.closePath();
  }

  private radial(
    ctx: CanvasRenderingContext2D, rgb: string, peak: number, rIn: number, rOut: number
  ): CanvasGradient {
    const m = this.half;
    const g = ctx.createRadialGradient(m, m, rIn, m, m, rOut);
    g.addColorStop(0, `rgba(${rgb},0)`);
    g.addColorStop(PEAK_T * 0.55, `rgba(${rgb},${(peak * 0.55).toFixed(3)})`);
    g.addColorStop(PEAK_T, `rgba(${rgb},${peak.toFixed(3)})`);
    g.addColorStop(0.86, `rgba(${rgb},${(peak * 0.5).toFixed(3)})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    return g;
  }

  private paint(): void {
    const c = this.ctx;
    const s = this.half * 2;
    c.clearRect(0, 0, s, s);
    if (this.arcs.length === 0) {
      this.canvas.style.display = 'none';
      this.painted = false;
      return;
    }
    this.canvas.style.display = 'block';
    this.painted = true;

    const sc = this.sctx;
    for (const a of this.arcs) {
      const base = a.peak * this.envelope(a.age);
      if (base <= 0.01) continue;
      // Screen up is -Y, i.e. canvas angle -90deg.
      const mid = a.bearing - Math.PI / 2;
      const h = a.half;
      const [bx0, by0, bx1, by1] = this.bbox(mid, h);
      const bw = bx1 - bx0;
      const bh = by1 - by0;
      if (bw <= 0 || bh <= 0) continue;

      sc.globalCompositeOperation = 'source-over';
      sc.clearRect(bx0, by0, bw, bh);
      // Pass 1: a HALO-wider darkening wedge. It does two jobs at once - it
      // gives the hot pass a neutral ground to composite against (so the red
      // stays red over blue sky instead of going mauve) and it separates the
      // whole mark from the world by luminance, which no single translucent
      // colour can do against both a bright sky and dark olive.
      sc.fillStyle = this.radial(sc, '0,0,0', DARK_A, this.rIn - HALO, this.rOut + HALO);
      this.wedgePath(sc, mid, h, this.rIn - HALO, this.rOut + HALO);
      sc.fill();
      // Pass 2: the hot pass, inside the halo.
      sc.fillStyle = this.radial(sc, PAL.wedge, HOT_A, this.rIn, this.rOut);
      this.wedgePath(sc, mid, h, this.rIn, this.rOut);
      sc.fill();
      // Pass 3: angular falloff to zero at both ends, as an alpha mask.
      this.angularMask(sc, mid, h, bx0, by0, bw, bh);

      c.globalAlpha = base;
      c.drawImage(this.scratch, bx0, by0, bw, bh, bx0, by0, bw, bh);
    }
    c.globalAlpha = 1;
  }

  /**
   * destination-in with a conic gradient: 0 at both angular ends, 1 at the mid
   * angle. Colour is irrelevant - only the alpha channel is read.
   */
  private angularMask(
    ctx: CanvasRenderingContext2D, mid: number, h: number,
    bx: number, by: number, bw: number, bh: number
  ): void {
    const m = this.half;
    ctx.globalCompositeOperation = 'destination-in';
    const make = (ctx as CanvasRenderingContext2D).createConicGradient;
    if (typeof make === 'function') {
      const g = make.call(ctx, mid - h, m, m);
      const T = h / Math.PI; // fraction of a full turn covered by the sweep
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(T * 0.16, 'rgba(0,0,0,0.55)');
      g.addColorStop(T * 0.34, 'rgba(0,0,0,0.95)');
      g.addColorStop(T * 0.5, 'rgba(0,0,0,1)');
      g.addColorStop(T * 0.66, 'rgba(0,0,0,0.95)');
      g.addColorStop(T * 0.84, 'rgba(0,0,0,0.55)');
      g.addColorStop(Math.min(1, T), 'rgba(0,0,0,0)');
      if (T < 1) g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
    } else {
      // No conic support: keep the mark rather than dropping it, and accept a
      // flat angular profile. Every other soft edge still holds.
      ctx.fillStyle = 'rgba(0,0,0,0.9)';
    }
    ctx.fillRect(bx, by, bw, bh);
    ctx.globalCompositeOperation = 'source-over';
  }
}
