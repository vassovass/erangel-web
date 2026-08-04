// Shared HUD design tokens. Both hud.ts and minimap.ts read these so the
// bottom-left cluster (map + zone dock) stays on one 8px grid.
//
// PUBG HUD language: thin weights, small caps, white on translucent dark
// panels, 1px hairline borders, amber used sparingly as the only accent.

/** Base spacing unit. Every offset below is a multiple of it. */
export const GRID = 8;

/** Screen-edge inset for every anchored cluster. */
export const EDGE = GRID * 3; // 24px

/** Corner minimap: CSS size and the zone dock that sits under it. */
export const MAP_CSS = GRID * 26; // 208px
export const DOCK_H = GRID * 3.5; // 28px
/** bottom offset of the minimap canvas: the dock tucks flush underneath it */
export const MAP_BOTTOM = EDGE + DOCK_H; // 52px

/** Backing-store scale for the corner map (crisp vector overlays). */
export const MAP_DPR = 1.6;

/** Metres shown across the corner map. */
export const MAP_VIEW_M = 340;

/** Colour tokens (kept in sync with the CSS custom properties in hud.ts). */
export const COLOR = {
  ink: '#e9eef1',
  dim: '#93a2ac',
  amber: '#e3aa33',
  zoneBlue: '#4f8cff',
  danger: '#e2483a',
  panel: 'rgba(12,14,16,0.52)',
  panelHi: 'rgba(12,14,16,0.66)',
  line: 'rgba(255,255,255,0.20)',
  lineSoft: 'rgba(255,255,255,0.10)',
} as const;

/** Condensed system stack — Bahnschrift ships with Windows, zero downloads. */
export const FONT =
  "'Bahnschrift','DIN Alternate','Segoe UI Variable Text','Segoe UI',system-ui,sans-serif";
