/**
 * How often the scheduler runs, and what that means for each monitor
 * (scheduler.ts). Pure, so every rule here is unit tested.
 *
 * A plain install runs on its 12-minute Cron Trigger and checks every polled
 * monitor on each run, exactly as it always has. On OpenPing Hosted the
 * platform's scheduler ticks every minute and calls a tenant only when it is
 * due (docs/hosted/CONTRACT.md, section 6), so each polled monitor is checked
 * on its own interval, never faster than the plan allows, and the run tells
 * the platform when it next has work (`nextDueAt`).
 */

import { POLLED_INTERVAL_SECONDS } from "../../shared/schemas";
import { effectiveIntervalSeconds } from "../../shared/check-interval";
import { SCHEDULED_MAX_GAP_MS } from "../../shared/hosted-contract";

export interface Cadence {
  /** "cron": a plain install's Cron Trigger. "platform": OpenPing Hosted's scheduler. */
  kind: "cron" | "platform";
  /** How far apart runs can be: 12 minutes on the cron, 1 minute on the platform's ticks. */
  tickMs: number;
  /** The plan's shortest check interval, in minutes (platform only). */
  minIntervalMinutes: number | null;
}

/** A plain install: the 12-minute cron (wrangler.jsonc). */
export const CRON_CADENCE: Cadence = { kind: "cron", tickMs: POLLED_INTERVAL_SECONDS * 1000, minIntervalMinutes: null };

/** The platform's scheduler ticks every minute. */
export const PLATFORM_TICK_MS = 60 * 1000;

/** OpenPing Hosted, on a plan whose shortest interval is `minIntervalMinutes` (props.tenant.limits). */
export function platformCadence(minIntervalMinutes: number): Cadence {
  return { kind: "platform", tickMs: PLATFORM_TICK_MS, minIntervalMinutes };
}

/**
 * How often a monitor is checked: its own interval on the platform, at least
 * the plan's shortest; the cron's 12 minutes on a plain install, whatever is
 * stored (a database brought over from Hosted may hold another). A heartbeat's
 * interval is how often its job pings, and never changes.
 */
export function checkIntervalSeconds(m: { type: string; intervalSeconds: number }, cadence: Cadence): number {
  if (m.type === "heartbeat") return m.intervalSeconds;
  if (cadence.kind === "cron") return POLLED_INTERVAL_SECONDS;
  return effectiveIntervalSeconds(m.intervalSeconds, cadence.minIntervalMinutes ?? 12);
}

/**
 * How early a polled monitor may be checked: half the gap between runs, and
 * never more than half its interval. On the cron that is 6 minutes, so a check
 * due just after a run happens in that run rather than 12 minutes late; on the
 * platform's minute ticks it is 30 seconds, so a monitor never runs a whole
 * tick early (a 12-minute monitor stays 12 minutes) and a call that arrives a
 * moment before a due time still checks it.
 */
export function dueSlackMs(intervalSeconds: number, cadence: Cadence): number {
  return Math.min(cadence.tickMs / 2, (intervalSeconds * 1000) / 2);
}

/**
 * The moment a run's checks are scheduled from. On the platform it is the
 * tick the call was made for (`scheduledTime`), when that is no more than one
 * tick old, so a queue that delivers the call a few seconds late never pushes
 * a monitor's next check past the next tick; otherwise, and on the cron, now.
 */
export function runBaseTime(now: number, scheduledTime: number | undefined, cadence: Cadence): number {
  if (cadence.kind !== "platform" || typeof scheduledTime !== "number" || !Number.isFinite(scheduledTime)) return now;
  const late = now - scheduledTime;
  return late >= 0 && late <= cadence.tickMs ? scheduledTime : now;
}

/**
 * How often the end-of-run upkeep (history rollups, retention, expired sign-in
 * cleanup) and the run record happen on the platform: once per 12-minute slot,
 * as on the cron, however often the tenant is called. Notifications still go
 * out on every run.
 */
export const UPKEEP_EVERY_MS = SCHEDULED_MAX_GAP_MS;

/** The start of the 12-minute upkeep slot `at` falls in. */
export function upkeepSlot(at: number): number {
  return Math.floor(at / UPKEEP_EVERY_MS) * UPKEEP_EVERY_MS;
}

/**
 * Does this run do the upkeep and keep a run record? Always on the cron. On
 * the platform, only the first run of each 12-minute slot (or any run before
 * the first recorded one), and every run that fails is recorded too.
 * `lastRecordedAt` is when the latest finished, successful recorded run started.
 */
export function isUpkeepRun(now: number, lastRecordedAt: number | null, cadence: Cadence): boolean {
  if (cadence.kind === "cron") return true;
  return lastRecordedAt === null || lastRecordedAt < upkeepSlot(now);
}

/** How long run records are kept on the platform; Diagnostics reads the latest. The cron keeps them with the daily history. */
export const PLATFORM_RUN_RECORD_DAYS = 14;

/**
 * When the tenant next has work, from what the run found: the earliest of the
 * times its monitors wake (a polled check's due time less its slack, a
 * heartbeat deadline, a schedule window opening), and never later than
 * SCHEDULED_MAX_GAP_MS after the run started. It may be in the past: a check
 * the budget deferred is due at once.
 */
export function nextDueAt(startedAt: number, wakes: readonly number[]): number {
  let next = startedAt + SCHEDULED_MAX_GAP_MS;
  for (const at of wakes) if (Number.isFinite(at) && at < next) next = at;
  return next;
}

/**
 * On the platform, where a polled monitor's next check lands: one interval
 * after `base`, moved to the nearest mark of a grid the tenant's monitors
 * share, so they line up and the tenant is called as rarely as their
 * intervals allow (a tenant of 12-minute monitors once per 12 minutes, not
 * once for each monitor's own phase). The grid is the clock's 12-minute marks
 * for intervals that are a multiple of 12 minutes (the upkeep slots, so that
 * run does both), its 6-minute marks for multiples of 6, and the minute
 * otherwise. Only the first interval after a monitor starts can be off, by
 * half a grid step at most; every one after is exact.
 */
export function alignNextCheck(base: number, intervalSeconds: number): number {
  const next = base + intervalSeconds * 1000;
  const grid = intervalSeconds % 720 === 0 ? 720_000 : intervalSeconds % 360 === 0 ? 360_000 : 60_000;
  return Math.round(next / grid) * grid;
}
