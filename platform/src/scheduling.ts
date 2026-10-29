/**
 * Scheduling (build plan, B4): running each customer's scheduler.
 *
 * A user Worker in a dispatch namespace has no Cron Trigger, so the platform
 * runs it. Two halves:
 *
 *   the cron      every minute, `enqueueDue` reads the tenants that are due
 *                 (an index range scan, so it costs the due tenants, never
 *                 the whole table), claims each one with a conditional write,
 *                 and puts one message per claimed tenant on SCHEDULE_QUEUE;
 *   the consumer  `handleScheduleBatch` takes each message, starts the run
 *                 (another conditional write), and calls the tenant's
 *                 POST /__platform/scheduled through the dispatch namespace
 *                 with fresh props and a fresh call id (callTenant), under a
 *                 timeout; then it records the run's numbers.
 *
 * One message per tenant, so a slow or broken tenant delays nobody else, and
 * a message whose consumer dies is delivered again.
 *
 When a tenant is due (the contract, section 6, "When to call next"), on
 * minute ticks:
 *   - a new tenant at once, its next run spread over its interval by its id;
 *   - after a run that answered `ran` with `nextDueAt` (when the tenant next
 *     has work): the first tick at or after it, never later than
 *     SCHEDULED_MAX_GAP_MS (12 minutes) after this run, so alerts, reports
 *     and cleanup keep at least the self-hosted cadence;
 *   - after `ran` without `nextDueAt` (a bundle older than the field): every
 *     `minIntervalMinutes` of its effective limits (12 minutes on the trial
 *     and the yearly plan, 1 minute with fast checks), keeping its phase;
 *   - after `lease_busy`: the next tick;
 *   - after `failed` or no answer: the next tick, then backing off (1, 2, 4,
 *     8 minutes...) while it keeps failing, never slower than its interval.
 * The claim records the interval's next tick; the consumer writes the due
 * time again only when the run moved it to another tick, so a tenant whose
 * work matches its plan costs no extra write.
 *
 * Never two runs of one tenant at once:
 *   - the claim records a run id and a lease (the wait in the queue), and the
 *     cron claims only a tenant whose lease has run out;
 *   - the consumer starts only the claimed run, and only once per attempt
 *     (`schedule_running`), replacing the lease with the call's timeout plus
 *     a margin, which is shorter than the interval, so it never has to be
 *     released (one write saved per run);
 *   - and the tenant keeps its own lease too (outcome `lease_busy`).
 *
 * Retries: a call that gets no answer (an error, a status other than 200, a
 * timeout) is retried through the queue with backoff, as long as the retry
 * can finish before the tenant's next run, which is the retry otherwise. A
 * run the tenant answers as `failed` is an answer, not retried: the next run
 * tries again (the contract, section 6).
 *
 * Suspended (by billing or by the owner), not-ready and removed tenants are
 * never claimed: the due index leaves them out. One suspended between the
 * claim and the call is skipped by the start.
 *
 * Cost per run in the platform database: 2 rows written by the claim (the
 * row and its index entry), 1 by the start, 1 for the numbers (one row per
 * tenant, scheduler_stats). platform/README.md has the totals at scale.
 */

import {
  PLATFORM_SCHEDULED_PATH,
  SCHEDULED_OUTCOMES,
  isTenantId,
  type PlatformCapability,
  type ScheduledOutcome,
  type ScheduledRequest,
  type ScheduledRunSummary,
} from "../../src/shared/hosted-contract";
import { callTenant, type TenantDispatcher } from "./dispatch";
import { TENANT_COLUMNS, effectiveLimits, tenantFromRow, type TenantRecord, type TenantRow } from "./tenants";

/** The platform's cron expression (platform/wrangler.jsonc), sent to the tenant as `cron`. */
export const SCHEDULE_CRON = "* * * * *";

/** One message per due tenant. */
export interface ScheduleMessage {
  tenantId: string;
  /** The claim's run id, echoed in the tenant's summary. */
  runId: string;
  /** When the tenant was due (epoch ms), for queue lag. */
  dueAt: number;
  /** When the cron fired (epoch ms), the contract's `scheduledTime`. */
  tick: number;
}

