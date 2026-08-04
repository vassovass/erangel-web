import { attachGlyph, boostGlyph, healGlyph, helmetGlyph, packGlyph, vestGlyph, weaponGlyphAt } from './glyphs';
import { STR } from './strings';

// The bottom-right instrument column: armour, consumables, weapon slots,
// attachments, ammo. ONE block, ONE right edge, ONE baseline grid.
//
// Cycle 3 shipped this as an assembly rather than a design, and the critics
// were specific about why:
//
//  - Slots 2-5 were bare numerals inside one continuous dark strip with no cell
//    separators, so they read as the string "2 3 4 5" rather than as four empty
//    slots. Every cell is now the same 46x28 box with its own 1px inner border,
//    which is what makes an EMPTY slot legible as a slot.
//  - Slot 1 got a ~90px cell against ~28px for the rest. All five are equal
//    now; the active one signals state with the amber left rule and a lighter
//    fill, which it was already doing correctly.
//  - The equipment glyphs were ~10px grey marks with no counts and no labels -
//    unreadable at play distance. 18px at 0.85 white with a tabular value.
//  - The fire mode was three dots, which at 12px is an ellipsis or a loading
//    state. It is the literal word now.
//  - The backpack row had no durability track where helmet and vest did, so the
//    block had a ragged right edge. It carries an (empty) track.
//  - The four groups sat on four different baselines - health y~1005,
//    consumables y~998, armour 978/1005/1032, ammo caption y~1035. The column
//    is now a flex stack on a 4px rhythm with one shared right edge, and its
//    last row sits on the same bottom margin as the minimap.
//
// SCOPE, STATED PLAINLY: this build has one weapon, no armour system and no
// consumable inventory. Everything below is DISPLAY CHROME driven by the
// constants in this file - the one exception is the active slot, which is real.

export interface Loadout {
  slots: ReadonlyArray<{ key: string; label: string; weapon?: string }>;
  active: number;
  attachments: ReadonlyArray<{ kind: string; filled: boolean }>;
  helmet: { level: number; durability: number };
  vest: { level: number; durability: number };
  pack: { level: number; durability: number };
  boostCount: number;
  healCount: number;
}

export const LOADOUT: Loadout = {
  slots: [
    { key: '1', label: 'PRIMARY', weapon: 'akm' },
    { key: '2', label: 'SECONDARY' },
    { key: '3', label: 'MELEE' },
    { key: '4', label: 'THROWABLE' },
    { key: '5', label: 'HEAL' },
  ],
  active: 0,
  attachments: [
    { kind: 'muzzle', filled: true },
    { kind: 'grip', filled: false },
    { kind: 'mag', filled: true },
    { kind: 'sight', filled: false },
  ],
  helmet: { level: 2, durability: 0.78 },
  vest: { level: 2, durability: 0.64 },
  // A backpack has no durability in this build; the track renders empty rather
  // than being omitted, so the three rows keep one right edge.
  pack: { level: 3, durability: 0 },
  boostCount: 2,
  healCount: 3,
};

/** Slot cell metrics. Five equal cells is the whole point - do not special-case. */
const CELL_W = 46;
const CELL_H = 28;
const CELL_GAP = 2;

