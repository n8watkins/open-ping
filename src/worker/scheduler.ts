import type { Env } from "./types";
import {
  listMonitorsStatement,
  monitorsFromRows,
  type MonitorRecord,
  type MonitorRow,
} from "./db/monitors";
import { isActiveAt } from "./lib/schedule";
import { runMonitorCheck } from "./checks/runner";
import {
  applyCheckResult,
  setScheduledOff,
  setMaintenanceState,
  markHeartbeatMissed,
  warmHeartbeat,
  STATE_COLUMNS,
  type StateRow as CheckStateRow,
} from "./checks/state";
import { activeWindowsFromRows, listMaintenanceStatement, type MaintenanceRow } from "./db/maintenance";
import { compactionStatements, resolveRetention, type RetentionConfig } from "./history/rollups";
import { outboxTake, processOutbox } from "./notifications/dispatcher";
import { sendWeeklySummary, WEEKLY_GATE_SETTINGS } from "./notifications/weekly";
import { MONTHLY_GATE_SETTINGS, sendMonthlyReport } from "./notifications/monthly";
import {
  acquireLeaseStatement,
  leaseHolderStatement,
  recordRunStartStatement,
  recordRunFinishStatement,
  releaseLease,
  releaseLeaseStatement,
  type RunStats,
} from "./lib/lease";
import { expiredAuthCleanupStatements } from "./lib/sessions";
import { countingD1, planBudget, RunBudget, type UsageCounter } from "./lib/budget";
import { batchEach } from "./lib/batch";
import { claimDueStatement, outboxEntriesFromRows, type OutboxRow } from "./db/outbox";
import { parseJSONSetting, settingsFromRows, settingsStatement, type SettingRow } from "./db/settings";
import { newId } from "./lib/ids";

const LEASE_NAME = "scheduler";
const LEASE_TTL_MS = 5 * 60 * 1000; // shorter than the 12-min cadence
const CONCURRENCY = 6;
// How many polled checks (http/dns/tcp/domain) one tick runs is set by the
// plan's per-invocation budget (lib/budget.ts): on the Free plan a run may make
// only 50 D1 queries and 50 outbound fetches, so it checks a handful of
// monitors and defers the rest (oldest next_check_at first) to the next tick.
// The plan's maxChecks also bounds a Paid run, so a backlog can't overrun the
// 12-min cadence / 5-min lease.
// Half the 12-min cadence: a monitor whose next check lands within this window
// is run now rather than slipping to the following tick (which would otherwise
// double its effective interval whenever a run takes a moment to reach it).
const DUE_SLACK_MS = 6 * 60 * 1000;

/** The preloaded row: what the scheduler needs, plus what a check reads (STATE_COLUMNS). */
interface SchedulerStateRow extends CheckStateRow {
  monitor_id: string;
  next_check_at: number | null;
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
      await fn(items[idx]!); // idx < items.length by the loop guard
    }
  });
  await Promise.all(workers);
}

/** Settings a run reads up front, in its first round trip. */
const RUN_SETTINGS = [
  ...new Set(["retention", ...WEEKLY_GATE_SETTINGS, ...MONTHLY_GATE_SETTINGS]),
] as const;

/**
 * Every-12-minute check cycle (PRD §9). Acquires an execution lease, evaluates
 * each enabled monitor against its schedule, runs due polled checks
 * (http/dns/tcp/domain) concurrently (with warm-up + retries via the runner),
 * detects missed heartbeats, applies
 * the incident lifecycle, flushes queued notifications, runs history rollups +
 * retention/cleanup, and records run diagnostics.
 *
 * Round trips, not queries, set how long a run takes. Cron Triggers run on
 * whichever Cloudflare machine has spare capacity, often far from the database,
 * and a D1 round trip from there measured about 160 ms in production (about 12
 * ms on a good tick). So a run sends its work in as few round trips as it can:
 * one to take the lease, open its run record and read everything it needs, one
 * for the end-of-run work (the outbox claim, rollups, retention, auth cleanup),
 * and one to record the finish and release the lease. A run that checks nothing
 * makes exactly those three. Each check adds its own (lib/budget.ts counts
 * them), and the run record keeps the total as `d1_queries` next to its
 * wall-clock `duration_ms`.
 */