export interface SchedulingDeps {
  db: D1Database;
  dispatcher: TenantDispatcher;
  /** The capability a platform call to `tenant` carries as props.platform. */
  capability(tenant: TenantRecord): PlatformCapability;
  hostedDomain: string;
  now?: () => number;
  /** Tests only: the call's timeout for a tenant checked every `intervalMs`. */
  callTimeoutMs?: (intervalMs: number) => number;
}

// ---------------------------------------------------------------------------
// When a tenant is due
// ---------------------------------------------------------------------------

/** The longest a tenant goes without a run, whatever its `nextDueAt` says (the contract's SCHEDULED_MAX_GAP_MS). */
export const MAX_GAP_MS = 12 * 60_000;
export const MINUTE_MS = 60_000;
/** A message waits at most this long in the queue before the tenant can be claimed again. */
export const QUEUE_LEASE_MS = 3 * 60_000;
/** The run lease is the call's timeout plus this. */
export const RUN_LEASE_MARGIN_MS = 10_000;
/** The cron claims tenants due up to this much ahead, so a minute boundary a hair early still counts. */
export const DUE_SLACK_MS = 5_000;
/** Claimed and sent per round: Queues' sendBatch takes at most 100 messages. */
export const CLAIM_BATCH = 100;
/** Upper bound on one cron's claims (and its wall time below), so a backlog can't run the cron long. */
export const MAX_CLAIMS_PER_TICK = 10_000;
const CLAIM_TIME_BUDGET_MS = 25_000;
/** Waits before each retry of a call that got no answer. */
export const RETRY_DELAYS_SECONDS = [15, 60, 180] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/** How often the tenant runs: its fastest check, from its plan and overrides, 1 to 60 minutes. */
export function intervalMs(tenant: Pick<TenantRecord, "plan" | "limitOverrides">): number {
  const minutes = effectiveLimits(tenant).minIntervalMinutes;
  const clamped = Number.isFinite(minutes) ? Math.min(60, Math.max(1, Math.round(minutes))) : 12;
  return clamped * 60_000;
}

/**
 * The call's timeout. A 1-minute tenant must finish well inside its minute,
 * so its run lease (timeout plus margin) ends before its next claim; the
 * platform call's CPU cap (DISPATCH_LIMITS.platform) is 15 seconds either way.
 */
export function callTimeoutMs(interval: number): number {
  return interval <= 60_000 ? 40_000 : 90_000;
}

/** A stable spread in [0, n) from the tenant id (FNV-1a), so tenants don't all run in the same minute. */
export function spreadIndex(tenantId: string, n: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < tenantId.length; i++) {
    hash ^= tenantId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % Math.max(1, n);
}

/** The minute tick the cron at `at` stands for (it may fire a moment early or a few seconds late). */
export function currentTick(at: number): number {
  return Math.floor((at + DUE_SLACK_MS) / MINUTE_MS) * MINUTE_MS;
}

/**
 * A tenant checks what is due within 30 seconds of a call (the contract,
 * section 6), so a due time this little past a tick is called on that tick
 * rather than a minute later: a monitor checked a second after its tick
 * reports its next check a second past the tick, and would otherwise slip a
 * minute every run.
 */
export const EARLY_CALL_MS = 15_000;

/**
 * The tick a tenant due at `at` is called on: the first at or after it, or
 * one up to EARLY_CALL_MS before it. Due times are kept on ticks, so an
 * unchanged tick means nothing to write.
 */
export function tickFor(at: number): number {
  return Math.ceil((at - EARLY_CALL_MS) / MINUTE_MS) * MINUTE_MS;
}

/**
 * The next due time the claim records: the tenant's interval on from the
 * due time being claimed (`previous`), past this tick, so a late cron
 * doesn't bunch tenants together. A tenant's first claim (`previous` 0)
 * runs now and places the next run somewhere in the interval by its id.
 */
