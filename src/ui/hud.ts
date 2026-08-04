import type { Weapon } from '../weapons/weapon';
import type { Health } from '../player/health';
import type { Match } from '../match/match';
import type { PlayerController } from '../player/controller';
import { DOCK_H, FONT, MAP_CSS } from './theme';
import { DamageArcs } from './damagearcs';
import { Reticle } from './reticle';
import { ammoGlyph, headshotGlyph, healGlyph, weaponGlyph, zoneGlyph } from './glyphs';
import { runChromaGate, runContrastGate, runPairGate } from './contrast';
import { collectFootprints } from './worldinfo';
import { STR, assertNoReservedNames } from './strings';
import { TEXT_CSS, TOKENS } from './layout';
import { INVENTORY_CSS, attachHtml, gearHtml, quickHtml, slotsHtml, weaponMetaHtml } from './inventory';
import { PAL } from './palette';

// Battle-royale HUD as a DOM + 2D-canvas overlay (zero GPU draw calls).
//
// CYCLE 4. Five rules, and every element in this file obeys them. Each one is
// a correction of something the cycle-3 panel measured, not a preference.
//
// 1. ONE MARGIN, ONE BASELINE. --hud-safe (2.5vh = 27px) is the only screen
//    edge inset, and every bottom-anchored cluster resolves to bottom = H - 27.
//    Cycle 3 ended the health bar 68px off the bottom and the minimap footer
//    36px off it, so the centre floated 32px above the corner. The dashed
//    debug safe-area rect is gone entirely: it read as a leftover CSS outline
//    in the review still and no shipped title puts hard geometry at the frame
//    edge.
//
// 2. CONTOUR, NEVER AN OFFSET SHADOW. Every glyph in the overlay carries the
//    eight-offset --hud-shadow contour (see palette.CONTOUR). An offset shadow
//    decorates a glyph; a contour separates it, and it protects the up-light
//    edge that an offset leaves bare. Nothing in this file sets
//    shadowOffsetX/Y, and no element carries a coloured glow.
//
// 3. A PLATE WHERE LEGIBILITY IS SCENE-DEPENDENT. The top channel (compass,
//    alive/kills, kill feed) is guaranteed to sit on sky, which is the one
//    background that beats a white glyph. So: a full-width top scrim, a plate
//    under alive/kills, a plate under every feed row, a plate under the
//    interaction prompt, and a feathered plate under the whole bottom-right
//    instrument column. Everything else is contoured ink.
//
// 4. THREE ACCENTS, THREE MEANINGS (palette.ts). Zone #2F7FB8 on circle
//    geometry and never on text; hot #C4362B/#D6413A on incoming damage and
//    critical health; action #E8A33D on keycaps, boost, your own name and
//    warnings. Cycle 3 ran one hue across six unrelated meanings and a
//    Material Design swatch (#4FC3F7) as the loudest colour on a warm island.
//
// 5. ONE SCALE, ONE CASING. 11 / 15 / 18 / 26, uppercase, 0.08em, tabular.
//
// Element ids consumed by tools/capture.mjs (#alive, #zonetimer, #mag) and the
// public method surface main.ts wires are unchanged.

const PX_PER_DEG = 5;
const COMPASS_W = 640;
const COMPASS_H = 28;
const CARET_H = 11;
const COMPASS_FADE = 80;

const WEAPON_ID = 'akm';
const WEAPON_NAME = 'AKM';
const CALIBRE = '7.62';

/** Health fill state thresholds. Two states, not three: a mid-band amber would
 *  be a fourth meaning for the action accent. */
const HP_CRIT = 30;

/** Elements that vanish when the tactical map opens or the match ends. */
const PERSIST = [
  '#topscrim', '#compass', '#topright', '#feed', '#brdeck',
  '#mapdock', '#xhair', '#hitmk', '#prompt', '#zonewarn', '#arcs',
  '#dmgvin', '#zonevin', '#minimapwrap', '#minimap',
];
const sel = (cls: string) => PERSIST.map((s) => `#hud.${cls} ${s}`).join(', ');

type HitKind = 'hit' | 'kill' | 'headshot';

interface FeedRow {
  el: HTMLElement;
  t: number;
  out: boolean;
}

export class Hud {
  private ammoEl!: HTMLElement;
  private resEl!: HTMLElement;
  private hpFill!: HTMLElement;
  private hpGhost!: HTMLElement;
  private hpFlash!: HTMLElement;
  private hpNum!: HTMLElement;
  private boostFill!: HTMLElement;
  private reloadEl!: HTMLElement;
  private reloadBar!: HTMLElement;
  private aliveEl!: HTMLElement;
  private killsEl!: HTMLElement;
  private zoneEl!: HTMLElement;
  private phaseEl!: HTMLElement;
  private dockBar!: HTMLElement;
  private feedEl!: HTMLElement;
  private promptEl!: HTMLElement;
  private vignette!: HTMLElement;
  private zoneVin!: HTMLElement;
  private zoneWarn!: HTMLElement;
  private zoneWarnHead!: HTMLElement;
  private overlay!: HTMLElement;
  private compassEl!: HTMLElement;
  private zoneSegs: HTMLElement[] = [];
  private root!: HTMLElement;
  private arcs!: DamageArcs;
  private reticle!: Reticle;

  private dmgT = 0;
  private flashT = 0;
  private bloom = 0;
  private lowPulse = 0;
  private zonePulse = 0;
  private feed: FeedRow[] = [];
  private hooked = false;
  private demoMode = false;
  private pendingDir: { dx: number; dz: number } | null = null;

  // HUD-side boost model: a BR boost bar fills from consumables. This build has
  // no boost item, so the strip tracks healing (the closest existing signal)
  // and drains slowly - a real readout instead of a permanently empty bar.
  private boost = 0;
  private lastHealHp = -1;

  // Cached last-written values: the HUD updates every frame, so only touch the
  // DOM when something actually changed.
  private lastAmmo = -1;
  private lastRes = -1;
  private lastHp = -1;
  private lastAlive = -1;
  private lastKills = -1;
  private lastZone = '';
  private lastPhase = -1;
  private lastPrompt = '';
  private lastReload = '';
  private lastWarn = false;
  private lastBoost = -1;
  private lastSeg = '';
  private phaseMax = 1;

