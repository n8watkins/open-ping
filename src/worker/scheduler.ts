import type { Env } from "./types";
import { listMonitors, type MonitorRecord } from "./db/monitors";
import { isActiveAt } from "./lib/schedule";
import { runMonitorCheck } from "./checks/runner";
import { applyCheckResult, setScheduledOff, setMaintenanceState, markHeartbeatMissed } from "./checks/state";
import { activeWindowsAt } from "./db/maintenance";
import { rollupAndCompact } from "./history/rollups";
import { processOutbox } from "./notifications/dispatcher";
import { sendWeeklySummary } from "./notifications/weekly";
import {
  acquireLease,
  releaseLease,
  recordRunStart,
  recordRunFinish,
} from "./lib/lease";

const LEASE_NAME = "scheduler";
const LEASE_TTL_MS = 5 * 60 * 1000; // shorter than the 12-min cadence
const CONCURRENCY = 6;

interface StateRow {
  monitor_id: string;
  state: string;
  next_check_at: number | null;
  last_success_at: number | null;
}

/** Run async work over items with a bounded concurrency limit. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * Every-12-minute check cycle (PRD §9). Acquires an execution lease, evaluates
 * each enabled monitor against its schedule, runs due HTTP checks concurrently
 * (with warm-up + retries via the runner), detects missed heartbeats, and
 * records run diagnostics. Incident lifecycle + history rollups arrive in Phase 3.
 */
export async function runScheduled(controller: ScheduledController, env: Env): Promise<void> {
  const lease = await acquireLease(env, LEASE_NAME, LEASE_TTL_MS);
  if (!lease) {
    console.log("[scheduler] another run holds the lease; skipping");
    return;
  }

  const run = await recordRunStart(env, controller.cron ?? null);
  let checked = 0;
  let skipped = 0;
  let failures = 0;

  try {
    const monitors = await listMonitors(env);
    const now = Date.now();

    const stateRes = await env.DB.prepare(
      "SELECT monitor_id, state, next_check_at, last_success_at FROM monitor_state",
    ).all<StateRow>();
    const states = new Map<string, StateRow>(
      (stateRes.results ?? []).map((s) => [s.monitor_id, s]),
    );

    // Active maintenance windows (loaded once; checked in-memory per monitor).
    const windows = await activeWindowsAt(env, now);
    const globalMaintenance = windows.some((w) => w.scope === "global");
    const maintenanceMonitorIds = new Set(
      windows.filter((w) => w.scope === "monitors").flatMap((w) => w.monitorIds ?? []),
    );

    const dueHttp: MonitorRecord[] = [];

    for (const m of monitors) {
      if (!m.enabled || m.paused) {
        skipped++;
        continue;
      }
      if (globalMaintenance || maintenanceMonitorIds.has(m.id)) {
        await setMaintenanceState(env, m, now);
        skipped++;
        continue;
      }
      if (!isActiveAt(m.schedule, new Date(now))) {
        await setScheduledOff(env, m, now);
        skipped++;
        continue;
      }

      const st = states.get(m.id);

      if (m.type === "heartbeat") {
        const deadline =
          (st?.last_success_at ?? 0) +
          (m.intervalSeconds + (m.graceSeconds ?? 0)) * 1000;
        const overdue = now > (st?.next_check_at ?? 0) && now > deadline;
        if (overdue && st?.state !== "down") {
          try {
            await markHeartbeatMissed(env, m, now);
            checked++;
            failures++;
          } catch (e) {
            failures++;
            console.error(`[scheduler] heartbeat ${m.id} failed`, e);
          }
        } else {
          skipped++;
        }
        continue;
      }

      // HTTP monitor: run only if due.
      if ((st?.next_check_at ?? 0) > now) {
        skipped++;
        continue;
      }
      dueHttp.push(m);
    }

    await mapLimit(dueHttp, CONCURRENCY, async (m) => {
      const st = states.get(m.id);
      const warmup =
        !st ||
        st.state === "scheduled_off" ||
        st.state === "unknown" ||
        st.state === "warming_up";
      try {
        const outcome = await runMonitorCheck(m, { warmup, now: Date.now() });
        await applyCheckResult(env, m, outcome);
        checked++;
        if (!outcome.ok) failures++;
      } catch (e) {
        failures++;
        console.error(`[scheduler] check ${m.id} failed`, e);
      }
    });

    // Flush queued notifications (independent; never fails the run).
    let notificationFailures = 0;
    try {
      const r = await processOutbox(env, Date.now());
      notificationFailures = r.failed;
    } catch (e) {
      console.error("[scheduler] notification dispatch failed", e);
    }

    // Compaction/retention runs after checks and must never fail the run.
    try {
      await rollupAndCompact(env, now);
    } catch (e) {
      console.error("[scheduler] compaction failed", e);
    }

    // Weekly summary (self-guards on enabled/recipient/due).
    try {
      await sendWeeklySummary(env, Date.now());
    } catch (e) {
      console.error("[scheduler] weekly summary failed", e);
    }

    await recordRunFinish(env, run.id, run.startedAt, {
      ok: true,
      monitorsChecked: checked,
      monitorsSkipped: skipped,
      checkFailures: failures,
      notificationFailures,
    });
    console.log(
      `[scheduler] cron=${controller.cron} checked=${checked} skipped=${skipped} failures=${failures}`,
    );
  } catch (err) {
    console.error("[scheduler] run failed", err);
    await recordRunFinish(env, run.id, run.startedAt, {
      ok: false,
      monitorsChecked: checked,
      monitorsSkipped: skipped,
      checkFailures: failures,
      notificationFailures: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await releaseLease(env, LEASE_NAME, lease);
  }
}