export const INVENTORY_CSS = `
  /* ---------- the instrument column ----------
     Right edge sits one gutter left of the minimap, bottom edge on the same
     margin as everything else. 560px wide, laid out on a 4px rhythm. */
  #brdeck { position: absolute; bottom: var(--hud-safe);
            right: calc(var(--hud-safe) + var(--map-w) + 18px);
            width: 500px; display: flex; flex-direction: column;
            align-items: stretch; gap: 4px; }
  /* Feathered backing for the whole column: a blurred solid box, so the plate
     has no edge anywhere. One surface for the group, not five per-element
     plates - the block has to hold together over any terrain. */
  #brdeck::before { content: ''; position: absolute; z-index: -1;
                    left: -16px; right: -12px; top: -12px; bottom: -10px;
                    background: rgba(0,0,0,0.28); border-radius: 8px;
                    filter: blur(10px); }
  /* flex-end, not space-between: spreading four groups across 560px left a
     ~280px hole in the middle of the block and the consumables floated in it
     unanchored. The groups hug one right edge with a fixed 30px gutter, and
     the health bars underneath set the block's true width. */
  #brdeck .drow { display: flex; align-items: flex-end;
                  justify-content: flex-end; gap: 30px; }

  /* ---------- armour ---------- */
  #gear { display: flex; align-items: flex-end; gap: 16px; }
  #gear .g { display: flex; align-items: center; gap: 6px; height: 20px; }
  #gear .ico { display: block; opacity: 0.85; }
  #gear .lv { font-size: var(--t-xs); font-weight: 600; letter-spacing: var(--hud-track);
              color: var(--ink); font-variant-numeric: tabular-nums; }
  #gear .dur { width: 40px; height: 3px; background: rgba(255,255,255,0.14);
               box-shadow: 0 0 0 1px rgba(0,0,0,0.6); }
  #gear .dur > i { display: block; height: 100%; background: rgba(255,255,255,0.88); }

  /* ---------- consumables ---------- */
  #quick { display: flex; align-items: center; gap: 16px; height: 20px; }
  #quick .q { display: flex; align-items: center; gap: 5px; }
  #quick .q > svg { display: block; opacity: 0.85; }
  /* A normal-weight numeral beside the icon, not a subscript badge hanging off
     its corner: a count is a value, and values sit on the baseline. */
  #quick .n { font-size: var(--t-sm); font-weight: 500; color: var(--ink);
              font-variant-numeric: tabular-nums; letter-spacing: var(--hud-track); }

  /* ---------- weapon slots: five equal cells ---------- */
  #slots { display: flex; align-items: stretch; gap: ${CELL_GAP}px; }
  #slots .s { position: relative; width: ${CELL_W}px; height: ${CELL_H}px;
              display: flex; align-items: center; justify-content: center;
              background: rgba(0,0,0,0.42);
              box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10);
              border-radius: var(--hud-radius); }
  #slots .s > b { position: absolute; left: 4px; top: 2px; font-size: var(--t-xs);
                  font-weight: 600; letter-spacing: 0; color: rgba(255,255,255,0.45);
                  font-variant-numeric: tabular-nums; }
  #slots .s.on { background: rgba(0,0,0,0.62);
                 box-shadow: inset 0 0 0 1px rgba(255,255,255,0.18),
                             inset 3px 0 0 var(--hud-action); }
  #slots .s.on > b { color: var(--ink); }
  #slots .s .sil { display: block; opacity: 0.95; margin-top: 3px; }

  #attach { display: flex; align-items: center; gap: 6px; }
  #attach .p { display: block; }
`;

const bar = (k: number): string =>
  `<span class="dur"><i style="width:${Math.round(k * 100)}%"></i></span>`;

/** Armour row: helmet, vest, backpack. Icon + level + durability remaining. */
export function gearHtml(l: Loadout = LOADOUT): string {
  return (
    '<div id="gear">' +
    `<div class="g"><span class="ico">${helmetGlyph(18)}</span>` +
    `<span class="lv">LV${l.helmet.level}</span>${bar(l.helmet.durability)}</div>` +
    `<div class="g"><span class="ico">${vestGlyph(18)}</span>` +
    `<span class="lv">LV${l.vest.level}</span>${bar(l.vest.durability)}</div>` +
    `<div class="g"><span class="ico">${packGlyph(18)}</span>` +
    `<span class="lv">LV${l.pack.level}</span>${bar(l.pack.durability)}</div>` +
    '</div>'
  );
}

/** Five equal cells; the active one carries the amber rule and the silhouette. */
export function slotsHtml(l: Loadout = LOADOUT): string {
  const cells = l.slots
    .map((s, i) => {
      const on = i === l.active;
      const sil = on && s.weapon ? `<span class="sil">${weaponGlyphAt(s.weapon, 30)}</span>` : '';
      return `<div class="s${on ? ' on' : ''}" title="${s.label}"><b>${s.key}</b>${sil}</div>`;
    })
    .join('');
  return `<div id="slots">${cells}</div>`;
}

/** Four attachment pips: muzzle, grip, magazine, sight. Empty ones dim. */
export function attachHtml(l: Loadout = LOADOUT): string {
  const pips = l.attachments
    .map((a) => `<span class="p">${attachGlyph(a.kind, a.filled)}</span>`)
    .join('');
  return `<div id="attach">${pips}</div>`;
}

/** Boost and heal counts, on the baseline beside their icons. */
export function quickHtml(l: Loadout = LOADOUT): string {
  return (
    '<div id="quick">' +
    `<span class="q">${boostGlyph(20)}<i class="n">${l.boostCount}</i></span>` +
    `<span class="q">${healGlyph(20)}<i class="n">${l.healCount}</i></span>` +
    '</div>'
  );
}

/** Fire mode, calibre and weapon name on one baseline, left of the ammo count. */
export function weaponMetaHtml(calibre: string, name: string): string {
  return (
    '<div id="wmeta">' +
    `<span class="mode">${STR.fireMode}</span>` +
    `<span class="cal">${calibre}</span>` +
    `<span class="wname">${name}</span>` +
    '</div>'
  );
}
