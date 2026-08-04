// Inline SVG glyph atlas. Zero downloads: every mark is a hand-authored path,
// keyed by id, so the HUD reads as icons (game) instead of bordered text chips
// (web notification stack).
//
// Kill-feed silhouettes are authored on a 28x12 box and headshot/zone marks on
// 14x12, so every mark shares one 12px cap height with the name type beside it.
// Inventory marks are authored on a 20x20 box.
//
// Every glyph is monochrome light-on-dark and carries no accent colour: the
// three semantic accents (zone / hot / action) belong to state, not to objects.

const INK = 'rgba(255,255,255,0.95)';
const DIM = 'rgba(255,255,255,0.42)';
/** The one glyph allowed an accent is the zone mark, because the accent IS
 *  the cause of death it reports. Imported as a literal so glyphs.ts has no
 *  module cycle with palette.ts consumers. */
const ZONE = '#2f7fb8';

const WEAPON_PATHS: Record<string, string> = {
  // AKM: stock, receiver, barrel + front sight, banana magazine, pistol grip.
  akm:
    'M0.6 5.2 L7.2 4.0 L7.2 7.0 L0.6 8.0 Z' +
    'M7.2 3.6 H17.4 V7.2 H7.2 Z' +
    'M17.4 4.6 H26.6 V5.9 H17.4 Z' +
    'M22.4 2.9 H23.7 V4.6 H22.4 Z' +
    'M18.6 5.9 H21.6 V7.3 H18.6 Z' +
    'M10.4 7.2 C10.0 9.3 10.9 11.1 12.4 11.8 L14.7 11.1 C13.4 10.1 12.9 8.7 13.0 7.2 Z' +
    'M15.3 7.2 H17.7 L16.6 10.7 H14.9 Z',
};

/** 28x12 monochrome weapon silhouette, or null for an unknown id. */
export function weaponGlyph(id: string, fill = INK): string | null {
  const d = WEAPON_PATHS[id.toLowerCase()];
  if (!d) return null;
  return (
    `<svg class="glyph" width="28" height="12" viewBox="0 0 28 12" aria-hidden="true">` +
    `<path d="${d}" fill="${fill}"/></svg>`
  );
}

/** Same silhouette at an arbitrary width, for the active weapon slot chip. */
export function weaponGlyphAt(id: string, w: number, fill = INK): string {
  const d = WEAPON_PATHS[id.toLowerCase()];
  if (!d) return '';
  return (
    `<svg class="glyph" width="${w}" height="${(w * 12) / 28}" viewBox="0 0 28 12" ` +
    `aria-hidden="true"><path d="${d}" fill="${fill}"/></svg>`
  );
}

/** Helmet-with-crosshair, 12px cap height. Light on dark, never red. */
export function headshotGlyph(): string {
  return (
    '<svg class="glyph" width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">' +
    '<path d="M1.0 9.0 A6.0 6.0 0 0 1 13.0 9.0 Z M0.2 9.0 H13.8 V11.0 H0.2 Z" ' +
    `fill="${INK}"/>` +
    '<path d="M6.3 2.0 H7.7 V4.2 H6.3 Z M6.3 6.0 H7.7 V8.2 H6.3 Z ' +
    'M2.6 4.6 H4.8 V5.9 H2.6 Z M9.2 4.6 H11.4 V5.9 H9.2 Z ' +
    'M6.6 4.9 H7.4 V5.7 H6.6 Z" fill="rgba(10,13,17,0.95)"/></svg>'
  );
}

/**
 * Blue-zone cause-of-death mark: a SOLID filled disc with a knocked-out centre,
 * in the zone accent.
 *
 * It used to be a dashed ring, which at 14px is visually identical to a loading
 * spinner - a kill-feed row that reads as "something is loading" is worse than
 * no glyph at all. Solid geometry cannot be mistaken for motion.
 */
export function zoneGlyph(size = 16): string {
  return (
    `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">` +
    `<circle cx="8" cy="8" r="7" fill="${ZONE}"/>` +
    '<circle cx="8" cy="8" r="3.1" fill="rgba(10,13,17,0.9)"/></svg>'
  );
}

/** Rifle round, for the "pick up ammo" prompt. */
export function ammoGlyph(w = 24): string {
  return G(
    `<path d="M8.4 2.6 C10.4 4.2 11.4 6.0 11.4 7.6 H8.6 Z" fill="${INK}"/>` +
      `<path d="M6.6 7.6 H13.4 V12.6 H6.6 Z" fill="${INK}"/>` +
      `<path d="M6.0 12.6 H14.0 V17.0 H6.0 Z" fill="${INK}"/>` +
      `<path d="M6.6 13.8 H13.4 V15.0 H6.6 Z" fill="rgba(10,13,17,0.8)"/>`,
    w
  );
}

