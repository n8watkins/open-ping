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
import { cleanupExpiredSessions, cleanupExpiredAuthTokens } from "./lib/sessions";

const LEASE_NAME = "scheduler";
const LEASE_TTL_MS = 5 * 60 * 1000; // shorter than the 12-min cadence
const CONCURRENCY = 6;
// Half the 12-min cadence: a monitor whose next check lands within this window
// is run now rather than slipping to the following tick (which would otherwise
// double its effective interval whenever a run takes a moment to reach it).
const DUE_SLACK_MS = 6 * 60 * 1000;

interface StateRow {
  monitor_id: string;
  state: string;
  next_check_at: number | null;
  last_success_at: number | null;
  last_beat_at: number | null;
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
 * (with warm-up + retries via the runner), detects missed heartbeats, applies
 * the incident lifecycle, flushes queued notifications, runs history rollups +
 * retention/cleanup, and records run diagnostics.
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
      "SELECT monitor_id, state, next_check_at, last_success_at, last_beat_at FROM monitor_state",
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
        // Base the deadline on the last beat ACTUALLY RECEIVED (success OR
        // failure), or — for a monitor that has never beaten — on its creation
        // time. Keying off last_success_at would wrongly declare an on-schedule
        // but failing heartbeat "missed", clobbering its real error and
        // double-counting downtime.
        const base = st?.last_beat_at ?? m.createdAt;
        const deadline = base + (m.intervalSeconds + (m.graceSeconds ?? 0)) * 1000;
        if (now > deadline) {
          // Overdue: (re)mark missed every cycle while it stays overdue so the
          // ongoing downtime accrues in the rollups. markHeartbeatMissed dedupes
          // the incident + the notification, so this does not spam alerts.
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

      // HTTP monitor: due if next_check_at lands within this cycle (+slack).
      if ((st?.next_check_at ?? 0) > now + DUE_SLACK_MS) {
        skipped++;
        continue;
      }
      dueHttp.push(m);
    }

    await mapLimit(dueHttp, CONCURRENCY, async (m) => {
      const st = states.get(m.id);
      // Warm-up applies on a cold start (never checked / just came back on
      // schedule). A monitor already in `warming_up` is NOT warmed up again:
      // the next check is a normal one whose failure opens a real incident, so
      // warm-up grants exactly one grace cycle rather than masking outages.
      const warmup = !st || st.state === "scheduled_off" || st.state === "unknown";
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

    // Purge expired sessions + auth tokens so abandoned OAuth/magic flows and
    // rotated sessions can't grow D1 without bound (both index-backed).
    try {
      await cleanupExpiredSessions(env);
      await cleanupExpiredAuthTokens(env);
    } catch (e) {
      console.error("[scheduler] auth cleanup failed", e);
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