export function nextDueAfterClaim(tenantId: string, previous: number, tick: number, interval: number): number {
  if (previous <= 0) return tick + (1 + spreadIndex(tenantId, Math.round(interval / MINUTE_MS))) * MINUTE_MS;
  const steps = Math.max(1, Math.ceil((tick - previous + 1) / interval));
  return tickFor(previous + steps * interval);
}

/**
 * After a run: when the tenant is due next (see the top of this file).
 * `claimedNext` is what the claim recorded; `summary` is null when the call
 * got no answer; `streak` counts the runs in a row, this one included, that
 * failed or got none.
 */
export function nextDueAfterRun(input: {
  tick: number;
  claimedNext: number;
  interval: number;
  summary: Pick<ScheduledRunSummary, "outcome"> & { nextDueAt?: unknown } | null;
  streak: number;
}): number {
  const nextTick = input.tick + MINUTE_MS;
  const { summary } = input;
  if (!summary || summary.outcome === "failed") {
    const backoff = MINUTE_MS * 2 ** Math.min(10, Math.max(0, input.streak - 1));
    return input.tick + Math.min(input.interval, backoff);
  }
  if (summary.outcome === "lease_busy") return nextTick;
  const nextDueAt = readNextDueAt(summary);
  if (nextDueAt === null) return input.claimedNext;
  return Math.max(nextTick, tickFor(Math.min(nextDueAt, input.tick + MAX_GAP_MS)));
}

// ---------------------------------------------------------------------------
// The cron: claim the due tenants and enqueue them
// ---------------------------------------------------------------------------

/** The columns of the due index's WHERE, word for word (migration 0005), so SQLite can use it. */
const SCHEDULABLE = "provision_state = 'ready' AND status <> 'suspended' AND owner_suspended_at IS NULL";

/**
 * The due tenants, earliest first. Its WHERE contains the partial index's
 * (idx_tenants_schedule_due) and ranges over its column, so the plan is an
 * index range scan over the due rows only (test/scheduling.test.ts checks).
 */
export const DUE_SQL = `SELECT id, plan, limit_overrides, schedule_next_at FROM tenants
       WHERE ${SCHEDULABLE}
         AND schedule_next_at <= ?1
         AND (schedule_lease_until IS NULL OR schedule_lease_until <= ?2)
       ORDER BY schedule_next_at LIMIT ?3`;

const CLAIM_SQL = `UPDATE tenants SET schedule_next_at = ?1, schedule_claim = ?2, schedule_running = NULL, schedule_lease_until = ?3
       WHERE id = ?4 AND schedule_next_at = ?5 AND ${SCHEDULABLE}
         AND (schedule_lease_until IS NULL OR schedule_lease_until <= ?6)`;

const UNCLAIM_SQL = `UPDATE tenants SET schedule_next_at = ?1, schedule_claim = NULL, schedule_lease_until = NULL
       WHERE id = ?2 AND schedule_claim = ?3`;

export interface EnqueueResult {
  /** Tenants claimed and sent to the queue. */
  sent: number;
  /** Claims given back because the queue refused the batch. */
  returned: number;
  /** Rounds of up to CLAIM_BATCH. */
  rounds: number;
}

export function runIdFor(tick: number, tenantId: string): string {
  return `s-${tick}-${tenantId}`;
}

/**
 * From the every-minute cron: claims every due tenant (in rounds of 100,
 * one D1 batch and one sendBatch each) and enqueues one message per tenant.
 * A claim is a conditional write, so two crons that overlap never claim one
 * tenant twice. If the queue refuses a batch, its claims are given back and
 * the next cron tries again.
 */