  constructor(
    private weapon: Weapon,
    private health: Health,
    private match: Match | null,
    private player: PlayerController | null
  ) {
    const root = document.getElementById('hud')!;
    this.root = root;
    root.innerHTML = `
      <style>
        #hud {
          position: fixed; inset: 0; pointer-events: none; z-index: 10;
          font-family: ${FONT}; font-weight: 400; color: var(--ink);
          -webkit-font-smoothing: antialiased;
          ${TOKENS}
          /* Inherited by every glyph in the overlay - see palette.CONTOUR. */
          text-shadow: var(--hud-shadow);
          text-transform: uppercase; letter-spacing: var(--hud-track);
          font-variant-numeric: tabular-nums;
          --map-w: ${MAP_CSS}px;
        }
        ${TEXT_CSS}
        ${INVENTORY_CSS}

        /* ---------- screen feedback ----------
           Both are screen-space washes with no geometry and no hard edge. The
           zone state used to be signalled by a stroked rectangle inset from
           every viewport edge; nothing in a shipped title puts a stroked shape
           within 8% of the frame border. */
        #dmgvin { position: absolute; inset: 0; box-shadow: inset 0 0 170px rgba(196,54,43,0); }
        #zonevin { position: absolute; inset: 0; opacity: 0;
                   background: radial-gradient(ellipse 74% 74% at 50% 50%,
                     rgba(47,127,184,0) 42%, rgba(47,127,184,0.10) 62%,
                     rgba(47,127,184,0.34) 84%, rgba(47,127,184,0.60) 100%); }

        /* ---------- top scrim ----------
           The compass, the alive/kills counter and the kill feed are guaranteed
           to sit on sky. Measured on the cycle-3 capture the white N and the
           centre chevron fell within ~10% luminance of the cloud band directly
           behind them. This is the fairness-of-fights layer, so it gets a
           surface rather than a hope. */
        #topscrim { position: absolute; left: 0; right: 0; top: 0; height: 90px;
                    background: linear-gradient(180deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0) 100%); }

        /* ---------- compass ---------- */
        #compass { position: absolute; top: var(--hud-safe); left: 50%;
                   transform: translateX(-50%);
                   width: ${COMPASS_W}px; height: ${CARET_H + COMPASS_H}px; }
        #compasswin {
          position: absolute; left: 0; right: 0; top: ${CARET_H}px; height: ${COMPASS_H}px;
          overflow: hidden;
          -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 ${COMPASS_FADE}px,
                              #000 ${COMPASS_W - COMPASS_FADE}px, transparent ${COMPASS_W}px);
          mask-image: linear-gradient(90deg, transparent 0, #000 ${COMPASS_FADE}px,
                      #000 ${COMPASS_W - COMPASS_FADE}px, transparent ${COMPASS_W}px);
        }
        #cstrip { position: absolute; left: 0; top: 0; height: ${COMPASS_H}px; will-change: transform; }
        /* Ticks carry their own casing: a 3px black band with the 1px white
           tick inset into it, so they survive a bright sky like every other
           white path in the HUD. */
        #cstrip .tk-min { position: absolute; top: 20px; left: 0; height: 6px; width: 100%;
          background-image:
            repeating-linear-gradient(90deg, rgba(255,255,255,0.78) 0 1px, transparent 1px ${PX_PER_DEG * 5}px),
            repeating-linear-gradient(90deg, rgba(0,0,0,0.85) 0 3px, transparent 3px ${PX_PER_DEG * 5}px);
          background-size: 100% 4px, 100% 6px;
          background-position: 1px 1px, 0 0; background-repeat: repeat-x; }
        #cstrip .tk-maj { position: absolute; top: 16px; left: 0; height: 10px; width: 100%;
          background-image:
            repeating-linear-gradient(90deg, rgba(255,255,255,0.92) 0 1px, transparent 1px ${PX_PER_DEG * 15}px),
            repeating-linear-gradient(90deg, rgba(0,0,0,0.85) 0 3px, transparent 3px ${PX_PER_DEG * 15}px);
          background-size: 100% 8px, 100% 10px;
          background-position: 1px 1px, 0 0; background-repeat: repeat-x; }
        /* Zone bearing, ON the ribbon. The direction of the safe area is a
           compass fact, so it belongs on the compass - not on a screen-space
           decal floating over the skyline, which is where cycle 3 put it. */
        #cstrip .zs { position: absolute; top: 15px; height: 13px; display: none;
                      background: linear-gradient(180deg, rgba(47,127,184,0) 0%,
                                  rgba(47,127,184,0.50) 100%);
                      border-bottom: 2px solid ${PAL.zone}; }
        #cstrip b { position: absolute; transform: translateX(-50%); }
        #cstrip b.card { top: -1px; font-size: var(--t-sm); font-weight: 700;
                         letter-spacing: var(--hud-track); color: #ffffff; }
        #cstrip b.deg { top: 3px; font-size: var(--t-xs); font-weight: 500;
                        letter-spacing: var(--hud-track); color: rgba(255,255,255,0.72); }
        #compass .idx { position: absolute; left: 50%; top: 0; margin-left: -5px;
                        width: 0; height: 0;
                        border-left: 5px solid transparent; border-right: 5px solid transparent;
                        border-top: 8px solid #ffffff;
                        filter: drop-shadow(0 0 1.5px rgba(0,0,0,0.95))
                                drop-shadow(0 0 1.5px rgba(0,0,0,0.9)); }

        /* ---------- top right: alive / kills ---------- */
        #topright { position: absolute; top: var(--hud-safe); right: var(--hud-safe);
                    display: flex; align-items: baseline; gap: 18px;
                    background: var(--hud-plate-soft); border-radius: var(--hud-radius);
                    padding: 3px 6px; }
        #topright .cell { display: flex; align-items: baseline; gap: 6px; }
        #topright .big { font-size: var(--t-md); font-weight: 600; line-height: 1;
                         color: var(--ink); font-variant-numeric: tabular-nums; }

        /* ---------- kill feed ----------
           Three FIXED columns on a 26px row grid, so the weapon glyphs stop
           floating and every row shares one right edge by construction. Each
           row carries its own plate: cycle 3 put them on bare sky at ~2.5:1
           with a soft blur shadow, which softens rather than separates. */
        #feed { position: absolute; top: calc(var(--hud-safe) + 4.6vh); right: var(--hud-safe);
                display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
        #feed .row { display: grid; grid-template-columns: 118px 34px 118px;
                     column-gap: 8px; align-items: center; height: 26px; padding: 0 6px;
                     background: var(--hud-plate-soft); border-radius: var(--hud-radius);
                     opacity: 1; transform: none;
                     transition: opacity 0.5s ease, transform 0.5s ease;
                     animation: feedIn 0.24s cubic-bezier(.2,.8,.3,1); }
        #feed .row.gone { opacity: 0; transform: translateX(16px); }
        #feed .c1 { text-align: right; }
        #feed .c2 { display: flex; align-items: center; justify-content: center; }
        #feed .c3 { text-align: left; }
        /* Names are proper nouns, so they keep their own casing while the rest
           of the overlay is uppercase. */
        #feed .who { font-size: var(--t-sm); letter-spacing: 0.02em; color: var(--ink);
                     text-transform: none; }
        #feed .me { font-size: var(--t-sm); font-weight: 700; letter-spacing: var(--hud-track);
                    color: var(--hud-action); }
        #feed .glyph { display: block; }
        @keyframes feedIn { from { opacity: 0; transform: translateX(22px); } to { opacity: 1; transform: none; } }

        /* ---------- zone alert ----------
           Amber, not cyan. Cyan text on a blue sky is the one colour pairing
           this alert can never afford, and the zone accent belongs to circle
           geometry. Lifted to 16% so it stays clear of the damage ring, whose
           outer radius reaches 30% of frame height. */
        #zonewarn { position: absolute; left: 50%; top: 16%; transform: translateX(-50%);
                    display: flex; flex-direction: column; align-items: center; gap: 4px;
                    opacity: 0; visibility: hidden; text-align: center;
                    transition: opacity 0.4s ease, visibility 0s linear 0.4s; }
        #zonewarn.on { opacity: 1; visibility: visible; transition: opacity 0.4s ease; }
        #zonewarn::before { content: ''; position: absolute; z-index: -1;
                            left: -26px; right: -26px; top: -12px; bottom: -10px;
                            background: rgba(0,0,0,0.30); border-radius: 10px;
                            filter: blur(12px); }
        #zonewarn .h { font-size: var(--t-lg); font-weight: 700;
                       letter-spacing: var(--hud-track); color: var(--hud-action-light); }
        #zonewarn .s { font-size: var(--t-sm); font-weight: 500;
                       letter-spacing: var(--hud-track); color: var(--ink); }

        /* ---------- interact prompt ---------- */
        #prompt { position: absolute; left: 50%; top: 78%;
                  transform: translate(-50%, -50%);
                  display: none; align-items: center; gap: 10px;
                  font-size: var(--t-sm); letter-spacing: var(--hud-track);
                  background: var(--hud-plate); border-radius: var(--hud-radius);
                  padding: 5px 10px; }
        #prompt .ico { display: flex; align-items: center; }
        /* 22x22 chip, not an amber pill: a keycap is a physical key, so it
           reads as a key-shaped object with a light edge, not as a tag. */
        #prompt b { display: flex; align-items: center; justify-content: center;
                    width: 22px; height: 22px; box-sizing: border-box;
                    background: ${PAL.chip}; border: 1px solid rgba(255,255,255,0.35);
                    border-radius: var(--hud-radius); color: var(--hud-action);
                    font-weight: 700; font-size: var(--t-sm); letter-spacing: 0;
                    text-shadow: none; }

        /* ---------- ammo ---------- */
        #ammo { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
        #ammo .reload { font-size: var(--t-xs); font-weight: 600;
                        letter-spacing: var(--hud-track); color: var(--hud-action);
                        height: 13px; opacity: 0; transition: opacity 0.12s ease; }
        #ammo .reload.on { opacity: 1; }
        #ammo .count { display: flex; align-items: baseline; gap: 6px; line-height: 0.92; }
        #mag { font-size: var(--t-display); font-weight: 600; letter-spacing: 0;
               font-variant-numeric: tabular-nums; }
        #res { font-size: var(--t-sm); color: var(--mid); font-variant-numeric: tabular-nums; }
        /* Reload progress is a 2px underline beneath the ammo count, never a
           second bar stacked on the health geometry: a transient timer and a
           persistent vital must not be the same object. */
        #ammo .rbar { width: 132px; height: 2px; margin-top: 3px;
                      background: rgba(255,255,255,0.14);
                      box-shadow: 0 0 0 1px rgba(0,0,0,0.6); }
        #ammo .rbar > i { display: block; height: 100%; width: 0%; background: var(--hud-action); }
        #wmeta { display: flex; align-items: center; gap: 10px; margin-top: 3px;
                 font-size: var(--t-xs); letter-spacing: var(--hud-track); }
        #wmeta .mode { color: var(--ink); font-weight: 600; }
        #wmeta .cal { color: var(--dim); font-weight: 600; }
        #wmeta .wname { color: var(--ink); font-weight: 600; font-size: var(--t-sm); }

        #wstack { display: flex; flex-direction: column; align-items: center; gap: 4px; }

        /* ---------- health + boost ----------
           Health is the tallest, most saturated, highest-contrast element in
           the group in EVERY state. Cycle 3 gave the two gauges identical
           geometry and identical weight, so at 19% health under a 50% boost
           bar the brighter, longer, higher bar was the one that does not keep
           you alive. */
        #hpwrap { display: flex; align-items: flex-end; gap: 10px; }
        #hpnum { width: 52px; text-align: right; font-size: var(--t-md); font-weight: 600;
                 line-height: 1; color: var(--ink); font-variant-numeric: tabular-nums; }
        #hpbars { flex: 1; }
        #boost { position: relative; width: 100%; height: 4px; margin: 0 0 2px;
                 background: rgba(255,255,255,0.20); opacity: 0.7;
                 box-shadow: 0 0 0 1px rgba(0,0,0,0.6); }
        #boostfill { display: block; height: 100%; width: 0%;
                     background: linear-gradient(90deg, ${PAL.action}, ${PAL.actionLight}); }
        #hpbar { position: relative; width: 100%; height: 8px; overflow: hidden;
                 background: rgba(0,0,0,0.85); box-shadow: 0 0 0 1px rgba(0,0,0,0.6); }
        #hpghost { position: absolute; left: 0; top: 0; bottom: 0; width: 100%;
                   background: rgba(255,255,255,0.35); transition: width 0.4s ease 0.15s; }
        #hpfill { position: absolute; left: 0; top: 0; bottom: 0; width: 100%;
                  background: #f2f2f2; transition: width 0.1s linear; }
        #hpflash { position: absolute; inset: 0; background: #ffffff; opacity: 0; }
        /* Dark notches punched through BOTH the fill and the empty region at
           fixed 25/50/75%, so the tick count is constant and they survive on
           the white and the red fill states alike. Cycle 3 drew light ticks
           inside the fill element, so they slid inward as health dropped. */
        #hpticks { position: absolute; inset: 0;
                   background:
                     linear-gradient(90deg, transparent calc(25% - 1px), rgba(0,0,0,0.55) calc(25% - 1px) 25%, transparent 25%),
                     linear-gradient(90deg, transparent calc(50% - 1px), rgba(0,0,0,0.55) calc(50% - 1px) 50%, transparent 50%),
                     linear-gradient(90deg, transparent calc(75% - 1px), rgba(0,0,0,0.55) calc(75% - 1px) 75%, transparent 75%); }

        /* ---------- zone dock (under the minimap, bottom RIGHT) ---------- */
        #mapdock { position: absolute; right: var(--hud-safe); bottom: var(--hud-safe);
                   width: var(--map-w); height: ${DOCK_H}px; box-sizing: border-box;
                   display: flex; flex-direction: column; justify-content: space-between;
                   padding: 4px 8px 5px;
                   background: linear-gradient(rgba(8,10,12,0.86), rgba(8,10,12,0.74)); }
        #mapdock .row { display: flex; align-items: baseline; justify-content: space-between; }
        #zonetimer { font-size: var(--t-sm); letter-spacing: var(--hud-track);
                     font-variant-numeric: tabular-nums; color: var(--ink); }
        #mapdock .track { width: 100%; height: 3px; background: rgba(255,255,255,0.18); }
        #mapdock .track > i { display: block; height: 100%; width: 0%; background: ${PAL.zone}; }

        /* ---------- map open / end screens ---------- */
        ${sel('mapopen')} { opacity: 0 !important; visibility: hidden !important;
                            transition: opacity 120ms ease, visibility 0s linear 120ms; }
        ${sel('ended')} { display: none !important; }
        #hud.ended #fullmap { display: none !important; }
        #endoverlay { position: absolute; inset: 0; z-index: 30; display: none;
                      flex-direction: column; align-items: center; justify-content: center;
                      background: radial-gradient(ellipse at center, rgba(7,10,13,0.55), rgba(3,5,7,0.88));
                      backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px); }
        #endbig { font-family: ${FONT}; font-size: var(--t-hero); font-weight: 800;
                  letter-spacing: var(--hud-track); line-height: 1.06; text-align: center;
                  white-space: pre-line; color: var(--hud-action); }
        #endbig.dead { color: var(--hud-hot); }
        /* The rule and the column dividers are ONE grid: same colour, same
           weight, and the rule sits directly on the divider tops instead of
           floating 15px clear of them, so the lockup closes. */
        #endrule { width: 420px; height: 1px; background: var(--hud-hair); margin: 24px 0 0; }
        #endstats { display: flex; align-items: stretch; }
        #endstats .st { width: 140px; height: 72px; display: flex; flex-direction: column;
                        align-items: center; justify-content: center; gap: 8px; }
        #endstats .st + .st { border-left: 1px solid var(--hud-hair); }
        #endstats .v { font-size: var(--t-lg); font-weight: 700; line-height: 1;
                       font-variant-numeric: tabular-nums; color: #ffffff; }
        #endsub { font-size: var(--t-sm); letter-spacing: var(--hud-track);
                  color: var(--mid); margin-top: 18px; }
        #endhint { font-size: var(--t-sm); letter-spacing: var(--hud-track);
                   color: var(--dim); margin-top: 26px; }
        #endhint b { color: var(--hud-action); font-weight: 700; }
      </style>
      <div id="dmgvin"></div>
      <div id="zonevin"></div>
      <div id="topscrim"></div>

      <div id="compass">
        <div id="compasswin"><div id="cstrip"></div></div>
        <div class="idx"></div>
      </div>

      <div id="topright">
        <div class="cell"><span class="big num" id="alive">16</span><span class="lbl">${STR.alive}</span></div>
        <div class="cell"><span class="big num" id="kills">0</span><span class="lbl">${STR.kills}</span></div>
      </div>
      <div id="feed"></div>

      <div id="zonewarn">
        <div class="h" id="zonewarnh">${STR.zoneShrinking}</div>
        <div class="s">${STR.zoneMove}</div>
      </div>

      <div id="prompt"></div>

      <div id="brdeck">
        <div class="drow">
          ${gearHtml()}
          <div id="ammo">
            <div class="reload" id="reloadtxt">${STR.reloading}</div>
            <div class="count"><span id="mag" class="num">30</span><span id="res" class="num">/ 120</span></div>
            <div class="rbar"><i id="reloadbar"></i></div>
            ${weaponMetaHtml(CALIBRE, WEAPON_NAME)}
          </div>
        </div>
        <div class="drow">
          ${quickHtml()}
          <div id="wstack">${slotsHtml()}${attachHtml()}</div>
        </div>
        <div id="hpwrap">
          <span id="hpnum" class="num">100</span>
          <div id="hpbars">
            <div id="boost"><i id="boostfill"></i></div>
            <div id="hpbar">
              <div id="hpghost"></div><div id="hpfill"></div><div id="hpflash"></div><div id="hpticks"></div>
            </div>
          </div>
        </div>
      </div>

      <div id="mapdock">
        <div class="row">
          <span class="lbl" id="zonephase">${STR.phase(1)}</span>
          <span id="zonetimer">${STR.zoneTimer(0, 50)}</span>
        </div>
        <div class="track"><i id="zoneprog"></i></div>
      </div>

      <div id="endoverlay">
        <div class="big" id="endbig"></div>
        <div id="endrule"></div>
        <div id="endstats"></div>
        <div class="sub" id="endsub"></div>
        <div id="endhint">${STR.redeploy}</div>
      </div>
    `;
    const $ = (id: string) => document.getElementById(id)!;
    this.ammoEl = $('mag');
    this.resEl = $('res');
    this.hpFill = $('hpfill');
    this.hpGhost = $('hpghost');
    this.hpFlash = $('hpflash');
    this.hpNum = $('hpnum');
    this.boostFill = $('boostfill');
    this.reloadEl = $('reloadtxt');
    this.reloadBar = $('reloadbar');
    this.aliveEl = $('alive');
    this.killsEl = $('kills');
    this.zoneEl = $('zonetimer');
    this.phaseEl = $('zonephase');
    this.dockBar = $('zoneprog');
    this.feedEl = $('feed');
    this.promptEl = $('prompt');
    this.vignette = $('dmgvin');
    this.zoneVin = $('zonevin');
    this.zoneWarn = $('zonewarn');
    this.zoneWarnHead = $('zonewarnh');
    this.overlay = $('endoverlay');
    this.compassEl = $('cstrip');

    // Both centre-screen layers position themselves off ONE integer screen
    // centre (see layout.centreSquare) rather than off left:50%.
    this.arcs = new DamageArcs(root);
    this.reticle = new Reticle(root);
    root.insertBefore(this.arcs.canvas, $('compass'));
    root.insertBefore(this.reticle.canvas, $('compass'));
    root.insertBefore(this.reticle.hitCanvas, $('compass'));

    this.buildCompass();
    this.gateContrast();
    assertNoReservedNames();
    collectFootprints(this.match);

    // Review hooks: paint one frame of every transient element or the end card,
    // so single screenshots show the whole vocabulary.
    const w = window as unknown as Record<string, unknown>;
    w.__HUDDEMO__ = () => this.demo();
    w.__HUDEND__ = (state: 'won' | 'dead' = 'won') => this.showEnd(state, 4, 0);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F9') this.demo();
      else if (e.code === 'F10') this.showEnd('won', 4, 0);
    });
  }

  /**
   * Ships-or-fails contrast check, printed to the console and therefore into
   * every capture log.
   *
   * Most of this HUD floats on the world, so what separates a glyph from the
   * background is its own CONTOUR: a 1px black ring at 0.9 alpha. The honest
   * worst case for contoured ink is therefore the contour colour composited
   * over a white sky, and that is what these checks measure.
   */
  private gateContrast(): void {
    runContrastGate([
      { label: 'zonewarn.headline', ink: PAL.actionLight, plate: '#000000', alpha: 0.9, min: 4.5 },
      { label: 'zonewarn.subline', ink: PAL.ink, plate: '#000000', alpha: 0.9, min: 4.5 },
      { label: 'compass.cardinal', ink: '#ffffff', plate: '#000000', alpha: 0.9, min: 4.5 },
      { label: 'feed.name', ink: PAL.ink, plate: '#000000', alpha: 0.9, min: 4.5 },
      { label: 'feed.you', ink: PAL.action, plate: '#000000', alpha: 0.9, min: 4.5 },
      { label: 'topright.value', ink: PAL.ink, plate: '#000000', alpha: 0.9, min: 4.5 },
      { label: 'label.dim', ink: PAL.dim, plate: '#000000', alpha: 0.9, min: 4.5 },
      { label: 'label.mid', ink: PAL.mid, plate: '#000000', alpha: 0.9, min: 4.5 },
      { label: 'ammo.mag', ink: PAL.ink, plate: '#000000', alpha: 0.9, min: 4.5 },
      // Bars, gated at the 3:1 non-text threshold against their OWN empty track
      // composited over a white sky - the worst case for a bar. The track is at
      // 0.85, not 0.55: at 0.55 it composites to grey 115 over sky and no
      // military red can separate from that. This is exactly the arithmetic
      // that made cycle 2 ship a 1.31:1 low-health bar.
      { label: 'health.fill', ink: '#f2f2f2', plate: '#000000', alpha: 0.85, min: 3 },
      { label: 'health.critical', ink: PAL.hotBright, plate: '#000000', alpha: 0.85, min: 3 },
      { label: 'mapdock.timer', ink: PAL.ink, plate: '#080a0c', alpha: 0.74, min: 4.5 },
    ]);

    // Damage wedge silhouette, gated as the statements that are actually TRUE.
    //
    // The wedge carries no stroke, so what separates it from the world is its
    // soft HALO - the darkening pass, drawn 16px wider at each radius. Gate the
    // halo against both extreme backgrounds, and gate the hot core against the
    // halo it sits inside. Cycle 3's version of this gate asked whether the red
    // core out-contrasts its own near-black under-pass over a bright sky, which
    // is not a claim the design makes and cannot be true of any dark red.
    runPairGate([
      { label: 'dmgarc.halo-vs-sky', fg: '#000000', fgAlpha: 0.62, ref: '#d7dce2', bg: '#d7dce2', min: 3 },
      { label: 'dmgarc.halo-vs-grass', fg: '#000000', fgAlpha: 0.62, ref: '#6a6c50', bg: '#6a6c50', min: 2.2 },
      { label: 'dmgarc.core-vs-halo', fg: '#d62626', fgAlpha: 0.95, ref: '#000000', refAlpha: 0.62, bg: '#6a6c50', min: 2.2 },
    ]);

    // CHROMA floor. The cycle-3 wedge composited to (128,109,130) over sky -
    // mauve, not red - because a weak translucent red over a blue background
    // borrows the background's blue. The darkening pass is what fixes it, and
    // this is the check that proves it at the wedge's WEAKEST peak (0.80).
    runChromaGate([
      {
        label: 'dmgarc.red-over-sky',
        dark: 0.62, hot: '#d62626', hotAlpha: 0.95, peak: 0.8,
        bg: '#6e8cb4', minRatio: 2.2,
      },
      {
        label: 'dmgarc.red-over-brightsky',
        dark: 0.62, hot: '#d62626', hotAlpha: 0.95, peak: 0.8,
        bg: '#d7dce2', minRatio: 2.2,
      },
      {
        label: 'dmgarc.red-over-grass',
        dark: 0.62, hot: '#d62626', hotAlpha: 0.95, peak: 0.8,
        bg: '#6a6c50', minRatio: 2.2,
      },
    ]);
  }

  private buildCompass(): void {
    const CARD: Record<number, string> = {
      0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW',
    };
    const parts: string[] = ['<div class="tk-min"></div><div class="tk-maj"></div>'];
    // Three clones of the zone segment, offset by a full turn each way, so a
    // bearing range that wraps through north still paints as one band.
    parts.push('<i class="zs"></i><i class="zs"></i><i class="zs"></i>');
    for (let d = -360; d <= 720; d += 15) {
      const deg = ((d % 360) + 360) % 360;
      const x = (d + 360) * PX_PER_DEG;
      if (CARD[deg]) parts.push(`<b class="card" style="left:${x}px">${CARD[deg]}</b>`);
      else parts.push(`<b class="deg" style="left:${x}px">${deg}</b>`);
    }
    this.compassEl.style.width = `${(720 + 360) * PX_PER_DEG + 40}px`;
    this.compassEl.innerHTML = parts.join('');
    this.zoneSegs = Array.from(this.compassEl.querySelectorAll('.zs')) as HTMLElement[];
  }

  /** Light X on a hit; the kill variant changes colour AND scale envelope. */
  showHitmarker(kind: HitKind = 'hit'): void {
    this.reticle.showHit(kind);
  }

  /**
   * Damage feedback. Called with no arguments by the existing wiring; the
   * lazily-installed Health hook supplies direction so the wedge can point at
   * the shooter.
   */
  showDamage(amount = 0, fromDx = this.pendingDir?.dx ?? 0, fromDz = this.pendingDir?.dz ?? 0): void {
    this.dmgT = Math.max(this.dmgT, 0.55);
    this.flashT = 0.22;
    if (this.player && (fromDx !== 0 || fromDz !== 0)) {
      // fromD* is the bullet travel direction: the shooter sits opposite it.
      const ax = -fromDx;
      const az = -fromDz;
      const y = this.player.yaw;
      const f = ax * -Math.sin(y) + az * -Math.cos(y);
      const r = ax * Math.cos(y) + az * -Math.sin(y);
      this.arcs.add(Math.atan2(r, f), amount);
    }
    this.pendingDir = null;
  }

  /**
   * Kill-feed row, on the three-column grid: killer, cause, victim. Names keep
   * their own casing because they are proper nouns; everything else in the
   * overlay is uppercase.
   */
  addFeedLine(text: string): void {
    const mine = /^you\b/i.test(text);
    const headshot = /headshot/i.test(text);
    const zone = /blue zone/i.test(text);
    const victim = /bot_\d+/i.exec(text)?.[0] ?? 'Enemy';
    const wep = weaponGlyph(WEAPON_ID) ?? `<span class="who">${WEAPON_NAME}</span>`;

    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = zone
      ? `<span class="c1"></span><span class="c2">${zoneGlyph(16)}</span>` +
        `<span class="c3"><span class="who">${victim}</span></span>`
      : `<span class="c1"><span class="me">You</span></span>` +
        `<span class="c2">${headshot ? headshotGlyph() : wep}</span>` +
        `<span class="c3"><span class="who">${victim}</span></span>`;
    this.feedEl.prepend(row);
    this.feed.push({ el: row, t: 6.5, out: false });
    while (this.feed.length > 5) {
      const old = this.feed.shift()!;
      old.el.remove();
    }
    if (mine) this.showHitmarker(headshot ? 'headshot' : 'kill');
  }

  showEnd(state: 'won' | 'dead', kills: number, alive: number): void {
    this.root.classList.add('ended');
    this.root.classList.remove('mapopen');
    // Zero every transient so a frame running after the class is applied cannot
    // repaint a red ghost behind the end card's blur.
    this.dmgT = 0;
    this.flashT = 0;
    this.demoMode = false;
    this.arcs.clear();
    this.reticle.clearHit();
    this.vignette.style.boxShadow = 'inset 0 0 170px rgba(196,54,43,0)';
    this.zoneVin.style.opacity = '0';
    this.zoneWarn.classList.remove('on');

    this.overlay.style.display = 'flex';
    const big = document.getElementById('endbig')!;
    const stats = document.getElementById('endstats')!;
    const sub = document.getElementById('endsub')!;
    const place = state === 'won' ? 1 : alive + 1;
    stats.innerHTML =
      `<div class="st"><span class="v num">#${place}</span><span class="lbl">${STR.statPlacement}</span></div>` +
      `<div class="st"><span class="v num">${kills}</span><span class="lbl">${STR.statKills}</span></div>` +
      `<div class="st"><span class="v num">16</span><span class="lbl">${STR.statPlayers}</span></div>`;
    if (state === 'won') {
      big.classList.remove('dead');
      big.textContent = STR.winHeadline;
      sub.textContent = STR.winSub;
    } else {
      big.classList.add('dead');
      big.textContent = STR.deadHeadline;
      sub.textContent = STR.deadSub(place, 16);
    }
  }

  update(dt: number): void {
    if (!this.hooked) {
      this.hooked = true;
      this.hookHealth();
    }

    // ---- ammo ----
    if (this.weapon.ammo !== this.lastAmmo) {
      if (this.weapon.ammo < this.lastAmmo) this.bloom = Math.min(this.bloom + 0.25, 1.2);
      this.lastAmmo = this.weapon.ammo;
      this.ammoEl.textContent = String(this.weapon.ammo);
    }
    if (this.weapon.reserve !== this.lastRes) {
      this.lastRes = this.weapon.reserve;
      this.resEl.textContent = `/ ${this.weapon.reserve}`;
    }
    const reloading = this.weapon.phase === 'reloading';
    const rtxt = reloading ? STR.reloading : '';
    if (rtxt !== this.lastReload) {
      this.lastReload = rtxt;
      this.reloadEl.classList.toggle('on', reloading);
      if (!reloading) this.reloadBar.style.width = '0%';
    }
    if (reloading) this.reloadBar.style.width = `${(this.weapon.reloadProgress * 100).toFixed(0)}%`;

    // ---- crosshair bloom, bound to the live spread cone ----
    this.bloom = Math.max(0, this.bloom - dt * 1.8);
    this.updateSpread();
    this.reticle.update(dt);

    // ---- health ----
    const hp = Math.round(this.health.hp);
    if (hp !== this.lastHp) {
      if (this.lastHealHp >= 0 && hp > this.lastHealHp) {
        this.boost = Math.min(100, this.boost + (hp - this.lastHealHp) * 0.9);
      }
      this.lastHealHp = hp;
      this.lastHp = hp;
      this.hpFill.style.width = `${hp}%`;
      this.hpGhost.style.width = `${hp}%`;
      this.hpNum.textContent = String(Math.max(0, hp));
      // TWO states, not three. A mid-band amber would be a fourth meaning for
      // the action accent, and the palette rations one meaning per hue. The
      // critical colour is #E04A3F rather than the darker #C4362B because the
      // contrast gate is real: a dark red inside a dark track measures 2.16:1
      // against its own empty region over a white sky, and that is not a
      // readout, it is a decoration.
      this.hpFill.style.background = hp < HP_CRIT ? PAL.hotBright : '#f2f2f2';
    }
    if (this.boost > 0) this.boost = Math.max(0, this.boost - dt * 1.2);
    const boostPct = Math.round(this.boost);
    if (boostPct !== this.lastBoost) {
      this.lastBoost = boostPct;
      this.boostFill.style.width = `${boostPct}%`;
    }
    // Below critical: signal with MOTION on the health bar alone.
    if (hp < HP_CRIT && !this.health.dead) {
      this.lowPulse += dt * Math.PI * 1.667; // 1.2s period
      this.hpFill.style.opacity = (0.775 + 0.225 * Math.sin(this.lowPulse)).toFixed(2);
    } else if (this.hpFill.style.opacity !== '1') {
      this.hpFill.style.opacity = '1';
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.hpFlash.style.opacity = Math.max(0, this.flashT * 3.4).toFixed(2);
    }

    // ---- screen feedback ----
    if (this.dmgT > 0) {
      this.dmgT -= dt;
      const a = Math.max(0, Math.min(0.42, this.dmgT * 0.7));
      this.vignette.style.boxShadow = `inset 0 0 170px rgba(196,54,43,${a.toFixed(2)})`;
    }
    this.arcs.update(dt);

    // ---- compass ----
    if (this.player) {
      const deg = ((-this.player.yaw * 180) / Math.PI + 360) % 360;
      const px = COMPASS_W / 2 - (deg + 360) * PX_PER_DEG;
      this.compassEl.style.transform = `translateX(${px.toFixed(1)}px)`;
    }

    // ---- match state ----
    if (this.match) {
      if (this.match.aliveCount !== this.lastAlive) {
        this.lastAlive = this.match.aliveCount;
        this.aliveEl.textContent = String(this.match.aliveCount);
      }
      if (this.match.kills !== this.lastKills) {
        this.lastKills = this.match.kills;
        this.killsEl.textContent = String(this.match.kills);
      }

      const z = this.match.zone;
      let zt: string;
      let zc = 'var(--ink)';
      if (z.finished) {
        zt = STR.zoneFinal;
        zc = PAL.zone;
      } else if (z.isShrinking) {
        zt = STR.zoneClosing;
        zc = PAL.zone;
      } else {
        const cd = Math.ceil(z.countdown);
        zt = STR.zoneTimer(Math.floor(cd / 60), cd % 60);
      }
      if (zt !== this.lastZone) {
        this.lastZone = zt;
        this.zoneEl.textContent = zt;
        this.zoneEl.style.color = zc;
      }
      if (z.phaseIndex !== this.lastPhase) {
        this.lastPhase = z.phaseIndex;
        this.phaseEl.textContent = STR.phase(z.phaseIndex + 1);
        this.phaseMax = 1;
      }
      if (z.countdown > this.phaseMax) this.phaseMax = z.countdown;
      const prog = z.isShrinking || z.finished ? 1 : 1 - z.countdown / this.phaseMax;
      this.dockBar.style.width = `${(prog * 100).toFixed(1)}%`;

      if (this.player && !this.demoMode) {
        this.updateZoneSegment(z.center.x, z.center.z, z.radius);
        {
          const d = Math.hypot(
            this.player.position.x - z.center.x,
            this.player.position.z - z.center.z
          );
          const out = d - z.radius;
          const outside = out > 0 && !this.health.dead;
          if (outside !== this.lastWarn) {
            this.lastWarn = outside;
            this.zoneWarn.classList.toggle('on', outside);
            if (!outside) this.zoneVin.style.opacity = '0';
          }
          if (outside) {
            this.zoneWarnHead.textContent = z.isShrinking ? STR.zoneShrinking : STR.zoneOutside;
            // Screen-space wash only: alpha pulses, geometry never appears.
            this.zonePulse += dt * 5;
            const depth = Math.min(1, out / 90);
            const pulse = 0.55 + 0.28 * Math.sin(this.zonePulse);
            this.zoneVin.style.opacity = ((0.45 + 0.55 * depth) * pulse).toFixed(3);
          }
        }
      }

      if (!this.demoMode) {
        const item = this.match.lootInReach();
        const label = item
          ? item.type === 'ammo'
            ? STR.itemAmmo
            : item.type === 'medkit'
              ? STR.itemMedkit
              : STR.itemBandage
          : '';
        const ptxt = item && this.match.state === 'playing' ? label : '';
        if (ptxt !== this.lastPrompt) {
          this.lastPrompt = ptxt;
          if (ptxt) {
            this.setPrompt(ptxt, item!.type === 'ammo');
          } else {
            this.promptEl.style.display = 'none';
          }
        }
      }
    }

    // ---- kill feed ageing ----
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const f = this.feed[i];
      f.t -= dt;
      if (f.t <= 0.55 && !f.out) {
        f.out = true;
        f.el.classList.add('gone');
      }
      if (f.t <= 0) {
        f.el.remove();
        this.feed.splice(i, 1);
      }
    }
  }

  /** 24px item icon, then the keycap chip, then the verb. One fixed stack. */
  private setPrompt(label: string, isAmmo: boolean): void {
    const ico = isAmmo ? ammoGlyph(24) : healGlyph(24);
    this.promptEl.innerHTML =
      `<span class="ico">${ico}</span><b>F</b><span>${STR.pickUp(label)}</span>`;
    this.promptEl.style.display = 'flex';
  }

  /**
   * Tints the span of the compass ribbon the safe area occupies.
   *
   * This is where zone DIRECTION belongs. Cycle 3 painted it as a screen-space
   * arc floating over the skyline at an arbitrary angle, which reads as a decal
   * pasted on the frame; a bearing range is a compass fact and the compass is
   * the instrument that already answers "which way".
   */
  private updateZoneSegment(cx: number, cz: number, r: number): void {
    const p = this.player!;
    const dx = cx - p.position.x;
    const dz = cz - p.position.z;
    const d = Math.hypot(dx, dz);
    // Comfortably inside: no direction to give, so give none.
    if (r <= 0 || d < r * 0.45) {
      if (this.lastSeg !== 'off') {
        this.lastSeg = 'off';
        for (const s of this.zoneSegs) s.style.display = 'none';
      }
      return;
    }
    // North is -Z in this world, and the ribbon runs +deg clockwise from it.
    const bearing = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
    const half = d >= r ? (Math.asin(Math.min(1, r / d)) * 180) / Math.PI : 90;
    this.paintZoneSegment(bearing, half);
  }

  private paintZoneSegment(bearing: number, halfDeg: number): void {
    const left = Math.round((bearing - halfDeg + 360) * PX_PER_DEG);
    const width = Math.round(halfDeg * 2 * PX_PER_DEG);
    const key = `${left}:${width}`;
    if (key === this.lastSeg) return;
    this.lastSeg = key;
    for (let i = 0; i < this.zoneSegs.length; i++) {
      const s = this.zoneSegs[i];
      s.style.display = 'block';
      s.style.left = `${left + (i - 1) * 360 * PX_PER_DEG}px`;
      s.style.width = `${width}px`;
    }
  }

  /**
   * Reticle gap = the projected radius of the weapon's spread cone. Mirrors
   * Weapon.fireOnce's spread formula from public player state (the weapon's
   * bloom counter is private), so the crosshair opens on fire, sprint and
   * unscoped movement and closes when aimed.
   */
  private updateSpread(): void {
    const p = this.player;
    const moveFactor = p ? Math.min(p.speed2D / 6.4, 1) : 0;
    const hipPenalty = p?.ads ? 0 : 1.6;
    const spreadDeg =
      0.06 + this.bloom * 0.5 + moveFactor * 0.5 + hipPenalty * (0.5 + this.bloom * 0.4);
    const gap = Math.max(5, Math.min(40,
      Math.tan((spreadDeg * Math.PI) / 180) * window.innerHeight / 2));
    this.reticle.setGap(gap);
  }

  /**
   * Wraps whatever damage callback main.ts installed so the wedge gets the
   * shooter direction without changing that wiring. Runs on the first frame,
   * i.e. after main.ts has finished assigning its handlers.
   */
  private hookHealth(): void {
    const prev = this.health.onDamage;
    this.health.onDamage = (amount: number, dx: number, dz: number) => {
      this.pendingDir = { dx, dz };
      if (prev) prev(amount, dx, dz);
      else this.showDamage(amount, dx, dz);
      this.pendingDir = null;
    };
  }

  /** Freezes one frame of every transient element (review captures only). */
  private demo(): void {
    this.demoMode = true;
    this.addFeedLine('You headshot Bot_4');
    this.addFeedLine('You killed Bot_11');
    this.addFeedLine('Bot_7 died to the blue zone');
    this.reticle.showHit('kill');
    this.reticle.freeze();
    // Two bearings well apart, at different magnitudes, so a capture shows the
    // width-by-damage behaviour rather than two identical slivers.
    this.showDamage(52, 0.5, 0.86);
    this.showDamage(13, -0.94, -0.34);
    this.arcs.freeze();
    this.dmgT = 60;
    this.zoneWarn.classList.add('on');
    this.zoneWarnHead.textContent = STR.zoneShrinking;
    this.zoneVin.style.opacity = '0.62';
    this.lastWarn = true;
    // A held frame with the player near spawn would show no zone bearing at
    // all; the capture has to show what the ribbon does when it matters.
    this.paintZoneSegment(28, 34);
    this.setPrompt(STR.itemMedkit, false);
    this.lastPrompt = 'demo';
    this.health.hp = 23;
    this.weapon.reserve = 90;
    this.boost = 46;
    this.lastHealHp = 23;
    this.reloadEl.classList.add('on');
    this.reloadBar.style.width = '62%';
    // '' matches what update() computes for an idle weapon, so the injected
    // reload row survives the next frame instead of being cleared.
    this.lastReload = '';
  }
}
