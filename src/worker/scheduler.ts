import type { Env } from "./types";
import {
  listMonitorsStatement,
  monitorsFromRows,
  type MonitorRecord,
  type MonitorRow,
} from "./db/monitors";
import { isActiveAt } from "./lib/schedule";
import { probeFetchLimit, runMonitorCheck } from "./checks/runner";
import { parseDomainCache } from "./checks/domain";
import {
  regionalRechecker,
  REMOTE_RECHECK_OVERHEAD,
  supportsRemoteRecheck,
  type RegionalOptions,
} from "./checks/region";
import { pacer } from "./lib/pace";
import {
  checkNeedsIncident,
  planAlertRepair,
  planCheckResult,
  planHeartbeatMissed,
  planMaintenanceState,
  planScheduledOff,
  planWarmHeartbeat,
  readWriteContext,
  STATE_COLUMNS,
  type StateRow as CheckStateRow,
} from "./checks/state";
import type { CheckOutcome } from "./checks/types";
import { rowToIncident, unnotifiedIncidentsStatement, type IncidentRow } from "./db/incidents";
import { activeWindowsFromRows, listMaintenanceStatement, type MaintenanceRow } from "./db/maintenance";
import { compactionStatements, resolveRetention, type RetentionConfig } from "./history/rollups";
import { outboxTake, processOutbox } from "./notifications/dispatcher";
import { sendWeeklySummary, WEEKLY_GATE_SETTINGS } from "./notifications/weekly";
import { MONTHLY_GATE_SETTINGS, sendMonthlyReport } from "./notifications/monthly";
import {
  acquireLeaseStatement,
  lastFinishedRunAt,
  lastFinishedRunStatement,
  leaseHolderStatement,
  recordRunStartStatement,
  recordRunFinishStatement,
  releaseLease,
  releaseLeaseStatement,
  type RunStats,
} from "./lib/lease";
import { expiredAuthCleanupStatements } from "./lib/sessions";
import {
  countingD1,
  MONTHLY_REPORT_D1,
  NOTIFICATION_D1_COST,
  WEEKLY_SUMMARY_D1,
  planBudget,
  RunBudget,
  type PlanBudget,
  type UsageCounter,
} from "./lib/budget";
import { DOWNTIME_STATES } from "../shared/states";
import { runWritePlan, type GroupOutcome, type WriteGroup } from "./lib/batch";
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
// Space a run's RDAP lookups (domain monitors) this far apart: rdap.org and the
// registries rate limit bursts (lib/pace.ts). Most domain cycles are judged from
// the cached read and make no lookup, so this rarely costs a run any time.
const RDAP_SPACING_MS = 2_000;

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

/**
 * How a run ended, for the hosted scheduler entry (routes/platform.ts), which
 * answers the platform with it. The cron handler ignores it.
 */
export type RunResult =
  | { outcome: "lease_busy"; startedAt: number; d1Queries: number }
  | { outcome: "ran" | "failed"; startedAt: number; stats: RunStats; deferred: number };

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
 * ms on a good tick). So a run sends its work in as few round trips as it can,
 * however many monitors it checks: one to take the lease, open its run record
 * and read everything it needs; one, only when a check may open or resolve an
 * incident, for the reads that depends on; one for every monitor's writes and
 * the end-of-run work (the outbox claim, rollups, retention, auth cleanup); and
 * one to record the finish and release the lease. A run that checks nothing
 * makes exactly three, and so does a run whose checks all pass. Each delivered
 * alert adds its own queries (lib/budget.ts counts them), and the run record
 * keeps the total as `d1_queries` next to its wall-clock `duration_ms`.
 */
