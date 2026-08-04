// THE HUD PALETTE. Three accents, three meanings, and a neutral ramp.
//
// Cycle 3 shipped six meanings on one hue. Sampled off that capture: the zone
// alert headline and the minimap phase bar were both exactly #4FC3F7 - Material
// Light Blue 300, a web-UI swatch on a screen whose whole identity is a warm
// late-afternoon island. Health red was #F86A59, a pastel coral. And a single
// amber was carrying RELOADING, the [F] keycap, the active weapon slot, the
// redeploy hint, the map-close hint AND the win headline. When one colour means
// six things it signals nothing.
//
// So the ration is now hard, and every module imports from here:
//
//   ZONE    #2F7FB8  the play-zone circle, its minimap boundary, its compass
//                    segment. NEVER on text - zone copy is white.
//   HOT     #C4362B  incoming damage, and health below 30%. Nothing else.
//   ACTION  #E8A33D  keycaps, boost, your own name in the feed, warnings.
//
// Everything else - kill feed, ammo, armour, compass, alive/kills, prompts,
// end-screen headline - lives on the neutral ramp.

export const PAL = {
  /** Neutral ramp. Nothing outside these three unless it carries a meaning. */
  white: '#ffffff',
  ink: '#f2f2f2',
  mid: '#c8c6c2',
  dim: '#8a8784',

  /** Zone: circle geometry only, never type. */
  zone: '#2f7fb8',
  /** Out-of-zone region wash (map + minimap). */
  zoneWash: 'rgba(47,127,184,0.22)',
  /** Full-screen out-of-zone vignette. */
  zoneVin: 'rgba(47,127,184,0.55)',

  /** Damage and critical health. */
  hot: '#c4362b',
  /** The brighter end of the damage ramp - kill marker, sub-30% health fill. */
  hotBright: '#e04a3f',
  /** Damage wedge fill (pre-alpha). */
  wedge: '214,38,38',

  /** Action: keycaps, boost, own-name, warnings. */
  action: '#e8a33d',
  /** The light end of the action ramp: warning titles, boost fill crown. */
  actionLight: '#f2c14b',

  /** Surfaces. ONE plate colour, two alphas. */
  plate: 'rgba(12,14,16,0.55)',
  plateSoft: 'rgba(0,0,0,0.42)',
  chip: '#1a1c1a',
  hair: 'rgba(255,255,255,0.18)',
  hairSoft: 'rgba(255,255,255,0.12)',
  casing: 'rgba(0,0,0,0.85)',
} as const;

/**
 * Symmetric 1px contour, built from eight offset shadows.
 *
 * Cycle 3 used `0 1px 2px` + a soft pool, i.e. an OFFSET drop shadow. That is
 * the single loudest non-AAA tell an overlay can carry: no shipped BR HUD
 * offsets its text shadow, because an offset shadow decorates a glyph instead
 * of separating it, and it leaves the up-light edge completely unprotected. A
 * true contour surrounds the letterform on all sides.
 *
 * Eight offsets rather than `-webkit-text-stroke` + `paint-order`: paint-order
 * on HTML text is not reliable across Chrome versions and when it is ignored
 * the stroke paints OVER the fill, which erases the glyph instead of casing it.
 * This degrades to nothing worse than a slightly heavier contour.
 */
export const CONTOUR =
  '1px 0 0 rgba(0,0,0,0.9), -1px 0 0 rgba(0,0,0,0.9), ' +
  '0 1px 0 rgba(0,0,0,0.9), 0 -1px 0 rgba(0,0,0,0.9), ' +
  '1px 1px 0 rgba(0,0,0,0.9), -1px 1px 0 rgba(0,0,0,0.9), ' +
  '1px -1px 0 rgba(0,0,0,0.9), -1px -1px 0 rgba(0,0,0,0.9)';

/** Canvas equivalent: a centred (never offset) soft casing. */
export function canvasCasing(ctx: CanvasRenderingContext2D, blur = 4): void {
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowBlur = blur;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
}

export function clearCasing(ctx: CanvasRenderingContext2D): void {
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
}
