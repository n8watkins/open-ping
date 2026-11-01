/**
 * Per-monitor check intervals on OpenPing Hosted (docs/hosted/CONTRACT.md,
 * section 5). Pure, so the server and the app agree on every number.
 *
 * A polled monitor (http, dns, tcp, domain) keeps the interval its owner chose,
 * and the plan sets the shortest one allowed (`PlanLimits.minIntervalMinutes`).
 * The scheduler never checks faster than the plan's current minimum, so after
 * a downgrade a 1-minute monitor runs at the plan's fastest and keeps its
 * setting for when the plan allows it again. The plan also caps how many
 * monitors may be fast (`PlanLimits.fastMonitors`); when more are set fast
 * than that (after a downgrade), the oldest active ones keep their speed and the rest are
 * checked every 12 minutes (keptFastMonitorIds). A plain install has no plan and
 * checks every polled monitor on each 12-minute cron run, as it always has.
 */

import { isFastInterval } from "./hosted-contract";
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

/** The fields keptFastMonitorIds reads. */
export interface FastCandidate {
  id: string;
  type: string;
  intervalSeconds: number;
  createdAt: number;
  /** A paused or disabled monitor isn't checked, so it keeps its speed only after the active ones. */
  paused?: boolean;
  enabled?: boolean;
}

/** Is this a fast monitor: polled, and set to check more often than every 12 minutes? Paused ones count. */
export function isFastMonitor(m: Pick<FastCandidate, "type" | "intervalSeconds">): boolean {
  return m.type !== "heartbeat" && isFastInterval(m.intervalSeconds);
}

/**
 * Which fast monitors are checked at their own interval when the plan allows
 * `allowance` of them: all of them while they fit; otherwise active monitors
 * before paused or disabled ones (which aren't checked anyway), then the
 * oldest (created first, then by id), so the choice never changes between
 * runs; the others are checked every 12 minutes until one is slowed, removed
 * or the plan allows more. Nothing is changed in the database.
 */
export function keptFastMonitorIds(monitors: readonly FastCandidate[], allowance: number): Set<string> {
  const fast = monitors.filter(isFastMonitor);
  if (fast.length <= allowance) return new Set(fast.map((m) => m.id));
  const idle = (m: FastCandidate) => (m.paused === true || m.enabled === false ? 1 : 0);
  const oldest = [...fast].sort(
    (a, b) => idle(a) - idle(b) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return new Set(oldest.slice(0, Math.max(0, allowance)).map((m) => m.id));
}

/** "1 minute", "12 minutes", "1 hour", for a whole number of minutes. */
export function intervalLabel(minutes: number): string {
  if (minutes % 60 === 0 && minutes >= 60) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** "every minute", "every 12 minutes", "every hour". */
export function everyLabel(minutes: number): string {
  if (minutes === 1) return "every minute";
  if (minutes === 60) return "every hour";
  return `every ${intervalLabel(minutes)}`;
}

/**
 * Why a monitor is checked at the speed it is (effectiveIntervals in
 * src/worker/lib/cadence.ts, the scheduler's own rule), in every monitor the
 * API returns as `intervalReason` beside `effectiveIntervalSeconds`:
 *
 * - "set": at its own interval (a heartbeat always is).
 * - "plan_minimum": slower, at the plan's shortest interval (OpenPing Hosted,
 *   after a downgrade or a monitor brought over from a bigger plan).
 * - "fast_monitor_limit": every 12 minutes, because more monitors are set
 *   fast than the plan allows and older active ones keep their speed.
 * - "install_schedule": every 12 minutes, the cron of an install of your own,
 *   whatever is stored (a database brought over from Hosted may hold another).
 */
export const INTERVAL_REASONS = ["set", "plan_minimum", "fast_monitor_limit", "install_schedule"] as const;
export type IntervalReason = (typeof INTERVAL_REASONS)[number];

/** The few words in brackets after "Checked every ...", or null when it runs as set. */
export function intervalReasonNote(reason: IntervalReason): string | null {
  switch (reason) {
    case "plan_minimum":
      return "your plan's fastest";
    case "fast_monitor_limit":
      return "over your plan's fast monitors";
    case "install_schedule":
      return "this install's schedule";
    default:
      return null;
  }
}

/** Whole minutes, at least one, for the labels. */
function minutesOf(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/**
 * How often a polled monitor is checked, for the monitor's page and the CLI:
 * "Checks every 12 minutes", or, when that differs from its setting,
 * "Checked every 12 minutes (your plan's fastest)".
 */
export function checkedEveryText(effectiveSeconds: number, reason: IntervalReason): string {
  const note = intervalReasonNote(reason);
  const every = everyLabel(minutesOf(effectiveSeconds));
  return note ? `Checked ${every} (${note})` : `Checks ${every}`;
}

/** The sentence that explains a difference, or null when the monitor runs as set. */
export function intervalReasonDetail(storedSeconds: number, effectiveSeconds: number, reason: IntervalReason): string | null {
  const set = everyLabel(minutesOf(storedSeconds));
  const actual = everyLabel(minutesOf(effectiveSeconds));
  switch (reason) {
    case "plan_minimum":
      return `Set to ${set}, but your plan's fastest is ${actual}. It goes back to ${set} once your plan allows it.`;
    case "fast_monitor_limit":
      return `Set to ${set}, but older monitors use all of your plan's fast checks, so it runs ${actual} until one of them is slowed down or removed, or your plan allows more.`;
    case "install_schedule":
      return `Set to ${set}, but this install checks every monitor on its ${minutesOf(effectiveSeconds)}-minute schedule.`;
    default:
      return null;
  }
}