export async function enqueueDue(
  deps: Pick<SchedulingDeps, "db" | "now">,
  queue: Queue<ScheduleMessage>,
  tick: number,
): Promise<EnqueueResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const result: EnqueueResult = { sent: 0, returned: 0, rounds: 0 };
  while (result.sent < MAX_CLAIMS_PER_TICK && now() - started < CLAIM_TIME_BUDGET_MS) {
    const at = now();
    const cutoff = at + DUE_SLACK_MS;
    const thisTick = currentTick(at);
    const due = await deps.db
      .prepare(DUE_SQL)
      .bind(cutoff, at, CLAIM_BATCH)
      .all<{ id: string; plan: string; limit_overrides: string | null; schedule_next_at: number }>();
    if (!due.results.length) break;
    result.rounds++;
    const claims = due.results.map((row) => {
      const record = tenantFromRow({ ...emptyRow, id: row.id, plan: row.plan, limit_overrides: row.limit_overrides });
      const next = nextDueAfterClaim(row.id, row.schedule_next_at, thisTick, intervalMs(record));
      return {
        message: { tenantId: row.id, runId: runIdFor(tick, row.id), dueAt: row.schedule_next_at > 0 ? row.schedule_next_at : at, tick },
        previous: row.schedule_next_at,
        next,
      };
    });
    const written = await deps.db.batch(
      claims.map((c) =>
        deps.db.prepare(CLAIM_SQL).bind(c.next, c.message.runId, at + QUEUE_LEASE_MS, c.message.tenantId, c.previous, at),
      ),
    );
    const claimed = claims.filter((_, i) => (written[i]?.meta.changes ?? 0) > 0);
    if (claimed.length) {
      try {
        await queue.sendBatch(claimed.map((c) => ({ body: c.message })));
        result.sent += claimed.length;
      } catch (error) {
        console.error("[schedule] the queue refused a batch; claims given back", { count: claimed.length, error: errorText(error) });
        await deps.db.batch(claimed.map((c) => deps.db.prepare(UNCLAIM_SQL).bind(c.previous, c.message.tenantId, c.message.runId)));
        result.returned += claimed.length;
        break;
      }
    }
    if (due.results.length < CLAIM_BATCH) break;
  }
  return result;
}

const emptyRow: TenantRow = {
  id: "",
  account_id: "",
  slug: "",
  script_name: "",
  status: "active",
  owner_suspended_at: null,
  plan: "trial",
  provision_state: "ready",
  version: null,
  limit_overrides: null,
  trial_ends_at: null,
};

// ---------------------------------------------------------------------------
// The consumer: run each tenant
// ---------------------------------------------------------------------------

/** What the platform made of one call; the first three are the tenant's own outcomes. */
export type RunOutcome = ScheduledOutcome | "error" | "timeout";

export type ScheduleResult =
  | { kind: "ran"; tenantId: string; outcome: RunOutcome; retried: boolean }
  /** Not run: the message is stale (a newer claim), a duplicate, or the tenant can't run now. */
  | { kind: "skipped"; tenantId: string; reason: "invalid" | "missing" | "stale" | "not_runnable" | "duplicate" };

interface ScheduleRow extends TenantRow {
  schedule_next_at: number;
  schedule_claim: string | null;
}

async function loadForRun(db: D1Database, tenantId: string): Promise<{ record: TenantRecord; nextAt: number; claim: string | null } | null> {
  const row = await db
    .prepare(`SELECT ${TENANT_COLUMNS}, schedule_next_at, schedule_claim FROM tenants WHERE id = ?`)
    .bind(tenantId)
    .first<ScheduleRow>();
  return row ? { record: tenantFromRow(row), nextAt: row.schedule_next_at, claim: row.schedule_claim } : null;
}

function isScheduleMessage(body: unknown): body is ScheduleMessage {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    isTenantId(b.tenantId) &&
    typeof b.runId === "string" &&
    b.runId.length > 0 &&
    b.runId.length <= 200 &&
    Number.isSafeInteger(b.dueAt) &&
    Number.isSafeInteger(b.tick)
  );
}

/** One batch from SCHEDULE_QUEUE: every message at once, each on its own (one slow tenant holds up nobody). */
export async function handleScheduleBatch(deps: SchedulingDeps, batch: MessageBatch<unknown>): Promise<ScheduleResult[]> {
  return Promise.all(
    batch.messages.map(async (message) => {
      try {
        return await runOne(deps, message);
      } catch (error) {
        // The platform's own database failed; the queue tries the message again.
        console.error("[schedule] run threw", { error: errorText(error) });
        message.retry({ delaySeconds: 30 });
        const tenantId = isScheduleMessage(message.body) ? message.body.tenantId : "";
        return { kind: "skipped", tenantId, reason: "invalid" } as const;
      }
    }),
  );
}

