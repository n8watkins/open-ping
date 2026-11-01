import type { Env } from "../types";
import { listIntervalCandidates } from "../db/monitors";
import { isFastMonitor, type FastCandidate, type IntervalReason } from "../../shared/check-interval";
import { CRON_CADENCE, effectiveIntervals, planCadence, type Cadence } from "./cadence";
import type { HostedPlan } from "./plan-limits";

/**
 * How often each monitor is really checked, as the API, the CLI and MCP show
 * it: from effectiveIntervals, the same rule the scheduler checks them by
 * (lib/cadence.ts), so a monitor kept from a bigger plan, one over the plan's
 * fast monitors, or one with another interval on an install of your own says
 * so instead of showing a speed it never runs at.
 */

/** Added to every monitor the API returns. */
export interface IntervalFields {
  /** How often it is really checked, in seconds; a heartbeat's is its own interval. */
  effectiveIntervalSeconds: number;
  /** Why that differs from `intervalSeconds`, or "set" when it doesn't (shared/check-interval.ts). */
  intervalReason: IntervalReason;
}

/** How this install is scheduled: the tenant's plan on Hosted (as the platform's calls run), the 12-minute cron otherwise. */
export function cadenceFor(plan: HostedPlan | undefined): Cadence {
  return plan ? planCadence(plan.limits) : CRON_CADENCE;
}

/** `list` with each monitor's real interval, judged among `all` (every monitor; `list` when it is all of them). */
export function withIntervals<T extends FastCandidate>(
  list: readonly T[],
  cadence: Cadence,
  all: readonly FastCandidate[] = list,
): (T & IntervalFields)[] {
  const effective = effectiveIntervals(all, cadence);
  return list.map((m) => {
    const e = effective.get(m.id) ?? effectiveIntervals([m], cadence).get(m.id)!;
    return { ...m, effectiveIntervalSeconds: e.seconds, intervalReason: e.reason };
  });
}

/**
 * One monitor with its real interval. Reads the other monitors only when the
 * answer depends on them: a fast monitor on a plan that caps fast monitors.
 */
export async function withInterval<T extends FastCandidate>(
  env: Env,
  plan: HostedPlan | undefined,
  monitor: T,
): Promise<T & IntervalFields> {
  const cadence = cadenceFor(plan);
  const needsOthers = cadence.fastMonitors !== null && isFastMonitor(monitor);
  const all = needsOthers ? await listIntervalCandidates(env) : [monitor];
  return withIntervals([monitor], cadence, all)[0]!;
}
