import { CONTOUR, PAL } from './palette';

// Layout, type and surface tokens for the whole HUD, in ONE place.
//
// Cycle 4 changes three systems that cycle 3 got wrong at the root:
//
// 1. ONE MARGIN, ONE BASELINE. --hud-safe is now 2.5vh (27px at 1080p) and
//    EVERY bottom-anchored cluster resolves to bottom = H - 27. Cycle 3 had the
//    health bar ending 68px off the bottom while the minimap footer ended 36px
//    off it, so the centre of the frame floated 32px above the corner for no
//    reason. There is also no debug safe-area rect any more: it strokes a
//    dashed spring-green rectangle 30px inside every viewport edge, which in a
//    review still is indistinguishable from a leftover `outline: 2px dashed`
//    and destroys the shot on sight. The insets it existed to prove are now
//    enforced by this one token, which is a stronger guarantee than a capture.
//
// 2. ONE TYPE SCALE, ONE CASING RULE. Four steps - 11 / 15 / 18 / 26 - all
//    uppercase at 0.08em, all tabular. Cycle 3 mixed tracked caps for labels
//    with sentence case for every alert and prompt, which is two voices on one
//    screen. And every glyph now carries the eight-offset CONTOUR instead of a
//    2-3px offset drop shadow.
//
// 3. ONE SURFACE VOCABULARY. Text that must survive an uncontrolled background
//    gets a plate (kill feed, prompt, alive/kills); everything else gets the
//    contour. Plates are one colour at two alphas - see palette.PAL.

/** Screen-edge inset. 2.5vh = 27px at 1080p, and it scales with the canvas. */
export const SAFE = 'var(--hud-safe)';

export const TOKENS = `
  --hud-safe: 2.5vh;
  --hud-radius: 3px;
  --hud-track: 0.08em;

  /* 11 / 15 / 18 / 26 at 1080p. Nothing between, nothing outside, except the
     two display sizes that are their own lockups. */
  --t-xs: 1.02vh;
  --t-sm: 1.39vh;
  --t-md: 1.67vh;
  --t-lg: 2.41vh;
  --t-display: 3.15vh;
  --t-hero: 5.6vh;

  --ink: ${PAL.ink};
  --mid: ${PAL.mid};
  --dim: ${PAL.dim};
  --hud-zone: ${PAL.zone};
  --hud-hot: ${PAL.hot};
  --hud-hot-bright: ${PAL.hotBright};
  --hud-action: ${PAL.action};
  --hud-action-light: ${PAL.actionLight};
  --hud-plate: ${PAL.plate};
  --hud-plate-soft: ${PAL.plateSoft};
  --hud-hair: ${PAL.hair};

  /* Symmetric, never offset. Inherited by every glyph in the overlay. */
  --hud-shadow: ${CONTOUR};
`;

/**
 * Shared text rules.
 *
 * The contour is set once on #hud and INHERITED rather than applied through a
 * utility class, because a class has to be remembered on every new element and
 * cycle 2 proved what happens when it is not. The two elements that must not
 * carry it (the keycap letter on its own chip, and anything already sitting on
 * an opaque plate at full strength) override it explicitly.
 */
export const TEXT_CSS = `
  #hud .lbl { text-transform: uppercase; letter-spacing: var(--hud-track);
              font-size: var(--t-xs); font-weight: 600; color: var(--dim); }
  #hud .val { font-size: var(--t-sm); letter-spacing: var(--hud-track);
              text-transform: uppercase; color: var(--ink); }
  #hud .num { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum' 1; }
  /* One plate recipe, two densities. Padding is part of the recipe: a plate
     with no horizontal padding reads as a highlight, not as a surface. */
  #hud .plate { background: var(--hud-plate); border-radius: var(--hud-radius);
                padding: 5px 10px; }
  #hud .plate-s { background: var(--hud-plate-soft); border-radius: var(--hud-radius);
                  padding: 2px 6px; }
`;

/**
 * Places a fixed-size square canvas so its LOCAL centre lands on the integer
 * screen centre.
 *
 * Centre-screen elements must never be positioned with left:50% on an odd-width
 * child: the browser rounds, and a parent border or a scrollbar shifts it
 * again. The cycle-2 build measured its reticle 2.5-3.5px right of the frame
 * centre for exactly that reason, and the hit marker inherited the same drift
 * because both hung off the same mis-centred container.
 *
 * @returns the integer screen centre the caller must derive every coordinate
 *          from - one cx, one cy, no second source of truth.
 */
export function centreSquare(el: HTMLElement, halfCss: number): { cx: number; cy: number } {
  const cx = Math.round(window.innerWidth / 2);
  const cy = Math.round(window.innerHeight / 2);
  el.style.left = `${cx - halfCss}px`;
  el.style.top = `${cy - halfCss}px`;
  return { cx, cy };
}

/** Snap a CSS-space coordinate to a whole device pixel. */
export function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

/**
 * Asserts the reticle centre is the camera's projection centre.
 *
 * The aim point is a promise about where the raycast goes. The renderer's
 * canvas fills the viewport, so its projection centre is the canvas mid-point;
 * if that ever stops matching the integer screen centre the reticle is lying
 * about where bullets land, and that is a fairness bug, not a polish note.
 */
export function assertReticleCentre(cx: number, cy: number): void {
  const gl = document.querySelector('#app canvas') as HTMLCanvasElement | null;
  if (!gl) return;
  const r = gl.getBoundingClientRect();
  const px = r.left + r.width / 2;
  const py = r.top + r.height / 2;
  if (Math.abs(px - cx) > 0.5 || Math.abs(py - cy) > 0.5) {
    console.error(
      `[hud-reticle] FAIL reticle centre (${cx}, ${cy}) != projection centre ` +
        `(${px.toFixed(2)}, ${py.toFixed(2)})`
    );
  } else {
    console.log(`[hud-reticle] PASS reticle on projection centre (${cx}, ${cy})`);
  }
}
