// Building footprints for the minimap.
//
// The minimap is constructed as `new Minimap(hf)` in main.ts and that wiring is
// fixed, so the settlement list cannot be handed to it directly. The Hud does
// receive the Match, and Match owns the PhysicsWorld that every building
// registers its AABBs with (tag 'building'), so the Hud harvests the footprints
// on construction and parks them here for the Minimap — which is built a few
// lines later — to read.
//
// Filtering: each building contributes one full-extent roof collider plus a
// handful of thin wall boxes, and props (fences, poles, crates, haystacks) use
// the same tag. Keeping only boxes with both horizontal dimensions >= MIN_SIDE
// and a plausible building area leaves exactly the building shells.

const MIN_SIDE = 2.5;
const MIN_AREA = 18;
const MAX_AREA = 600;

export interface Footprint {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export const worldInfo: { footprints: Footprint[] } = { footprints: [] };

interface BoxLike {
  min: { x: number; z: number };
  max: { x: number; z: number };
  tag: string;
}

/** Best-effort: silently yields nothing if the shape is not what we expect. */
export function collectFootprints(matchLike: unknown): void {
  const physics = (matchLike as { physics?: { boxes?: unknown } } | null)?.physics;
  const boxes = physics?.boxes;
  if (!Array.isArray(boxes)) return;
  const out: Footprint[] = [];
  for (const raw of boxes as BoxLike[]) {
    if (!raw || raw.tag !== 'building' || !raw.min || !raw.max) continue;
    const w = raw.max.x - raw.min.x;
    const d = raw.max.z - raw.min.z;
    if (w < MIN_SIDE || d < MIN_SIDE) continue;
    const area = w * d;
    if (area < MIN_AREA || area > MAX_AREA) continue;
    out.push({ x0: raw.min.x, z0: raw.min.z, x1: raw.max.x, z1: raw.max.z });
  }
  worldInfo.footprints = out;
}