async function runOne(deps: SchedulingDeps, message: Message<unknown>): Promise<ScheduleResult> {
  const now = deps.now ?? Date.now;
  if (!isScheduleMessage(message.body)) {
    console.error("[schedule] malformed message dropped");
    message.ack();
    return { kind: "skipped", tenantId: "", reason: "invalid" };
  }
  const msg = message.body;
  const loaded = await loadForRun(deps.db, msg.tenantId);
  if (!loaded) {
    message.ack();
    return { kind: "skipped", tenantId: msg.tenantId, reason: "missing" };
  }
  if (loaded.claim !== msg.runId) {
    message.ack();
    return { kind: "skipped", tenantId: msg.tenantId, reason: "stale" };
  }
  const tenant = loaded.record;
  if (tenant.provisionState !== "ready" || tenant.status === "suspended") {
    message.ack();
    return { kind: "skipped", tenantId: msg.tenantId, reason: "not_runnable" };
  }

  const interval = intervalMs(tenant);
  const timeout = (deps.callTimeoutMs ?? callTimeoutMs)(interval);
  const attempt = Math.max(1, message.attempts);
  const token = `${msg.runId}:${attempt}`;
  const startedAt = now();
  const start = await deps.db
    .prepare(
      `UPDATE tenants SET schedule_running = ?1, schedule_lease_until = ?2
       WHERE id = ?3 AND schedule_claim = ?4 AND (schedule_running IS NULL OR schedule_running <> ?1) AND ${SCHEDULABLE}`,
    )
    .bind(token, startedAt + timeout + RUN_LEASE_MARGIN_MS, tenant.id, msg.runId)
    .run();
  if ((start.meta.changes ?? 0) === 0) {
    // Another delivery of this attempt is running it, or it was suspended or reclaimed a moment ago.
    message.ack();
    return { kind: "skipped", tenantId: tenant.id, reason: "duplicate" };
  }

  const call = await callScheduled(deps, tenant, { runId: msg.runId, scheduledTime: msg.tick, cron: SCHEDULE_CRON }, timeout);
  const finishedAt = now();
  const streak = await recordRun(deps.db, {
    tenantId: tenant.id,
    runId: msg.runId,
    at: startedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    lagMs: Math.max(0, startedAt - msg.dueAt),
    call,
  });

  if (call.kind !== "answered") {
    console.error("[schedule] no answer from tenant", { tenant: tenant.id, run: msg.runId, attempt, outcome: call.kind, error: call.error });
    const delay = RETRY_DELAYS_SECONDS[attempt - 1];
    // Retry only while it can finish, lease and all, before the tenant's next
    // run, which is the retry otherwise; a longer lease would push that run back.
    const retryLease = delay === undefined ? Infinity : finishedAt + delay * 1000 + timeout + RUN_LEASE_MARGIN_MS;
    if (retryLease <= loaded.nextAt) {
      const extended = await deps.db
        .prepare("UPDATE tenants SET schedule_lease_until = ? WHERE id = ? AND schedule_claim = ? AND schedule_running = ?")
        .bind(retryLease, tenant.id, msg.runId, token)
        .run();
      if ((extended.meta.changes ?? 0) > 0) {
        message.retry({ delaySeconds: delay });
        return { kind: "ran", tenantId: tenant.id, outcome: call.kind, retried: true };
      }
    }
  }

  const next = nextDueAfterRun({
    tick: msg.tick,
    claimedNext: loaded.nextAt,
    interval,
    summary: call.kind === "answered" ? call.summary : null,
    streak,
  });
  // A write only when the run moved the tenant to another tick; the claim already set the usual one.
  if (next !== loaded.nextAt) {
    await deps.db
      .prepare("UPDATE tenants SET schedule_next_at = ? WHERE id = ? AND schedule_claim = ? AND schedule_next_at = ?")
      .bind(next, tenant.id, msg.runId, loaded.nextAt)
      .run();
  }
  message.ack();
  return { kind: "ran", tenantId: tenant.id, outcome: call.kind === "answered" ? call.summary.outcome : call.kind, retried: false };
}