export async function runScheduled(
  controller: ScheduledController,
  baseEnv: Env,
  /** Tests only: a different budget than the plan's, a shorter re-check pause or RDAP spacing, regional stand-ins. */
  opts: {
    budget?: PlanBudget;
    confirmDelayMs?: number;
    rdapSpacingMs?: number;
    regional?: RegionalOptions;
  } = {},
): Promise<RunResult> {
  // Every D1 query this run makes is counted against the plan's budget.
  const usage: UsageCounter = { d1: 0 };
  const env: Env = { ...baseEnv, DB: countingD1(baseEnv.DB, usage) };
  const budget = new RunBudget(opts.budget ?? planBudget(baseEnv), usage);
  const lease = { name: LEASE_NAME, holder: newId("lease") };
  const run = { id: newId("run"), startedAt: Date.now() };
  const now = run.startedAt;

  // Round trip 1: take the lease, open the run record (only if the lease was
  // won), and read what the run needs. A batch is one transaction, so the run
  // record can never exist without the lease. Losing the lease wastes only the
  // reads; nothing is written.
  const [, holderRes, , monitorsRes, statesRes, maintenanceRes, settingsRes, unnotifiedRes, lastRunRes] =
    await env.DB.batch([
      acquireLeaseStatement(env, lease.name, lease.holder, now, LEASE_TTL_MS),
      leaseHolderStatement(env, lease.name),
      recordRunStartStatement(env, run, controller.cron ?? null, lease),
      listMonitorsStatement(env),
      env.DB.prepare(`SELECT monitor_id, next_check_at, ${STATE_COLUMNS} FROM monitor_state`),
      listMaintenanceStatement(env),
      settingsStatement(env, RUN_SETTINGS),
      unnotifiedIncidentsStatement(env, now),
      lastFinishedRunStatement(env),
    ]);
  const holder = (holderRes?.results?.[0] as { holder?: string } | undefined)?.holder;
  if (holder !== lease.holder) {
    console.log("[scheduler] another run holds the lease; skipping");
    return { outcome: "lease_busy", startedAt: run.startedAt, d1Queries: usage.d1 };
  }

  const tally = {
    checked: 0,
    skipped: 0,
    failures: 0,
    confirmations: 0,
    confirmationsCleared: 0,
    confirmationsDeferred: 0,
    /** Due monitors left for the next run (the budget, or a re-check it couldn't afford). */
    deferred: 0,
  };
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
    // Every write this run makes, collected and sent at the end in one batch
    // with the end-of-run work (checks/state.ts plans them). `done` tallies a
    // monitor once its writes landed, or counts the failure when they couldn't.
    const writes: { group: WriteGroup; done: (o: GroupOutcome) => void }[] = [];
    const skippedOnceWritten = (what: string) => (o: GroupOutcome) => {
      if (o === "none") tally.failures++;
      else tally.skipped++;
      if (o === "none") console.error(`[scheduler] ${what} could not be written`);
    };
    const missedHeartbeats: MonitorRecord[] = [];

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
        writes.push({
          group: planMaintenanceState(env, m, now, states.get(m.id) ?? null),
          done: skippedOnceWritten(`maintenance ${m.id}`),
        });
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
        writes.push({
          group: planScheduledOff(env, m, now, off ?? null),
          done: skippedOnceWritten(`scheduled-off ${m.id}`),
        });
        continue;
      }

      const st = states.get(m.id);

      if (m.type === "heartbeat") {
        // First in-window tick after an off-schedule gap (or a never-beaten cold
        // start): the pre-gap last_beat_at is stale - potentially hours/days old
        // - so the deadline below would be instantly overdue → a false miss the
        // moment monitoring resumes. Grant one warm-up cycle that re-bases the
        // deadline on `now`; genuine misses are detected from the next tick on.
        if (!st || st.state === "scheduled_off" || st.state === "unknown") {
          writes.push({
            group: planWarmHeartbeat(env, m, now, st ?? null),
            done: skippedOnceWritten(`heartbeat warm-up ${m.id}`),
          });
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
          // ongoing downtime accrues in the rollups. planHeartbeatMissed dedupes
          // the incident + the notification, so this does not spam alerts. It
          // re-reads the monitor's state first (below, with the other reads).
          missedHeartbeats.push(m);
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
    // next_check_at keeps it due - logged, never silently dropped.
    duePolled.sort(
      (a, b) =>
        (states.get(a.id)?.next_check_at ?? 0) - (states.get(b.id)?.next_check_at ?? 0),
    );
    let deferred = 0;
    const results: { m: MonitorRecord; outcome: CheckOutcome; st: SchedulerStateRow | null }[] = [];
    const paceLookup = pacer(opts.rdapSpacingMs ?? RDAP_SPACING_MS);
    // Second-region confirmation (checks/region.ts): null when this install
    // confirms where the check ran.
    const remoteRecheck = regionalRechecker(env, opts.regional);
    await mapLimit(duePolled, CONCURRENCY, async (m) => {
      const st = states.get(m.id);
      // A domain cycle judged from its cached read (checks/domain.ts) makes no
      // request, so it reserves no fetch; plannedAt keeps that decision and the
      // check's own the same.
      const plannedAt = Date.now();
      const domainCache = m.type === "domain" ? parseDomainCache(st?.domain_cache) : null;
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
      // Confirm before alerting (checks/runner.ts): a failure re-checks once
      // before it can open an incident, unless the monitor turned that off or
      // is already down. While down there is nothing to confirm (the incident
      // is open), and a recovery counts on the first passing check.
      const alreadyDown = !!st && (DOWNTIME_STATES.has(st.state) || !!st.active_incident_id);
      const confirm = m.confirmFailures !== "off" && !alreadyDown;
      const remote = confirm && remoteRecheck && supportsRemoteRecheck(m.type) ? remoteRecheck : undefined;
      // Out of budget for this run: leave it due for the next tick. A check
      // that may confirm holds its re-check's fetches too (a fresh probe, so no
      // cached read), so a failure it finds can always be confirmed.
      const ticket = await budget.startCheck(
        probeFetchLimit(m, m.type === "domain" ? { cache: domainCache, now: plannedAt } : undefined),
        confirm ? probeFetchLimit(m) + (remote ? REMOTE_RECHECK_OVERHEAD : 0) : 0,
      );
      if (!ticket) {
        deferred++;
        return;
      }
      let fetchesSpent: number | undefined;
      try {
        const outcome = await runMonitorCheck(m, {
          warmup,
          confirm,
          ...(opts.confirmDelayMs !== undefined ? { confirmDelayMs: opts.confirmDelayMs } : {}),
          // The re-check costs another probe. When the run can't afford it (or
          // RDAP rate limited the lookup, so a re-check now would be refused
          // too) the failure is not written at all (no state, sample or alert):
          // the monitor stays due and is first in line next run, so an
          // unconfirmed failure never alerts.
          allowConfirm: () => ticket.tryConfirm(),
          ...(remote ? { remoteRecheck: remote } : {}),
          domainCache,
          plannedAt,
          paceLookup,
          now: Date.now(),
        });
        fetchesSpent = outcome.fetches;
        if (outcome.confirmation === "deferred") {
          tally.confirmationsDeferred++;
          deferred++;
          return;
        }
        if (outcome.confirmation) tally.confirmations++;
        if (outcome.confirmation === "cleared") tally.confirmationsCleared++;
        // Written with the rest at the end of the run.
        results.push({ m, outcome, st: st ?? null });
      } catch (e) {
        tally.failures++;
        console.error(`[scheduler] check ${m.id} failed`, e);
      } finally {
        ticket.end(fetchesSpent);
      }
    });
    tally.deferred = deferred;
    if (deferred > 0) {
      tally.skipped += deferred;
      console.log(
        `[scheduler] ${duePolled.length} polled checks due; ran ${duePolled.length - deferred} within the ${budget.limits.plan} plan's budget, deferring ${deferred} to the next tick`,
      );
    }

    // The reads the writes depend on, in one round trip, only when some check
    // may open or resolve an incident or a heartbeat is overdue: each such
    // monitor's open incident, recent incidents (flap detection) and recent
    // alerts (cooldown), the alert channels, and a fresh state row for each
    // overdue heartbeat (a beat may have arrived since the run started).
    // Retries after a failed batch are paid from what the budget has left.
    const retryRoom = () => budget.canSpendD1(2);
    // Open incidents whose alert a failed write left out (planAlertRepair).
    const unnotified = ((unnotifiedRes?.results ?? []) as IncidentRow[]).map(rowToIncident);
    const ctx = await readWriteContext(
      env,
      {
        notify: unnotified.length > 0,
        incidents: [
          ...results
            .filter((r) => checkNeedsIncident(r.outcome, r.st))
            .map((r) => ({ monitorId: r.m.id, at: r.outcome.at })),
          ...missedHeartbeats.map((m) => ({ monitorId: m.id, at: now })),
        ],
        states: missedHeartbeats.map((m) => m.id),
      },
      { canSpend: retryRoom },
    );

    for (const { m, outcome, st } of results) {
      try {
        const planned = await planCheckResult(env, m, outcome, st, ctx);
        writes.push({
          group: planned.group,
          done: (o) => {
            if (o === "none") {
              tally.failures++;
              console.error(`[scheduler] check ${m.id} could not be written`);
              return;
            }
            tally.checked++;
            if (!outcome.ok) tally.failures++;
          },
        });
      } catch (e) {
        tally.failures++;
        console.error(`[scheduler] check ${m.id} failed`, e);
      }
    }
    const byId = new Map(monitors.map((m) => [m.id, m]));
    // A monitor that recovers in this very run gets its recovery alert, not a
    // late down alert first.
    const recovering = new Set(results.filter((r) => r.outcome.ok).map((r) => r.m.id));
    for (const incident of unnotified) {
      try {
        const monitor = recovering.has(incident.monitorId) ? null : (byId.get(incident.monitorId) ?? null);
        const group = await planAlertRepair(env, monitor, incident, ctx);
        if (group) {
          writes.push({
            group,
            done: (o) => {
              if (o === "none") console.error(`[scheduler] alert for ${incident.id} still not queued`);
            },
          });
        }
      } catch (e) {
        console.error(`[scheduler] alert repair ${incident.id} failed`, e);
      }
    }
    for (const m of missedHeartbeats) {
      if (!ctx.states.has(m.id)) {
        tally.failures++;
        console.error(`[scheduler] heartbeat ${m.id}: its state could not be read`);
        continue;
      }
      try {
        const planned = await planHeartbeatMissed(env, m, now, ctx.states.get(m.id) ?? null, ctx);
        const counted = () => {
          tally.checked++;
          tally.failures++;
        };
        // A beat arrived after the snapshot: nothing to write.
        if (!planned) counted();
        else {
          writes.push({
            group: planned.group,
            done: (o) => {
              if (o === "none") {
                tally.failures++;
                console.error(`[scheduler] heartbeat ${m.id} could not be written`);
              } else counted();
            },
          });
        }
      } catch (e) {
        tally.failures++;
        console.error(`[scheduler] heartbeat ${m.id} failed`, e);
      }
    }

    // Round trip 2 (3 when the reads above ran): every monitor's writes, then
    // the end-of-run work, in one batch (lib/batch.ts runWritePlan, which
    // retries in smaller parts if it fails, so a bad statement only costs its
    // own monitor's unit). The outbox is claimed after the writes queued their
    // alerts, in the same batch, and delivered below.
    const take = outboxTake(budget.notificationAllowance(25));
    const retention = resolveRetention(
      parseJSONSetting<Partial<RetentionConfig>>(settings.get("retention")),
    );
    const claim = take > 0 ? [{ label: "outbox claim", stmt: claimDueStatement(env, Date.now(), take) }] : [];
    const plan = await runWritePlan(
      env,
      "scheduler",
      writes.map((w) => w.group),
      [
        ...claim,
        // Only what changed since the last run (history/rollups.ts).
        ...compactionStatements(env, now, retention, lastFinishedRunAt(lastRunRes)),
        ...expiredAuthCleanupStatements(env),
      ],
      // Keep room for the run record and the deliveries just claimed.
      { canSpend: () => budget.canSpendD1(1 + take * NOTIFICATION_D1_COST) },
    );
    writes.forEach((w, i) => w.done(plan.groups[i]!));
    const tailResults = plan.tail;

    // Deliver what was claimed (independent; never fails the run).
    let notificationFailures = 0;
    const claimed = claim.length > 0 ? tailResults[0] : null;
    if (claimed) {
      try {
        const entries = await outboxEntriesFromRows(env, (claimed.results ?? []) as OutboxRow[]);
        // Each delivery goes only if its worst case still fits (it never
        // pushes the run past its plan); the rest wait for the next run.
        const r = await processOutbox(env, Date.now(), take, entries, {
          canSpend: (d1) => budget.canSpendD1(d1),
        });
        notificationFailures = r.failed;
      } catch (e) {
        console.error("[scheduler] notification dispatch failed", e);
      }
    }

    // Weekly summary (self-guards on enabled/recipient/due, from the settings
    // read up front, so a run where it isn't due costs no queries). When
    // retries above left too little of the budget for it, it waits for a later
    // run: it stays due until it is sent.
    let weeklyAttempted = false;
    if (budget.canSpendD1(WEEKLY_SUMMARY_D1)) {
      try {
        const weekly = await sendWeeklySummary(env, Date.now(), settings);
        weeklyAttempted =
          weekly.sent || !["disabled", "no_recipient", "not_due"].includes(weekly.reason ?? "");
      } catch (e) {
        weeklyAttempted = true;
        console.error("[scheduler] weekly summary failed", e);
      }
    } else {
      // Counted as tried, so the monthly report doesn't take its place either.
      weeklyAttempted = true;
      console.log("[scheduler] out of D1 budget; the weekly summary and monthly report wait for a later run");
    }

    // Monthly report (opt-in, from the 1st; notifications/monthly.ts). It costs
    // two queries when it tries and none otherwise. One email job per run: if
    // the weekly summary already tried this run, the report waits for a later
    // one (it catches up any day until last month's report is sent), so the
    // tail reserve never has to hold both.
    if (!weeklyAttempted && budget.canSpendD1(MONTHLY_REPORT_D1)) {
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
      confirmations: tally.confirmations,
      confirmationsCleared: tally.confirmationsCleared,
      confirmationsDeferred: tally.confirmationsDeferred,
    };
  } catch (err) {
    console.error("[scheduler] run failed", err);
    stats = {
      ok: false,
      monitorsChecked: tally.checked,
      monitorsSkipped: tally.skipped,
      checkFailures: tally.failures,
      notificationFailures: 0,
      confirmations: tally.confirmations,
      confirmationsCleared: tally.confirmationsCleared,
      confirmationsDeferred: tally.confirmationsDeferred,
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
    `[scheduler] cron=${controller.cron} checked=${stats.monitorsChecked} skipped=${stats.monitorsSkipped} failures=${stats.checkFailures} confirmations=${stats.confirmations ?? 0} cleared=${stats.confirmationsCleared ?? 0} deferred=${stats.confirmationsDeferred ?? 0} d1=${stats.d1Queries} ms=${Date.now() - run.startedAt}`,
  );
  return { outcome: stats.ok ? "ran" : "failed", startedAt: run.startedAt, stats, deferred: tally.deferred };
}