export async function runScheduled(controller: ScheduledController, baseEnv: Env): Promise<void> {
  // Every D1 query this run makes is counted against the plan's budget.
  const usage: UsageCounter = { d1: 0 };
  const env: Env = { ...baseEnv, DB: countingD1(baseEnv.DB, usage) };
  const budget = new RunBudget(planBudget(baseEnv), usage);
  const lease = { name: LEASE_NAME, holder: newId("lease") };
  const run = { id: newId("run"), startedAt: Date.now() };
  const now = run.startedAt;

  // Round trip 1: take the lease, open the run record (only if the lease was
  // won), and read what the run needs. A batch is one transaction, so the run
  // record can never exist without the lease. Losing the lease wastes only the
  // reads; nothing is written.
  const [, holderRes, , monitorsRes, statesRes, maintenanceRes, settingsRes] = await env.DB.batch([
    acquireLeaseStatement(env, lease.name, lease.holder, now, LEASE_TTL_MS),
    leaseHolderStatement(env, lease.name),
    recordRunStartStatement(env, run, controller.cron ?? null, lease),
    listMonitorsStatement(env),
    env.DB.prepare(`SELECT monitor_id, next_check_at, ${STATE_COLUMNS} FROM monitor_state`),
    listMaintenanceStatement(env),
    settingsStatement(env, RUN_SETTINGS),
  ]);
  const holder = (holderRes?.results?.[0] as { holder?: string } | undefined)?.holder;
  if (holder !== lease.holder) {
    console.log("[scheduler] another run holds the lease; skipping");
    return;
  }

  const tally = { checked: 0, skipped: 0, failures: 0 };
  let stats: RunStats;
  try {
    const monitors = await monitorsFromRows(env, (monitorsRes?.results ?? []) as MonitorRow[]);
    const settings = await settingsFromRows(
      env,
      RUN_SETTINGS,
      (settingsRes?.results ?? []) as (SettingRow & { key: string })[],
    );
    const states = new Map<string, SchedulerStateRow>(
      ((statesRes?.results ?? []) as SchedulerStateRow[]).map((st) => [st.monitor_id, st]),
    );

    // Active maintenance windows (checked in-memory per monitor).
    const windows = activeWindowsFromRows((maintenanceRes?.results ?? []) as MaintenanceRow[], now);
    const globalMaintenance = windows.some((w) => w.scope === "global");
    const maintenanceMonitorIds = new Set(
      windows.filter((w) => w.scope === "monitors").flatMap((w) => w.monitorIds ?? []),
    );

    const duePolled: MonitorRecord[] = [];

    for (const m of monitors) {
      if (!m.enabled || m.paused) {
        tally.skipped++;
        continue;
      }
      if (globalMaintenance || maintenanceMonitorIds.has(m.id)) {
        // Already in maintenance: nothing to write until the window ends (its
        // past next_check_at then makes it due at once).
        if (states.get(m.id)?.state === "maintenance") {
          tally.skipped++;
          continue;
        }
        // Wrapped so one monitor's DB error can't abort the whole cycle and
        // starve every monitor after it.
        try {
          await setMaintenanceState(env, m, now);
          tally.skipped++;
        } catch (e) {
          tally.failures++;
          console.error(`[scheduler] maintenance ${m.id} failed`, e);
        }
        continue;
      }
      if (!isActiveAt(m.schedule, new Date(now))) {
        // Already off with its next window recorded: nothing changes until then,
        // so spend no queries on it (off-hours monitors would otherwise cost
        // every run several D1 queries each).
        const off = states.get(m.id);
        if (off?.state === "scheduled_off" && (off.next_check_at ?? 0) > now) {
          tally.skipped++;
          continue;
        }
        try {
          await setScheduledOff(env, m, now);
          tally.skipped++;
        } catch (e) {
          tally.failures++;
          console.error(`[scheduler] scheduled-off ${m.id} failed`, e);
        }
        continue;
      }

      const st = states.get(m.id);

      if (m.type === "heartbeat") {
        // First in-window tick after an off-schedule gap (or a never-beaten cold
        // start): the pre-gap last_beat_at is stale — potentially hours/days old
        // — so the deadline below would be instantly overdue → a false miss the
        // moment monitoring resumes. Grant one warm-up cycle that re-bases the
        // deadline on `now`; genuine misses are detected from the next tick on.
        if (!st || st.state === "scheduled_off" || st.state === "unknown") {
          try {
            await warmHeartbeat(env, m, now);
            tally.skipped++;
          } catch (e) {
            tally.failures++;
            console.error(`[scheduler] heartbeat warm-up ${m.id} failed`, e);
          }
          continue;
        }
        // Base the deadline on the last beat ACTUALLY RECEIVED (success OR
        // failure). Keying off last_success_at would wrongly declare an
        // on-schedule but failing heartbeat "missed", clobbering its real error
        // and double-counting downtime.
        const base = st.last_beat_at ?? m.createdAt;
        const deadline = base + (m.intervalSeconds + (m.graceSeconds ?? 0)) * 1000;
        if (now > deadline) {
          // Overdue: (re)mark missed every cycle while it stays overdue so the
          // ongoing downtime accrues in the rollups. markHeartbeatMissed dedupes
          // the incident + the notification, so this does not spam alerts.
          try {
            await markHeartbeatMissed(env, m, now);
            tally.checked++;
            tally.failures++;
          } catch (e) {
            tally.failures++;
            console.error(`[scheduler] heartbeat ${m.id} failed`, e);
          }
        } else {
          tally.skipped++;
        }
        continue;
      }

      // Polled monitor (http/dns/tcp/domain): due if next_check_at lands within
      // this cycle (+slack).
      if ((st?.next_check_at ?? 0) > now + DUE_SLACK_MS) {
        tally.skipped++;
        continue;
      }
      duePolled.push(m);
    }

    // Run the most-overdue monitors first (oldest next_check_at), then cap the
    // batch: an unbounded fan-out at CONCURRENCY can exceed the Worker
    // subrequest/CPU budget and overrun the 12-min cadence / 5-min lease. The
    // remainder carries over to the next tick, where its already-past
    // next_check_at keeps it due — logged, never silently dropped.
    duePolled.sort(
      (a, b) =>
        (states.get(a.id)?.next_check_at ?? 0) - (states.get(b.id)?.next_check_at ?? 0),
    );
    let deferred = 0;
    await mapLimit(duePolled, CONCURRENCY, async (m) => {
      // Out of budget for this run: leave it due for the next tick.
      if (!(await budget.startCheck())) {
        deferred++;
        return;
      }
      const st = states.get(m.id);
      // Warm-up applies on a cold start (never checked) or the first check after
      // the monitor comes back on schedule or out of maintenance. A monitor
      // already in `warming_up` is NOT warmed up again: the next check is a
      // normal one whose failure opens a real incident, so warm-up grants exactly
      // one grace cycle rather than masking outages.
      const warmup =
        !st ||
        st.state === "scheduled_off" ||
        st.state === "unknown" ||
        st.state === "maintenance";
      try {
        const outcome = await runMonitorCheck(m, { warmup, now: Date.now() });
        await applyCheckResult(env, m, outcome, st ?? null);
        tally.checked++;
        if (!outcome.ok) tally.failures++;
      } catch (e) {
        tally.failures++;
        console.error(`[scheduler] check ${m.id} failed`, e);
      } finally {
        budget.endCheck();
      }
    });
    if (deferred > 0) {
      tally.skipped += deferred;
      console.log(
        `[scheduler] ${duePolled.length} polled checks due; ran ${duePolled.length - deferred} within the ${budget.limits.plan} plan's budget, deferring ${deferred} to the next tick`,
      );
    }

    // Round trip 2: the end-of-run work, independent statements in one batch
    // (lib/batch.ts retries them one by one if the batch fails, so a bad one
    // can't take the others down). The outbox is claimed here, after the checks
    // above queued their alerts, and delivered below.
    const take = outboxTake(budget.notificationAllowance(25));
    const retention = resolveRetention(
      parseJSONSetting<Partial<RetentionConfig>>(settings.get("retention")),
    );
    const claim = take > 0 ? [{ label: "outbox claim", stmt: claimDueStatement(env, Date.now(), take) }] : [];
    const results = await batchEach(env, "scheduler", [
      ...claim,
      ...compactionStatements(env, now, retention),
      ...expiredAuthCleanupStatements(env),
    ]);

    // Deliver what was claimed (independent; never fails the run).
    let notificationFailures = 0;
    const claimed = claim.length > 0 ? results[0] : null;
    if (claimed) {
      try {
        const entries = await outboxEntriesFromRows(env, (claimed.results ?? []) as OutboxRow[]);
        const r = await processOutbox(env, Date.now(), take, entries);
        notificationFailures = r.failed;
      } catch (e) {
        console.error("[scheduler] notification dispatch failed", e);
      }
    }

    // Weekly summary (self-guards on enabled/recipient/due, from the settings
    // read up front, so a run where it isn't due costs no queries).
    let weeklyAttempted = false;
    try {
      const weekly = await sendWeeklySummary(env, Date.now(), settings);
      weeklyAttempted =
        weekly.sent || !["disabled", "no_recipient", "not_due"].includes(weekly.reason ?? "");
    } catch (e) {
      weeklyAttempted = true;
      console.error("[scheduler] weekly summary failed", e);
    }

    // Monthly report (opt-in, on the 1st; notifications/monthly.ts). It costs
    // two queries when it sends and none otherwise. If the weekly summary
    // already spent its queries this run, the report waits for the next run,
    // 12 minutes later and still on the 1st, so the tail reserve holds both.
    if (!weeklyAttempted) {
      try {
        await sendMonthlyReport(env, Date.now(), settings, retention);
      } catch (e) {
        console.error("[scheduler] monthly report failed", e);
      }
    }

    stats = {
      ok: true,
      monitorsChecked: tally.checked,
      monitorsSkipped: tally.skipped,
      checkFailures: tally.failures,
      notificationFailures,
    };
  } catch (err) {
    console.error("[scheduler] run failed", err);
    stats = {
      ok: false,
      monitorsChecked: tally.checked,
      monitorsSkipped: tally.skipped,
      checkFailures: tally.failures,
      notificationFailures: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Round trip 3: record the finish and release the lease together. The count
  // includes this last batch, so it is the run's total.
  stats.d1Queries = usage.d1 + 1;
  try {
    await env.DB.batch([
      recordRunFinishStatement(env, run.id, run.startedAt, stats),
      releaseLeaseStatement(env, lease.name, lease.holder),
    ]);
  } catch (e) {
    console.error("[scheduler] could not record the run's finish", e);
    // Still release the lease, or the next tick stalls until its TTL expires.
    await releaseLease(env, lease.name, lease.holder).catch((err: unknown) =>
      console.error("[scheduler] lease release failed", err),
    );
  }
  console.log(
    `[scheduler] cron=${controller.cron} checked=${stats.monitorsChecked} skipped=${stats.monitorsSkipped} failures=${stats.checkFailures} d1=${stats.d1Queries} ms=${Date.now() - run.startedAt}`,
  );
}