type CallResult =
  | { kind: "answered"; summary: ScheduledRunSummary }
  | { kind: "error" | "timeout"; error: string };

/** One POST /__platform/scheduled under `timeoutMs`, aborted when it runs out. */
async function callScheduled(deps: SchedulingDeps, tenant: TenantRecord, body: ScheduledRequest, timeoutMs: number): Promise<CallResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<CallResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout", error: `no answer in ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
  });
  const answered = (async (): Promise<CallResult> => {
    const result = await callTenant(
      deps.dispatcher,
      { tenant, hostedDomain: deps.hostedDomain, platform: deps.capability(tenant) },
      PLATFORM_SCHEDULED_PATH,
      { method: "POST", body, signal: controller.signal },
    );
    if (result.kind === "missing") return { kind: "error", error: `user Worker ${tenant.scriptName} is not in the namespace` };
    if (result.response.status !== 200) {
      await result.response.body?.cancel();
      return { kind: "error", error: `HTTP ${result.response.status}` };
    }
    const parsed = parseSummary(await result.response.json().catch(() => null), body.runId);
    if (!parsed) return { kind: "error", error: "the answer wasn't a run summary" };
    return { kind: "answered", summary: parsed };
  })().catch((error: unknown): CallResult => ({ kind: "error", error: errorText(error) }));
  try {
    return await Promise.race([answered, timedOut]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 1_000_000_000) : 0);

/** The tenant's answer, checked and clamped (it comes from customer code); null when it isn't one. */
export function parseSummary(body: unknown, runId: string): ScheduledRunSummary | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.runId !== runId || !(SCHEDULED_OUTCOMES as readonly unknown[]).includes(b.outcome)) return null;
  return {
    runId,
    outcome: b.outcome as ScheduledOutcome,
    version: typeof b.version === "string" ? b.version.slice(0, 40) : "",
    schemaVersion: count(b.schemaVersion),
    migrationsApplied: count(b.migrationsApplied),
    startedAt: count(b.startedAt),
    durationMs: count(b.durationMs),
    checked: count(b.checked),
    failures: count(b.failures),
    deferred: count(b.deferred),
    d1Queries: count(b.d1Queries),
    ...(typeof b.error === "string" ? { error: b.error.slice(0, 200) } : {}),
    ...("nextDueAt" in b ? { nextDueAt: b.nextDueAt } : {}),
  } as ScheduledRunSummary;
}

/**
 * The summary's `nextDueAt` (epoch ms), which newer bundles send (lane A's
 * contract change): when the tenant's next monitor is due. Null when absent
 * or not a time, and the plan's interval applies.
 */
