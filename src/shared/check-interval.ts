/**
 * Per-monitor check intervals on OpenPing Hosted (docs/hosted/CONTRACT.md,
 * section 5). Pure, so the server and the app agree on every number.
 *
 * A polled monitor (http, dns, tcp, domain) keeps the interval its owner chose,
 * and the plan sets the shortest one allowed (`PlanLimits.minIntervalMinutes`).
 * The scheduler never checks faster than the plan's current minimum, so after
 * a downgrade a 1-minute monitor runs at the plan's fastest and keeps its
 * setting for when the plan allows it again. A plain install has no plan and
 * checks every polled monitor on each 12-minute cron run, as it always has.
 */

import { POLLED_INTERVAL_SECONDS } from "./schemas";

/** The intervals the editor offers, in minutes. Any whole minute from 1 to 1,440 is valid. */
export const CHECK_INTERVAL_CHOICES_MINUTES = [1, 2, 5, 12, 30, 60] as const;

/** The interval a new polled monitor gets when none is given: 12 minutes, or the plan's shortest if longer. */
export function defaultIntervalSeconds(minIntervalMinutes: number): number {
  return Math.max(POLLED_INTERVAL_SECONDS, planMinimumSeconds(minIntervalMinutes));
}

/** The plan's shortest interval in seconds (whole minutes, at least one). */
export function planMinimumSeconds(minIntervalMinutes: number): number {
  return Number.isFinite(minIntervalMinutes) ? Math.max(1, Math.ceil(minIntervalMinutes)) * 60 : POLLED_INTERVAL_SECONDS;
}

/** How often a monitor set to `storedSeconds` is really checked on a plan whose shortest is `minIntervalMinutes`. */
export function effectiveIntervalSeconds(storedSeconds: number, minIntervalMinutes: number): number {
  const stored = Number.isFinite(storedSeconds) && storedSeconds > 0 ? storedSeconds : POLLED_INTERVAL_SECONDS;
  return Math.max(stored, planMinimumSeconds(minIntervalMinutes));
}

/** "1 minute", "12 minutes", "1 hour", for a whole number of minutes. */
export function intervalLabel(minutes: number): string {
  if (minutes % 60 === 0 && minutes >= 60) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
