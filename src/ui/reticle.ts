import { assertReticleCentre, centreSquare, snap } from './layout';
import { PAL } from './palette';

// Aim point and hit marker - on TWO layers, through one path renderer.
//
// Cycle 3 put both on one canvas at the same 1px core, 45 degrees apart. Three
// things were wrong with that, and all three are playability failures:
//
// 1. A 1px WHITE CORE DOES NOT HOLD. Sampled on the cycle-3 capture against the
//    white barn wall the reticle sits on: y=539 dark / y=540 white 246 / y=541
//    dark. The contour was right, but one pixel of core inside two pixels of
//    casing is a dark cross with a bright seam, and it disappears the moment
//    the wall fills the frame. Core is now 2px inside a 4px casing, so the mark
//    is 1px of black either side of 2px of white on every arm.
//
// 2. NO CENTRE REFERENCE. A gapped cross with no dot does not state the point
//    of aim, it states a neighbourhood. The dot is drawn through the same
//    two-pass composite so it cannot lose its casing.
//
// 3. THE HIT MARKER WAS THE RETICLE, ROTATED. Same colour, same weight, same
//    doubled-line style, 45 degrees off. A registered hit therefore read as
//    "the reticle got busier" rather than as a discrete event. It is now a
//    separate LAYER with its own weight (2.5px vs 2px), its own colour on a
//    kill, its own geometry and its own scale envelope, and the scale is a CSS
//    transform on the layer rather than a re-rasterised path - so it animates
//    smoothly and costs nothing per frame.
//
// Everything is drawn as stroked paths with a device-pixel half-offset, on a
// backing store scaled by devicePixelRatio, so line weights track DPI instead
// of halving on a HiDPI display. The diagonals are deliberately NOT snapped:
// snapping an off-axis endpoint to the device grid is what produced the
// stair-stepping the critics measured (only 246,246,246 and ~33 in the sample,
// no intermediate blend values at all).

/** Canvas half-size in CSS px. Covers max gap (40) + arm + casing. */
const HALF = 72;

/** Arm length, CSS px. One constant for all four arms. */
const LEN = 7;

/** Reticle core weight, and the casing that surrounds it on both sides. */
const CORE = 2;
const CASE_ADD = 2; // casing lineWidth = CORE + CASE_ADD -> 1px of black per side

const CASING = 'rgba(0,0,0,0.85)';
const WHITE = '#ffffff';

/**
 * Hit marker: its own radii, its own weight, its own life.
 *
 * The inner radius is bound to the LIVE reticle radius plus a clear band, not
 * fixed: at a resting gap of 9 a fixed inner radius of 8 puts the diagonal
 * arms at exactly the radius the cardinal arms occupy, and the two composite
 * into an eight-point starburst - which is the shape the critics rejected in
 * the first place. Separation has to be guaranteed by construction.
 */
const HIT_CLEAR = 9;
const HIT_ARM = 8;
const HIT_CORE = 2.5;
const HIT_CASE = 3.5;
const HIT_LIFE = 0.22;
/** Kill punch: 120ms of scale-out on top of the same 220ms fade. */
const KILL_PUNCH = 0.12;

export type HitKind = 'hit' | 'kill' | 'headshot';