export function readNextDueAt(summary: object): number | null {
  const value = (summary as { nextDueAt?: unknown }).nextDueAt;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Run metrics
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
/** scheduler_days keeps this many days. */
export const RUN_DAYS_KEPT = 90;

const ROLL_DAY_SQL = `INSERT INTO scheduler_days (tenant_id, day, runs, errors, checked, failures, d1_queries, total_ms, max_ms)
  SELECT tenant_id, day, day_runs, day_errors, day_checked, day_failures, day_d1_queries, day_ms, day_max_ms
  FROM scheduler_stats WHERE tenant_id = ?1 AND day < ?2
  ON CONFLICT(tenant_id, day) DO NOTHING`;

const same = "excluded.day <= scheduler_stats.day";
const RECORD_SQL = `INSERT INTO scheduler_stats (tenant_id, last_run_id, last_at, last_outcome, last_duration_ms, last_tenant_ms, last_lag_ms,
    last_checked, last_failures, last_deferred, last_d1_queries, last_version, last_error, last_ok_at, streak,
    day, day_runs, day_errors, day_checked, day_failures, day_d1_queries, day_ms, day_max_ms)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 1, ?15, ?17, ?18, ?19, ?5, ?5)
  ON CONFLICT(tenant_id) DO UPDATE SET
    last_run_id = excluded.last_run_id, last_at = excluded.last_at, last_outcome = excluded.last_outcome,
    last_duration_ms = excluded.last_duration_ms, last_tenant_ms = excluded.last_tenant_ms, last_lag_ms = excluded.last_lag_ms,
    last_checked = excluded.last_checked, last_failures = excluded.last_failures, last_deferred = excluded.last_deferred,
    last_d1_queries = excluded.last_d1_queries, last_version = COALESCE(excluded.last_version, scheduler_stats.last_version),
    last_error = excluded.last_error, last_ok_at = COALESCE(excluded.last_ok_at, scheduler_stats.last_ok_at),
    streak = CASE excluded.last_outcome WHEN 'ran' THEN 0 WHEN 'lease_busy' THEN scheduler_stats.streak ELSE scheduler_stats.streak + 1 END,
    day = MAX(excluded.day, scheduler_stats.day),
    day_runs = CASE WHEN ${same} THEN scheduler_stats.day_runs + 1 ELSE 1 END,
    day_errors = CASE WHEN ${same} THEN scheduler_stats.day_errors + excluded.day_errors ELSE excluded.day_errors END,
    day_checked = CASE WHEN ${same} THEN scheduler_stats.day_checked + excluded.day_checked ELSE excluded.day_checked END,
    day_failures = CASE WHEN ${same} THEN scheduler_stats.day_failures + excluded.day_failures ELSE excluded.day_failures END,
    day_d1_queries = CASE WHEN ${same} THEN scheduler_stats.day_d1_queries + excluded.day_d1_queries ELSE excluded.day_d1_queries END,
    day_ms = CASE WHEN ${same} THEN scheduler_stats.day_ms + excluded.day_ms ELSE excluded.day_ms END,
    day_max_ms = CASE WHEN ${same} THEN MAX(scheduler_stats.day_max_ms, excluded.day_max_ms) ELSE excluded.day_max_ms END
  RETURNING streak`;

/**
 * Records one call in scheduler_stats: one row per tenant, rewritten, plus a
 * row in scheduler_days the first time a run lands on a new UTC day. Both in
 * one batch, so one round trip. Answers the failures in a row, this run included.
 */
async function recordRun(
  db: D1Database,
  run: { tenantId: string; runId: string; at: number; durationMs: number; lagMs: number; call: CallResult },
): Promise<number> {
  const day = Math.floor(run.at / DAY_MS);
  const call = run.call;
  const s = call.kind === "answered" ? call.summary : null;
  const outcome: RunOutcome = call.kind === "answered" ? call.summary.outcome : call.kind;
  const failed = outcome !== "ran" && outcome !== "lease_busy" ? 1 : 0;
  const error = call.kind === "answered" ? (call.summary.outcome === "failed" ? (call.summary.error ?? "failed") : null) : call.error.slice(0, 200);
  const [, recorded] = await db.batch<{ streak: number }>([
    db.prepare(ROLL_DAY_SQL).bind(run.tenantId, day),
    db
      .prepare(RECORD_SQL)
      .bind(
        run.tenantId,
        run.runId,
        run.at,
        outcome,
        run.durationMs,
        s ? s.durationMs : null,
        run.lagMs,
        s ? s.checked : null,
        s ? s.failures : null,
        s ? s.deferred : null,
        s ? s.d1Queries : null,
        s?.version || null,
        error,
        outcome === "ran" ? run.at : null,
        failed,
        day,
        s ? s.checked : 0,
        s ? s.failures : 0,
        s ? s.d1Queries : 0,
      ),
  ]);
  return recorded?.results[0]?.streak ?? failed;
}

/** Once an hour from the cron: forget days older than RUN_DAYS_KEPT. */
export function schedulerDaysCleanup(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare("DELETE FROM scheduler_days WHERE day < ?").bind(Math.floor(now / DAY_MS) - RUN_DAYS_KEPT);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

// ---------------------------------------------------------------------------
// What the admin console shows
// ---------------------------------------------------------------------------

export interface RunDay {
  /** The UTC day's start (epoch ms). */
  day: number;
  runs: number;
  errors: number;
  checked: number;
  failures: number;
  d1Queries: number;
  avgMs: number;
  maxMs: number;
}

export interface ScheduleView {
  /** When it next runs, or null while it can't (not ready, suspended). */
  nextAt: number | null;
  intervalMs: number;
  /** A run holds the tenant until then. */
  leaseUntil: number | null;
  last: {
    runId: string;
    at: number;
    outcome: RunOutcome;
    durationMs: number;
    tenantMs: number | null;
    lagMs: number;
    checked: number | null;
    failures: number | null;
    deferred: number | null;
    d1Queries: number | null;
    version: string | null;
    error: string | null;
    okAt: number | null;
    streak: number;
  } | null;
  /** Today first, then the days before, newest first. */
  days: RunDay[];
}

/** One tenant's scheduling for the admin console: three reads by primary key. */
export async function scheduleView(db: D1Database, tenant: TenantRecord, days = 7): Promise<ScheduleView> {
  const [row, stats, earlier] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT schedule_next_at, schedule_lease_until FROM tenants WHERE id = ?").bind(tenant.id),
    db.prepare("SELECT * FROM scheduler_stats WHERE tenant_id = ?").bind(tenant.id),
    db
      .prepare("SELECT day, runs, errors, checked, failures, d1_queries, total_ms, max_ms FROM scheduler_days WHERE tenant_id = ? ORDER BY day DESC LIMIT ?")
      .bind(tenant.id, days),
  ]);
  const t = row!.results[0] as { schedule_next_at: number; schedule_lease_until: number | null } | undefined;
  const s = stats!.results[0] as Record<string, number | string | null> | undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const toDay = (d: { day: number; runs: number; errors: number; checked: number; failures: number; d1: number; ms: number; max: number }): RunDay => ({
    day: d.day * DAY_MS,
    runs: d.runs,
    errors: d.errors,
    checked: d.checked,
    failures: d.failures,
    d1Queries: d.d1,
    avgMs: d.runs ? Math.round(d.ms / d.runs) : 0,
    maxMs: d.max,
  });
  const list: RunDay[] = [];
  if (s) {
    list.push(
      toDay({
        day: s.day as number,
        runs: s.day_runs as number,
        errors: s.day_errors as number,
        checked: s.day_checked as number,
        failures: s.day_failures as number,
        d1: s.day_d1_queries as number,
        ms: s.day_ms as number,
        max: s.day_max_ms as number,
      }),
    );
  }
  for (const d of earlier!.results as { day: number; runs: number; errors: number; checked: number; failures: number; d1_queries: number; total_ms: number; max_ms: number }[]) {
    list.push(toDay({ ...d, d1: d.d1_queries, ms: d.total_ms, max: d.max_ms }));
  }
  const runnable = tenant.provisionState === "ready" && tenant.status !== "suspended";
  return {
    nextAt: runnable && t ? t.schedule_next_at : null,
    intervalMs: intervalMs(tenant),
    leaseUntil: t?.schedule_lease_until ?? null,
    last: s
      ? {
          runId: s.last_run_id as string,
          at: s.last_at as number,
          outcome: s.last_outcome as RunOutcome,
          durationMs: s.last_duration_ms as number,
          tenantMs: num(s.last_tenant_ms),
          lagMs: s.last_lag_ms as number,
          checked: num(s.last_checked),
          failures: num(s.last_failures),
          deferred: num(s.last_deferred),
          d1Queries: num(s.last_d1_queries),
          version: (s.last_version as string | null) ?? null,
          error: (s.last_error as string | null) ?? null,
          okAt: num(s.last_ok_at),
          streak: s.streak as number,
        }
      : null,
    days: list.slice(0, days),
  };
}
