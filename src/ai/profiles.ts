import { hash2 } from '../gen/noise';

// Skill tiers.
//
// A tier is NOT an accuracy slider. Every number below changes something you
// can watch happen: how long a bot takes to react, how fast its cone settles,
// how long its bursts are, whether it leads a strafing target or shoots where
// the target used to be, whether it reloads in the open or behind a wall,
// whether it breaks contact when hurt, and how early it starts walking to the
// next circle.
//
// Per-round DAMAGE is deliberately identical across tiers. A bot that hits
// harder is not a better bot, it is a bigger number, and it makes losing feel
// arbitrary instead of losable.

export type SkillTier = 'recruit' | 'regular' | 'veteran' | 'elite';

export interface BotProfile {
  tier: SkillTier;
  /** 0..3, higher is better. Used by the harness to order tiers. */
  rank: number;

  // --- reaction and aim ---
  /** Seconds of continuous sight before this bot will fire at all. */
  reactionS: number;
  /** Base aim cone in radians at point blank. */
  aimErrBase: number;
  /** Extra cone per metre of range. */
  aimErrPerM: number;
  /** Seconds for the cone to shrink from settleMult x base down to base. */
  settleS: number;
  settleMult: number;
  /** Cone multiplier while the bot itself is moving. */
  moveErrMult: number;
  /** 0..1 fraction of target velocity led. 0 = shoots where they were. */
  leadFactor: number;
  /** 0..1 how much bullet drop is compensated at range. */
  dropComp: number;
  /** Extra cone multiplier while under fire; resistance shrinks it. */
  suppressionResist: number;

  // --- trigger control ---
  burstMin: number;
  burstMax: number;
  shotInterval: number;
  burstPauseMin: number;
  burstPauseMax: number;
  /** Will not open fire past this range. */
  maxEngageRange: number;

  // --- magazine ---
  magSize: number;
  reloadTime: number;
  /** Reload when the magazine drops below this fraction (0 = only when dry). */
  reloadAt: number;
  /** Veterans break LOS before reloading; recruits reload in the open. */
  reloadNeedsCover: boolean;

  // --- tactics ---
  usesCover: boolean;
  /** 0..1 preference for fighting from cover rather than in the open. */
  coverBias: number;
  /** Seconds held behind cover between peeks. */
  peekHold: number;
  /** Seconds spent exposed while peeking. */
  peekOut: number;
  /** 0..1 push (close the distance) versus hold the angle. */
  pushBias: number;
  /** 0..1 strafe quality while exposed. */
  strafeSkill: number;

  // --- survival ---
  /** HP fraction below which the bot breaks contact. */
  retreatHp: number;
  /** HP fraction below which it will spend a heal when safe. */
  healHp: number;
  usesHeals: boolean;

  // --- senses ---
  /**
   * How far this bot can see at all. Kept close to maxEngageRange on purpose:
   * spotting somebody 80 m beyond the range you are willing to shoot at costs
   * a long line-of-sight ray (the most expensive call in the AI) and buys
   * nothing.
   */
  viewRange: number;
  /**
   * Attention cone in degrees. Higher tiers are WIDER, not narrower: skill in
   * an FPS is situational awareness, and a tunnel-visioned recruit missing
   * somebody standing at fifty degrees is the readable version of that.
   * Anything inside 14 m is noticed regardless — that is hearing, not sight.
   */
  fovDeg: number;
  hearingRange: number;
  /** Seconds a lost target stays "pre-aimed" (fast re-acquire). */
  memoryS: number;

  // --- macro ---
  /** Starts moving to the next circle this many seconds before it closes. */
  zoneLeadS: number;
  /** 0..1 appetite for detouring to loot. */
  lootDrive: number;
}

const RECRUIT: BotProfile = {
  tier: 'recruit',
  rank: 0,
  reactionS: 0.95,
  aimErrBase: 0.055,
  aimErrPerM: 0.00075,
  settleS: 2.6,
  settleMult: 3.4,
  moveErrMult: 2.2,
  leadFactor: 0.0,
  dropComp: 0.0,
  suppressionResist: 0.2,
  burstMin: 5,
  burstMax: 10,
  shotInterval: 0.1,
  burstPauseMin: 0.3,
  burstPauseMax: 0.75,
  maxEngageRange: 105,
  magSize: 30,
  reloadTime: 3.1,
  reloadAt: 0.07, // two rounds left. Effectively "when it goes click".
  reloadNeedsCover: false,
  usesCover: false,
  coverBias: 0.05,
  peekHold: 0.5,
  peekOut: 2.0,
  pushBias: 0.75,
  strafeSkill: 0.25,
  retreatHp: 0.12,
  healHp: 0.3,
  usesHeals: false,
  viewRange: 130,
  fovDeg: 110,
  hearingRange: 150,
  memoryS: 1.5,
  zoneLeadS: 4,
  lootDrive: 0.35,
};

