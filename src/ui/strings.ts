import { WORLD_SEED, mulberry32 } from '../gen/noise';

// EVERY human-readable string the HUD paints lives here, and nowhere else.
//
// Why a table instead of inline literals: the previous build hard-coded a
// competitor's registered map name into the tactical-map header and its
// registered victory catchphrase into the win screen. Both are the most
// screenshot-visible surfaces in the product. Routing all copy through one
// module means (a) there is exactly one place to audit, and (b) the reserved
// -name assertion below can actually see every string and fail the build's
// capture log if a banned literal ever comes back.
//
// House copy rules (cycle 4: ONE rule, applied to everything in STR).
//
// Cycle 3 ran two voices at once - tracked caps for labels (ALIVE, KILLS,
// PHASE, PLAY ZONE) and sentence case for every alert and prompt ("Blue zone
// shrinking", "Pick up first aid kit", "Press R to redeploy"). Two casings on
// one screen is a system that has not been decided, and it was visible in every
// capture. Every string here is now UPPERCASE, set at 0.08em tracking, on the
// four-step 11/15/18/26 scale. Player and bot NAMES keep their own casing
// because they are proper nouns, not chrome.

// ---------------------------------------------------------------------------
// Island name, derived from the world seed.
//
// The map is generated, so its name should be too: a fixed name would be a lie
// the moment someone passes ?seed=. Syllables are invented, deliberately not
// drawn from any existing game's toponymy, and combined deterministically so a
// given seed always prints the same name in the header, the end card and any
// future marketing still taken from a seeded capture.
// ---------------------------------------------------------------------------

const HEAD = ['KAR', 'VOS', 'MER', 'SEL', 'TAL', 'BRAN', 'ORV', 'LUN', 'DRAV', 'HES', 'ANV', 'KOL'];
const TAIL = ['NAYA', 'MORA', 'SKAR', 'VIK', 'THEN', 'DAL', 'RUNE', 'WICK', 'HOLM', 'GARD'];
const KIND = ['ISLE', 'BASIN', 'REACH', 'STRAND', 'MOOR'];

function toponym(seed: number): string {
  const r = mulberry32((seed ^ 0x5eed1a) >>> 0);
  // Three draws in a fixed order: the sequence is the seed's fingerprint.
  const h = HEAD[Math.floor(r() * HEAD.length)];
  const t = TAIL[Math.floor(r() * TAIL.length)];
  const k = KIND[Math.floor(r() * KIND.length)];
  return `${h}${t} ${k}`;
}

/** Generated island name for the active world seed, e.g. "MERTHEN REACH". */
export const MAP_NAME = toponym(WORLD_SEED);

export const STR = {
  // --- tactical map ---
  mapHeader: MAP_NAME,
  mapScale: 'TACTICAL MAP / 1200 M',
  mapPlayZone: 'PLAY ZONE',
  mapNextCircle: 'NEXT CIRCLE',
  mapClose: 'PRESS <b>M</b> TO CLOSE',
  mapGrid: 'GRID 100 M',

  // --- match chrome ---
  alive: 'ALIVE',
  kills: 'KILLS',
  phase: (n: number) => `PHASE ${n}`,
  zoneTimer: (m: number, s: number) => `ZONE ${m}:${String(s).padStart(2, '0')}`,
  zoneClosing: 'ZONE CLOSING',
  zoneFinal: 'FINAL CIRCLE',

  // --- alerts ---
  zoneShrinking: 'BLUE ZONE SHRINKING',
  zoneOutside: 'OUTSIDE THE PLAY ZONE',
  zoneMove: 'MOVE INTO THE SAFE AREA',

  // --- interaction ---
  pickUp: (item: string) => `PICK UP ${item}`,
  itemAmmo: '30 ROUNDS',
  itemMedkit: 'FIRST AID KIT',
  itemBandage: 'BANDAGE',
  reloading: 'RELOADING',

  // --- weapon readout ---
  // Spelled out, not three dots. Three dots at 12px is an ellipsis or a
  // loading state; it is not a fire-selector position.
  fireMode: 'AUTO',
  hpLabel: 'HP',

  // --- end card ---
  // Own line, own voice. Two lines so it sets as a lockup rather than a banner.
  winHeadline: 'THE ISLAND\nIS YOURS',
  winSub: 'LAST ONE STANDING',
  deadHeadline: 'YOU DIED',
  deadSub: (rank: number, of: number) => `ELIMINATED / RANK #${rank} OF ${of}`,
  statPlacement: 'PLACEMENT',
  statKills: 'KILLS',
  statPlayers: 'PLAYERS',
  // main.ts binds KeyR to reload the page once the match ends.
  redeploy: 'PRESS <b>R</b> TO REDEPLOY',
} as const;

