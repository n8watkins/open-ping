import type { Env } from "../types";
import type { MonitorRecord } from "../db/monitors";
import type { MonitorState } from "../../shared/states";
import { activeWindowsFromRows, listMaintenanceStatement, type MaintenanceRow } from "../db/maintenance";
import { isActiveAt } from "../lib/schedule";
import { runMonitorCheck } from "./runner";
import { applyCheckResult, setMaintenanceState, setScheduledOff } from "./state";

/**
 * A new monitor's first check, run right after it is created (REST, the web
 * editor, MCP and the CLI all create through the same path) so the dashboard
 * shows a real state within seconds instead of waiting for the next cron run,
 * up to 12 minutes away.
 *
 * It makes the same decision the scheduler would for this monitor on its next
 * tick: an active maintenance window shows Maintenance, outside its schedule
 * it shows Scheduled off, and a polled monitor (http/dns/tcp/domain) is checked
 * and the result stored. Like the scheduler's first check of any monitor it is
 * a warm-up cycle, so a failure shows Warming up and never alerts; the next
 * scheduled check is a normal one, with its confirmation re-check. A heartbeat
 * has nothing to check until its first ping arrives, and a disabled monitor is
 * left alone.
 */

export type FirstCheckResult =
  | {
      status: "checked";
      state: MonitorState;
      ok: boolean;
      durationMs?: number;
      statusCode?: number;
      error?: string;
      errorMessage?: string;
    }
  | { status: "scheduled_off" | "maintenance"; state: MonitorState }
  /** "error": the first check itself failed to run; the next cron run checks it. */
  | { status: "skipped"; reason: "heartbeat" | "disabled" | "error" }
  /** Still running when the caller stopped waiting; it finishes in the background. */
  | { status: "running" };

/** How long a create request waits for the first check before answering. */
export const FIRST_CHECK_WAIT_MS = 5_000;

export async function runFirstCheck(
  env: Env,
  monitor: MonitorRecord,
  now: number = Date.now(),
): Promise<FirstCheckResult> {
  if (!monitor.enabled || monitor.paused) return { status: "skipped", reason: "disabled" };

  const maintenanceRows = await listMaintenanceStatement(env).all<MaintenanceRow>();
  const inMaintenance = activeWindowsFromRows(maintenanceRows.results ?? [], now).some(
    (w) => w.scope === "global" || (w.monitorIds ?? []).includes(monitor.id),
  );
  if (inMaintenance) {
    await setMaintenanceState(env, monitor, now);
    return { status: "maintenance", state: "maintenance" };
  }
  if (!isActiveAt(monitor.schedule, new Date(now))) {
    await setScheduledOff(env, monitor, now);
    return { status: "scheduled_off", state: "scheduled_off" };
  }
  if (monitor.type === "heartbeat") return { status: "skipped", reason: "heartbeat" };

  // No confirmation re-check: a warm-up failure never alerts, so there is
  // nothing to confirm, and the person who just created the monitor gets its
  // result in one check's time. The next scheduled check confirms as usual.
  const outcome = await runMonitorCheck(monitor, { warmup: true, confirm: false, now });
  await applyCheckResult(env, monitor, outcome, null);
  return {
    status: "checked",
    state: outcome.state,
    ok: outcome.ok,
    ...(outcome.durationMs != null ? { durationMs: outcome.durationMs } : {}),
    ...(outcome.statusCode != null ? { statusCode: outcome.statusCode } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
  };
}

/**
 * Start the first check and wait up to `waitMs` for it. A check that takes
 * longer keeps running through `waitUntil` (when the caller has one) and
 * reports `running`; if it is cut off, the monitor is still due and the next
 * cron run checks it. Never throws: creating the monitor already succeeded.
 */
export async function firstCheckWithin(
  env: Env,
  monitor: MonitorRecord,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  waitMs: number = FIRST_CHECK_WAIT_MS,
): Promise<FirstCheckResult> {
  const work = runFirstCheck(env, monitor).catch((e: unknown): FirstCheckResult => {
    console.error(`[first-check] ${monitor.id} failed`, e);
    return { status: "skipped", reason: "error" };
  });
  waitUntil?.(work);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<FirstCheckResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "running" }), waitMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
