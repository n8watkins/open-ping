/**
 * The pull-to-refresh gesture, as plain numbers so it can be tested.
 *
 * A pull starts only with one finger, at the very top of the page, moving
 * down more than sideways; it then follows the finger with resistance and
 * refreshes when let go past the threshold.
 */

/** Fired on window after a pull refreshed a page, so the shell refreshes too. */
export const PAGE_REFRESHED_EVENT = "openping:page-refreshed";

/** How far (px, after resistance) the indicator travels before a release refreshes. */
export const PULL_THRESHOLD = 64;
/** The furthest the indicator travels. */
export const PULL_MAX = 96;
/** Finger travel (px) before we decide whether this is a pull or a scroll. */
export const PULL_SLOP = 8;

/** The indicator's travel for a finger that moved `dy` px down. */
export function pullDistance(dy: number): number {
  if (dy <= 0) return 0;
  // Eases off toward the cap like a rubber band: the threshold is about 130 px
  // of finger travel, so a scroll that overshoots the top never refreshes.
  const eased = PULL_MAX * (1 - Math.exp(-dy / 120));
  return Math.min(PULL_MAX, Math.round(eased * 10) / 10);
}

export type PullDecision = "undecided" | "pull" | "ignore";

/**
 * After the finger moved (dx, dy) from where it went down: a pull, not a pull
 * (a scroll up, or a sideways swipe on a chart or table), or too early to say.
 */
export function decidePull(dx: number, dy: number): PullDecision {
  if (Math.abs(dx) < PULL_SLOP && Math.abs(dy) < PULL_SLOP) return "undecided";
  if (dy <= 0) return "ignore";
  return Math.abs(dy) > Math.abs(dx) ? "pull" : "ignore";
}

/** Whether letting go at this distance refreshes. */
export function shouldRefresh(distance: number): boolean {
  return distance >= PULL_THRESHOLD;
}
