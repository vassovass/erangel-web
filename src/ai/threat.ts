import type { AiContext, Combatant } from './types';
import type { BotProfile } from './profiles';
import type { Perception } from './perception';

// Who to fight.
//
// The old AI had no answer to this question because there was only ever one
// candidate. Now every bot ranks everything it knows about — other bots and the
// player alike — on distance, whether it can see them, who has been hurting it,
// and who looks finishable. The player gets NO bonus: being shot at by a bot
// should be a consequence of being seen, not of being the protagonist.

export interface ThreatChoice {
  target: Combatant | null;
  score: number;
  /** True when the choice is backed by current sight rather than memory. */
  visible: boolean;
}

const ENGAGE_FLOOR = 0;
/** Sticky bonus for the target already being fought — stops target ping-pong. */
const INCUMBENT_BONUS = 90;

export function selectTarget(
  self: Combatant,
  perception: Perception,
  profile: BotProfile,
  ctx: AiContext,
  currentCid: number
): ThreatChoice {
  let best: Combatant | null = null;
  let bestScore = -Infinity;
  let bestVisible = false;
  const t = ctx.time;

  for (const c of ctx.combatants) {
    if (c.cid === self.cid || !c.alive || !c.simEnabled) continue;
    const mem = perception.get(c.cid);
    if (!mem) continue;

    const sinceSeen = t - mem.lastSeenT;
    const sinceHeard = t - mem.heardT;
    const sinceHurt = t - mem.damageT;
    // Nothing at all recent: not a threat, not a target.
    //
    // This retention window is deliberately LONGER than profile.memoryS. That
    // number governs pre-aim — how long a bot stays sharp on a target it just
    // lost — and using it here as well made a recruit forget an enemy 1.5 s
    // after losing sight, drop the contact entirely, and stroll away mid
    // firefight. Remembering that somebody is out there is not a skill.
    const retention = Math.max(9, profile.memoryS * 1.6);
    if (sinceSeen > retention && sinceHeard > 9 && sinceHurt > 9) continue;

    const dist = Math.hypot(c.pos.x - self.pos.x, c.pos.z - self.pos.z);
    if (dist > profile.viewRange * 1.2) continue;

    let score = 120 - dist * 0.35;
    if (mem.visible) score += 150;
    else score -= Math.min(120, sinceSeen * 18);
    // Whoever is actually shooting me outranks whoever is merely nearer.
    score += Math.min(160, mem.damage * 2.2);
    if (sinceHurt < 3) score += 90;
    if (sinceHeard < 2.5) score += 40;
    // Finish the wounded — skill decides how much of an opportunist a bot is.
    if (mem.visible && c.hp < 45) score += 40 * (0.4 + profile.pushBias);
    // Out of practical reach: worth tracking, not worth committing to.
    if (dist > profile.maxEngageRange) score -= 70;
    if (c.cid === currentCid) score += INCUMBENT_BONUS;

    if (score > bestScore) {
      bestScore = score;
      best = c;
      bestVisible = mem.visible;
    }
  }

  if (!best || bestScore < ENGAGE_FLOOR) return { target: null, score: 0, visible: false };
  return { target: best, score: bestScore, visible: bestVisible };
}
