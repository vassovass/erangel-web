// WCAG-style luminance maths used as a SHIPPING GATE for HUD text.
//
// The HUD floats over a world whose background luminance is uncontrolled:
// overcast sky, snow, sand and sunlit plaster all approach pure white. Any
// translucent plate must therefore be checked in its WORST case - composited
// over #ffffff - not against the pretty screenshot it was designed on.
//
// runHudContrastGate() runs once at HUD construction and prints one line per
// checked pair. A failure prints console.error, which the capture harness
// surfaces, so a regression cannot ship silently.

export type RGB = [number, number, number];

export function hexRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function chan(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance([r, g, b]: RGB): number {
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Source-over composite of a translucent plate onto an opaque background. */
export function over(plate: RGB, alpha: number, bg: RGB): RGB {
  return [
    plate[0] * alpha + bg[0] * (1 - alpha),
    plate[1] * alpha + bg[1] * (1 - alpha),
    plate[2] * alpha + bg[2] * (1 - alpha),
  ];
}

export interface ContrastCheck {
  label: string;
  /** Text colour. */
  ink: string;
  /** Plate colour before compositing. */
  plate: string;
  /** Plate alpha (use the LIGHTEST stop of a gradient). */
  alpha: number;
  /** Required minimum ratio. */
  min: number;
}

const WHITE: RGB = [255, 255, 255];

export interface PairCheck {
  label: string;
  /** Foreground colour and the alpha it is painted at. */
  fg: string;
  fgAlpha?: number;
  /** What the foreground must separate FROM, and the alpha THAT is painted at. */
  ref: string;
  refAlpha?: number;
  /** The world pixel both are composited over. */
  bg: string;
  min: number;
}

/**
 * Contrast between two things painted over the SAME known world pixel.
 *
 * The directional damage wedge is the case that needs this, and it needs it
 * because the obvious check is unanswerable: no single colour can clear 3:1
 * against BOTH a bright sky and dark grass. That is arithmetic, not taste - a
 * colour light enough to beat grass is too light to beat sky, and vice versa.
 *
 * What the wedge actually guarantees is a two-part silhouette: a near-black
 * CASING that separates the mark from whatever is behind it, and a hot CORE
 * that separates from the casing. Gate those three statements and the mark is
 * provably visible on both extremes. Gating the fill against an "average"
 * background is what let the cycle-2 arc ship at 1.05:1 over the terrain it was
 * actually drawn on.
 */
export function runPairGate(checks: PairCheck[]): boolean {
  let ok = true;
  for (const c of checks) {
    const bg = hexRgb(c.bg);
    const a = over(hexRgb(c.fg), c.fgAlpha ?? 1, bg);
    const b = over(hexRgb(c.ref), c.refAlpha ?? 1, bg);
    const ratio = contrastRatio(a, b);
    const pass = ratio >= c.min;
    if (!pass) ok = false;
    const line = `[hud-contrast] ${pass ? 'PASS' : 'FAIL'} ${c.label}: ${ratio.toFixed(2)}:1 (min ${c.min}:1, ${c.fg}@${c.fgAlpha ?? 1} vs ${c.ref}@${c.refAlpha ?? 1} over ${c.bg})`;
    if (pass) console.log(line);
    else console.error(line);
  }
  return ok;
}

export interface ChromaCheck {
  label: string;
  /** Alpha of the darkening pass laid down first. */
  dark: number;
  /** The hot colour and the alpha it is painted at, over that darkened ground. */
  hot: string;
  hotAlpha: number;
  /** The whole composited layer is then drawn at this overall opacity. */
  peak: number;
  /** World pixel behind it all. */
  bg: string;
  /** Required R:B ratio of the final composited pixel. */
  minRatio: number;
}

/**
 * CHROMA gate for the damage wedge.
 *
 * Luminance contrast is not the only thing a damage indicator has to hold: it
 * has to still be RED. Cycle 3's wedge sampled (128,109,130) over a sky of
 * (110,140,180) - a mauve smear, because a weak translucent red over a blue
 * background borrows the background's blue faster than it adds its own red.
 * The fix is a darkening pass under the hot pass, and this gate is what proves
 * the fix at the wedge's WEAKEST peak opacity rather than its strongest.
 */
export function runChromaGate(checks: ChromaCheck[]): boolean {
  let ok = true;
  for (const c of checks) {
    const bg = hexRgb(c.bg);
    const hot = hexRgb(c.hot);
    // Layer = hot over black@dark, both on transparent.
    const la = c.hotAlpha + c.dark * (1 - c.hotAlpha);
    const lc: RGB = [
      (hot[0] * c.hotAlpha) / la,
      (hot[1] * c.hotAlpha) / la,
      (hot[2] * c.hotAlpha) / la,
    ];
    const out = over(lc, la * c.peak, bg);
    const ratio = out[2] > 0.001 ? out[0] / out[2] : 999;
    const pass = ratio >= c.minRatio;
    if (!pass) ok = false;
    const line =
      `[hud-contrast] ${pass ? 'PASS' : 'FAIL'} ${c.label}: R:B ${ratio.toFixed(2)} ` +
      `(min ${c.minRatio}, composited rgb(${out.map((v) => Math.round(v)).join(',')}) over ${c.bg})`;
    if (pass) console.log(line);
    else console.error(line);
  }
  return ok;
}

/**
 * Every check composites the plate over pure white (the worst background the
 * game can put behind the HUD) and compares the ink against that.
 */
export function runContrastGate(checks: ContrastCheck[]): boolean {
  let ok = true;
  for (const c of checks) {
    const bg = over(hexRgb(c.plate), c.alpha, WHITE);
    const ratio = contrastRatio(hexRgb(c.ink), bg);
    const pass = ratio >= c.min;
    if (!pass) ok = false;
    const line = `[hud-contrast] ${pass ? 'PASS' : 'FAIL'} ${c.label}: ${ratio.toFixed(2)}:1 (min ${c.min}:1, plate ${c.plate}@${c.alpha} over #ffffff)`;
    if (pass) console.log(line);
    else console.error(line);
  }
  return ok;
}
