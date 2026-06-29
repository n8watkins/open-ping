import type { Env } from "./types";

/**
 * Entry point for the every-12-minute Cron Trigger.
 *
 * Phase 2+ will: acquire an execution lease, load enabled monitors, determine
 * which are due (schedule + maintenance aware), run checks concurrently with a
 * safe limit, classify results, update current state, write compact history,
 * open/resolve incidents, enqueue notifications, and record diagnostics.
 *
 * Invariant: a failure in any sub-step (notifications, compaction, …) must never
 * abort the whole run or corrupt monitoring state.
 */
export async function runScheduled(controller: ScheduledController, _env: Env): Promise<void> {
  const startedAt = Date.now();
  try {
    console.log(`[scheduler] tick cron=${controller.cron} at=${new Date(startedAt).toISOString()}`);
    // TODO(phase-2): implement the check cycle.
  } catch (err) {
    console.error("[scheduler] run failed", err);
  }
}