const REGULAR: BotProfile = {
  tier: 'regular',
  rank: 1,
  reactionS: 0.62,
  aimErrBase: 0.033,
  aimErrPerM: 0.00048,
  settleS: 1.8,
  settleMult: 2.6,
  moveErrMult: 1.7,
  leadFactor: 0.35,
  dropComp: 0.3,
  suppressionResist: 0.45,
  burstMin: 3,
  burstMax: 6,
  shotInterval: 0.1,
  burstPauseMin: 0.45,
  burstPauseMax: 1.0,
  maxEngageRange: 150,
  magSize: 30,
  reloadTime: 2.7,
  reloadAt: 0.12,
  reloadNeedsCover: false,
  usesCover: true,
  coverBias: 0.45,
  peekHold: 1.0,
  peekOut: 1.6,
  pushBias: 0.5,
  strafeSkill: 0.55,
  retreatHp: 0.28,
  healHp: 0.5,
  usesHeals: true,
  viewRange: 175,
  fovDeg: 120,
  hearingRange: 190,
  memoryS: 3.0,
  zoneLeadS: 14,
  lootDrive: 0.6,
};

const VETERAN: BotProfile = {
  tier: 'veteran',
  rank: 2,
  reactionS: 0.42,
  aimErrBase: 0.021,
  aimErrPerM: 0.0003,
  settleS: 1.1,
  settleMult: 2.0,
  moveErrMult: 1.35,
  leadFactor: 0.72,
  dropComp: 0.7,
  suppressionResist: 0.68,
  burstMin: 2,
  burstMax: 4,
  shotInterval: 0.1,
  burstPauseMin: 0.5,
  burstPauseMax: 0.95,
  maxEngageRange: 190,
  magSize: 30,
  reloadTime: 2.35,
  reloadAt: 0.33,
  reloadNeedsCover: true,
  usesCover: true,
  coverBias: 0.82,
  peekHold: 1.5,
  peekOut: 1.3,
  pushBias: 0.34,
  strafeSkill: 0.75,
  retreatHp: 0.4,
  healHp: 0.65,
  usesHeals: true,
  viewRange: 215,
  fovDeg: 130,
  hearingRange: 225,
  memoryS: 5.0,
  zoneLeadS: 30,
  lootDrive: 0.75,
};

const ELITE: BotProfile = {
  tier: 'elite',
  rank: 3,
  reactionS: 0.26,
  aimErrBase: 0.0135,
  aimErrPerM: 0.0002,
  settleS: 0.7,
  settleMult: 1.6,
  moveErrMult: 1.2,
  leadFactor: 0.95,
  dropComp: 1.0,
  suppressionResist: 0.85,
  burstMin: 2,
  burstMax: 3,
  shotInterval: 0.095,
  burstPauseMin: 0.4,
  burstPauseMax: 0.8,
  maxEngageRange: 235,
  magSize: 30,
  reloadTime: 2.1,
  reloadAt: 0.45,
  reloadNeedsCover: true,
  usesCover: true,
  coverBias: 0.95,
  peekHold: 1.2,
  peekOut: 1.15,
  pushBias: 0.55,
  strafeSkill: 0.9,
  retreatHp: 0.48,
  healHp: 0.78,
  usesHeals: true,
  viewRange: 250,
  fovDeg: 140,
  hearingRange: 260,
  memoryS: 7.0,
  zoneLeadS: 45,
  lootDrive: 0.85,
};

export const PROFILES: Record<SkillTier, BotProfile> = {
  recruit: RECRUIT,
  regular: REGULAR,
  veteran: VETERAN,
  elite: ELITE,
};

export const TIER_ORDER: SkillTier[] = ['recruit', 'regular', 'veteran', 'elite'];

/**
 * Deterministic tier roll. Weighted so a lobby is mostly ordinary people:
 * 30% recruit, 42% regular, 21% veteran, 7% elite. Meeting an elite should be
 * an event, not the baseline.
 */
export function tierForBot(botId: number): SkillTier {
  const r = hash2(botId + 1, 1337);
  if (r < 0.3) return 'recruit';
  if (r < 0.72) return 'regular';
  if (r < 0.93) return 'veteran';
  return 'elite';
}

export function profileForBot(botId: number): BotProfile {
  return PROFILES[tierForBot(botId)];
}