export class Reticle {
  readonly canvas: HTMLCanvasElement;
  readonly hitCanvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cx = 0;
  private cy = 0;
  private gap = 9;
  private hitT = 0;
  private kill = false;
  private frozen = false;
  private dirty = true;
  private hitDirty = true;
  private lastScale = -1;

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'xhair';
    this.canvas.style.cssText = 'position:absolute;pointer-events:none;';
    this.hitCanvas = document.createElement('canvas');
    this.hitCanvas.id = 'hitmk';
    this.hitCanvas.style.cssText =
      'position:absolute;pointer-events:none;opacity:0;will-change:transform,opacity;';
    host.appendChild(this.canvas);
    host.appendChild(this.hitCanvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.hctx = this.hitCanvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    assertReticleCentre(this.cx, this.cy);
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = HALF * 2;
    for (const [el, ctx] of [
      [this.canvas, this.ctx],
      [this.hitCanvas, this.hctx],
    ] as Array<[HTMLCanvasElement, CanvasRenderingContext2D]>) {
      el.width = Math.round(s * this.dpr);
      el.height = Math.round(s * this.dpr);
      el.style.width = `${s}px`;
      el.style.height = `${s}px`;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    const c = centreSquare(this.canvas, HALF);
    centreSquare(this.hitCanvas, HALF);
    this.cx = c.cx;
    this.cy = c.cy;
    this.dirty = true;
    this.hitDirty = true;
    this.paint();
    this.paintHit();
  }

  /** Reticle gap in CSS px - the projected radius of the live spread cone. */
  setGap(px: number): void {
    const g = Math.round(px);
    if (g === this.gap) return;
    this.gap = g;
    this.dirty = true;
    // The hit marker sits outside the reticle, so its radius moves with it.
    this.hitDirty = true;
  }

  showHit(kind: HitKind = 'hit'): void {
    const kill = kind !== 'hit';
    if (kill !== this.kill) {
      this.kill = kill;
      this.hitDirty = true;
    }
    this.hitT = HIT_LIFE;
    this.lastScale = -1;
  }

  clearHit(): void {
    this.frozen = false;
    this.hitT = 0;
    this.hitCanvas.style.opacity = '0';
  }

  /** Review captures: hold the current hit marker instead of fading it out. */
  freeze(): void {
    this.frozen = true;
  }

  update(dt: number): void {
    if (this.hitT > 0 && !this.frozen) this.hitT = Math.max(0, this.hitT - dt);
    if (this.dirty) this.paint();
    if (this.hitDirty) this.paintHit();
    this.applyHitEnvelope();
  }

  // -- rendering -----------------------------------------------------------

  /**
   * Two-pass composite. Both passes walk the SAME path list, so the casing can
   * never drift off the core: black at core+2 first, white at core second.
   */
  private strokePaths(
    ctx: CanvasRenderingContext2D,
    paths: Array<() => void>,
    core: number,
    caseAdd: number,
    colour: string
  ): void {
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = CASING;
    ctx.lineWidth = core + caseAdd;
    for (const p of paths) {
      ctx.beginPath();
      p();
      ctx.stroke();
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = core;
    for (const p of paths) {
      ctx.beginPath();
      p();
      ctx.stroke();
    }
  }

  private paint(): void {
    const c = this.ctx;
    const d = this.dpr;
    c.clearRect(0, 0, HALF * 2, HALF * 2);
    this.dirty = false;

    // Local centre. A half-device-pixel offset puts an even-width stroke on a
    // whole-pixel boundary, which is where it renders hardest.
    const m = HALF;
    const g = this.gap;
    const axis = snap(m, d);

    this.strokePaths(
      c,
      [
        () => { c.moveTo(m - g - LEN, axis); c.lineTo(m - g, axis); },
        () => { c.moveTo(m + g, axis); c.lineTo(m + g + LEN, axis); },
        () => { c.moveTo(axis, m - g - LEN); c.lineTo(axis, m - g); },
        () => { c.moveTo(axis, m + g); c.lineTo(axis, m + g + LEN); },
      ],
      CORE,
      CASE_ADD,
      WHITE
    );

    // Centre dot, same two-pass treatment. Drawn as a 1px path with a fat cap
    // rather than a rect so the casing wraps it evenly on all sides.
    c.lineCap = 'round';
    c.strokeStyle = CASING;
    c.lineWidth = CORE + CASE_ADD;
    c.beginPath();
    c.moveTo(axis, axis);
    c.lineTo(axis, axis);
    c.stroke();
    c.strokeStyle = WHITE;
    c.lineWidth = CORE;
    c.beginPath();
    c.moveTo(axis, axis);
    c.lineTo(axis, axis);
    c.stroke();
    c.lineCap = 'butt';
  }

  /**
   * Hit marker. Four DIAGONAL arms, never sharing the reticle's weight or
   * colour: a body hit is white at 2.5px, a kill is #E04A3F at the same weight.
   * Endpoints are left unsnapped so the rasteriser can anti-alias them - the
   * cycle-3 marker snapped every endpoint to the device grid and stair-stepped
   * visibly at 6x.
   */
  private paintHit(): void {
    const c = this.hctx;
    c.clearRect(0, 0, HALF * 2, HALF * 2);
    this.hitDirty = false;
    const m = HALF;
    const r0 = this.gap + LEN + HIT_CLEAR;
    const paths: Array<() => void> = [];
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const x0 = m + ca * r0;
      const y0 = m + sa * r0;
      const x1 = m + ca * (r0 + HIT_ARM);
      const y1 = m + sa * (r0 + HIT_ARM);
      paths.push(() => { c.moveTo(x0, y0); c.lineTo(x1, y1); });
    }
    this.strokePaths(c, paths, HIT_CORE, HIT_CASE - HIT_CORE, this.kill ? PAL.hotBright : WHITE);
  }

  /**
   * Scale + alpha envelope, applied as a CSS transform on the marker's own
   * layer. A body hit lands big and settles (1.3 -> 1.0); a kill punches out
   * (1.0 -> 1.25 over 120ms). Both fade 1 -> 0 over 220ms on an ease-out.
   */
  private applyHitEnvelope(): void {
    if (this.hitT <= 0) {
      if (this.lastScale !== -1) {
        this.hitCanvas.style.opacity = '0';
        this.lastScale = -1;
      }
      return;
    }
    // u: 0 at the instant of the hit, 1 at the end of its life.
    const u = 1 - this.hitT / HIT_LIFE;
    const ease = 1 - (1 - u) * (1 - u);
    const scale = this.kill
      ? 1 + 0.25 * Math.min(1, u * (HIT_LIFE / KILL_PUNCH))
      : 1.3 - 0.3 * ease;
    const alpha = 1 - ease;
    if (Math.abs(scale - this.lastScale) > 0.002) {
      this.hitCanvas.style.transform = `scale(${scale.toFixed(3)})`;
      this.lastScale = scale;
    }
    this.hitCanvas.style.opacity = alpha.toFixed(3);
  }
}