// ---------------------------------------------------------------------------
// Settlement names for the tactical map.
//
// A BR map with no place names cannot support a callout, which is the primary
// job of the map. The names are generated the same way the island name is -
// deterministically from WORLD_SEED, from invented syllables - so a given seed
// always labels the same village with the same name, and no existing game's
// toponymy is borrowed.
// ---------------------------------------------------------------------------

const P_HEAD = [
  'STIL', 'ASH', 'KOL', 'MER', 'DUN', 'VAR', 'BRIN', 'GRAN',
  'HAL', 'OX', 'SALT', 'RED', 'THORN', 'EAST', 'LOW', 'NORTH',
  'HEATH', 'CRAG', 'WEST', 'FEL',
];
const P_TAIL = [
  'WATER', 'FORD', 'VIK', 'RIDGE', 'HOLM', 'DEN', 'HOLLOW', 'TOR',
  'MILL', 'CROSS', 'ROW', 'MARSH', 'WICK', 'QUARRY', 'FEN', 'GATE',
  'STEAD', 'HAVEN', 'BANK', 'REACH',
];

/**
 * `n` distinct settlement names for the active seed, in a stable order.
 *
 * Distinctness matters more than variety: two villages called the same thing
 * makes the map actively misleading, so collisions are rejected rather than
 * disambiguated with a numeral.
 */
export function settlementNames(n: number): string[] {
  const r = mulberry32((WORLD_SEED ^ 0x70ace1) >>> 0);
  const seen = new Set<string>();
  const out: string[] = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 40) {
    const name = `${P_HEAD[Math.floor(r() * P_HEAD.length)]}${P_TAIL[Math.floor(r() * P_TAIL.length)]}`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shipping gate.
//
// Runs once at HUD construction and walks the whole table. A console.error here
// surfaces in every capture log, so a banned literal cannot reappear silently
// through a copy-paste or a merge.
// ---------------------------------------------------------------------------

const RESERVED = /erangel|chicken\s*dinner|winner\s+winner|pubg|battlegrounds/i;

export function assertNoReservedNames(): boolean {
  const bad: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (RESERVED.test(v)) bad.push(`${path}="${v}"`);
    } else if (typeof v === 'function') {
      // Probe formatters with neutral arguments so their literal parts are seen.
      try {
        const out = (v as (...a: unknown[]) => unknown)(1, 1);
        if (typeof out === 'string' && RESERVED.test(out)) bad.push(`${path}()="${out}"`);
      } catch {
        /* a formatter that rejects probe args carries no literal we can read */
      }
    }
  };
  for (const [k, v] of Object.entries(STR)) walk(v, `STR.${k}`);
  walk(MAP_NAME, 'MAP_NAME');
  if (bad.length) {
    console.error(`[hud-strings] FAIL reserved name in HUD copy: ${bad.join(', ')}`);
    return false;
  }
  console.log(`[hud-strings] PASS ${Object.keys(STR).length} strings clean; map name "${MAP_NAME}"`);
  return true;
}