// ---------------------------------------------------------------------------
// Gear and attachments, authored on 20x20.
// ---------------------------------------------------------------------------

const G = (body: string, w = 18): string =>
  `<svg class="glyph" width="${w}" height="${w}" viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`;

/** Combat helmet: dome, brim, nape. */
export function helmetGlyph(w = 18): string {
  return G(
    `<path d="M3.2 12.4 A6.8 6.8 0 0 1 16.8 12.4 L16.8 13.6 L14.6 13.6 ` +
      `A5 5 0 0 0 5.4 13.6 L3.2 13.6 Z" fill="${INK}"/>` +
      `<path d="M5.4 13.6 A5 5 0 0 1 14.6 13.6 L14.6 16.2 L12.8 16.2 ` +
      `L12.8 14.6 L7.2 14.6 L7.2 16.2 L5.4 16.2 Z" fill="${INK}"/>`,
    w
  );
}

/** Plate carrier: torso panel with shoulder straps. */
export function vestGlyph(w = 18): string {
  return G(
    `<path d="M6.4 3.4 L10 5.6 L13.6 3.4 L16.4 5.0 L15.2 8.2 L15.2 16.4 ` +
      `L4.8 16.4 L4.8 8.2 L3.6 5.0 Z" fill="${INK}"/>` +
      `<path d="M8.2 9.4 H11.8 V11.0 H8.2 Z M8.2 12.2 H11.8 V13.8 H8.2 Z" ` +
      `fill="rgba(10,13,17,0.85)"/>`,
    w
  );
}

/**
 * Rucksack: wide body, lid band, two shoulder straps. Authored wide on purpose
 * - a narrow body with a single horizontal bar reads as a padlock at 18px.
 */
export function packGlyph(w = 18): string {
  return G(
    `<path d="M4.6 7.6 A5.4 5.4 0 0 1 15.4 7.6 L15.4 16.9 L4.6 16.9 Z" fill="${INK}"/>` +
      `<path d="M4.6 9.6 H15.4 V11.2 H4.6 Z" fill="rgba(10,13,17,0.82)"/>` +
      `<path d="M7.0 12.2 H8.7 V16.9 H7.0 Z M11.3 12.2 H13.0 V16.9 H11.3 Z" ` +
      `fill="rgba(10,13,17,0.82)"/>`,
    w
  );
}

/** Energy drink: can with a tab. Boost quick-slot. */
export function boostGlyph(w = 20): string {
  return G(
    `<path d="M6.6 4.6 H13.4 L12.9 16.4 A0.8 0.8 0 0 1 12.1 17.1 H7.9 ` +
      `A0.8 0.8 0 0 1 7.1 16.4 Z" fill="${INK}"/>` +
      `<path d="M6.2 3.0 H13.8 V4.6 H6.2 Z" fill="${INK}"/>` +
      `<path d="M8.4 7.2 H11.6 V13.6 H8.4 Z" fill="rgba(10,13,17,0.8)"/>`,
    w
  );
}

/** First aid: a case with a cross. Heal quick-slot. */
export function healGlyph(w = 20): string {
  return G(
    `<path d="M3.4 6.2 H16.6 V16.4 H3.4 Z" fill="${INK}"/>` +
      `<path d="M7.6 3.6 H12.4 V6.2 H7.6 Z" fill="${INK}"/>` +
      `<path d="M9.0 8.4 H11.0 V10.4 H13.0 V12.4 H11.0 V14.4 H9.0 V12.4 ` +
      `H7.0 V10.4 H9.0 Z" fill="rgba(10,13,17,0.85)"/>`,
    w
  );
}

const ATTACH: Record<string, string> = {
  muzzle: 'M2 8.4 H12.4 V11.6 H2 Z M12.4 6.8 H17.6 V13.2 H12.4 Z',
  grip: 'M8.2 3.2 H11.8 V7.4 H8.2 Z M6.8 7.4 H13.2 V10.2 H6.8 Z ' +
    'M8.6 10.2 H11.4 V16.8 H8.6 Z',
  mag: 'M6.6 3.2 H13.4 V6.0 H6.6 Z M7.4 6.0 H12.6 L13.8 15.0 ' +
    'A2 2 0 0 1 11.9 17.2 H8.1 A2 2 0 0 1 6.2 15.0 Z',
  sight: 'M3.4 7.2 H16.6 V12.8 H3.4 Z M8.4 4.2 H11.6 V7.2 H8.4 Z ' +
    'M9.4 9.2 H10.6 V10.8 H9.4 Z',
};

/** 12px attachment pip. Empty slots drop to 0.35 alpha rather than vanishing. */
export function attachGlyph(kind: keyof typeof ATTACH | string, filled: boolean): string {
  const d = ATTACH[kind] ?? ATTACH.mag;
  return G(`<path d="${d}" fill="${filled ? INK : DIM}"/>`, 12);
}
