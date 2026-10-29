/**
 * The platform's health, for outside monitors (build plan, C4):
 * GET app.<domain>/__health, public, answering 200 when everything is well
 * and 503 when anything isn't, with the detail as JSON, so a plain HTTP
 * monitor can alert on the status code alone and a smarter one can assert on
 * one check (`checks.scheduler.ok`), which is how the public status page
 * shows only the parts customers care about (docs/hosted/OBSERVABILITY.md).
 *
 * Cheap by construction:
 *   - one D1 batch of six reads, each by primary key or over a partial index
 *     that holds only the rows in trouble (overdue or failing tenants), so a
 *     healthy platform reads a handful of rows whatever its size; counts stop
 *     at 1,000 (test/observability.test.ts checks the plans and rows read);
 *   - the answer is shared per Cloudflare location for 10 seconds (the Cache
 *     API) and kept 15 seconds in each isolate, so a flood of checks costs
 *     the database about one batch per location per 10 seconds; with the
 *     HEALTH_RATE_LIMIT binding, one caller past its limit gets a 429;
 *   - never anything per tenant, never a call to a tenant or to Cloudflare,
 *     Stripe or Resend.
 *
 * The public answer is the verdict and each check as a yes or no, nothing
 * else (publicHealth): no counts, versions, times of day or reasons. The full
 * report, with what is wrong in plain words, is the admin console's
 * Operations tab (src/admin/operations.ts).
 */

import { billingSetup } from "../billing/config";
import type { PlatformEnv } from "../env";
import { log } from "../log";
import { mailProblem } from "../mail";
import { provisioningSettings } from "../provisioning-env";
import { MINUTE_MS } from "./metrics";

/** Where the platform serves it, on app.<domain> only. */
export const PLATFORM_HEALTH_ROUTE = "/__health";

/** The answer is reused for this long per isolate. */
export const HEALTH_CACHE_MS = 15_000;
/** The cron runs every minute; a tick older than this means it stopped. */
export const CRON_STALE_MS = 3 * MINUTE_MS;
/** The scheduler's enqueue runs every tick; older than this, the cron runs but can't reach the queue (or its database). */
export const ENQUEUE_STALE_MS = 3 * MINUTE_MS;
/**
 * The oldest tenant still waiting past its due time, beyond which the
 * scheduler is behind. A healthy run is called within about 10 seconds of its
 * tick and holds the tenant for at most its timeout (90 s); a lost queue
 * message frees the tenant after the 3-minute queue lease. 5 minutes is past
 * all of that.
 */
export const LAG_DEGRADED_MS = 5 * MINUTE_MS;
/** A tenant is "overdue" (counted, not alarmed on) once this late. */
export const OVERDUE_MS = 2 * MINUTE_MS;
/** A tenant is failing after this many runs in a row without a clean answer (with the backoff, about 7 minutes). */
export const FAILING_STREAK = 3;
/** This many failing tenants at once is the platform's problem rather than one customer's bundle. */
export const FAILING_DEGRADED = 5;
/** Counts stop here, so a disaster can't make the health check expensive. */
export const COUNT_CAP = 1_000;
/**
 * A rollout or rollback in canary or rolling whose row hasn't changed in this
 * long is stuck: the runner moves the canary along within minutes and a batch
 * of 50 tenants (uploads and up to 5 health checks each) within about 15.
 */
export const RELEASE_STALE_MS = 60 * MINUTE_MS;
/** Shared per Cloudflare location (caches.default) for this long, in front of the isolate's copy. */
export const EDGE_CACHE_SECONDS = 10;

const SCHEDULABLE = "provision_state = 'ready' AND status <> 'suspended' AND owner_suspended_at IS NULL";

/** The cron's and the enqueue's last runs, by primary key. */
export const HEARTBEATS_SQL = "SELECT name, at, detail FROM platform_heartbeats WHERE name IN ('cron', 'enqueue')";
/** The earliest due time among tenants that may run and have run before: the first entry of the due index past 0. */
export const OLDEST_DUE_SQL = `SELECT MIN(schedule_next_at) AS oldest FROM tenants INDEXED BY idx_tenants_schedule_due
  WHERE ${SCHEDULABLE} AND schedule_next_at > 0`;
/**
 * New tenants (due 0, "as soon as it is ready") have no due time of their
 * own; they have been due since their row last changed, which is when they
 * became ready or later, so this never overstates their wait. The due index's
 * 0 entries only, stopped at the cap.
 */
export const OLDEST_NEW_SQL = `SELECT MIN(updated_at) AS oldest FROM (SELECT updated_at FROM tenants INDEXED BY idx_tenants_schedule_due
  WHERE ${SCHEDULABLE} AND schedule_next_at = 0 LIMIT ${COUNT_CAP})`;
/**
 * Tenants past due by OVERDUE_MS, new ones included: a range of the due index
 * over the late entries only (0 sorts first, and a new tenant counts once it
 * has been ready that long), stopped at the cap.
 */
export const OVERDUE_SQL = `SELECT COUNT(*) AS n FROM (SELECT 1 FROM tenants INDEXED BY idx_tenants_schedule_due
  WHERE ${SCHEDULABLE} AND schedule_next_at <= ?1 AND (schedule_next_at > 0 OR updated_at <= ?1) LIMIT ${COUNT_CAP})`;
/**
 * Failing tenants that may run: the failing index (only tenants with a
 * streak), then each one's tenant row by primary key. CROSS JOIN keeps that
 * order, so the tenants table is never scanned.
 */
export const FAILING_SQL = `SELECT COUNT(*) AS n FROM (SELECT 1 FROM scheduler_stats s INDEXED BY idx_scheduler_stats_failing
  CROSS JOIN tenants t ON t.id = s.tenant_id
  WHERE s.streak > 0 AND s.streak >= ?1 AND t.${SCHEDULABLE.replaceAll(" AND ", " AND t.")} LIMIT ${COUNT_CAP})`;
/** The newest minute with a recorded run: the table's last primary key. */
export const LAST_RUN_SQL = "SELECT MAX(minute) AS minute FROM scheduler_minutes";
/** The release in progress, if any: the partial index holds only active releases (at most one). */
export const ACTIVE_RELEASE_SQL = `SELECT id, kind, version, state, batch, updated_at FROM releases INDEXED BY idx_releases_active
  WHERE dry_run = 0 AND state IN ('canary', 'rolling', 'paused')`;

export type HeartbeatName = "cron" | "enqueue";

/** The cron's (or the enqueue's) "I ran": one row rewritten, by primary key. */
export function heartbeatStatement(db: D1Database, name: HeartbeatName, at: number, detail?: Record<string, number>): D1PreparedStatement {
  return db
    .prepare("INSERT INTO platform_heartbeats (name, at, detail) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO UPDATE SET at = excluded.at, detail = excluded.detail")
    .bind(name, at, detail ? JSON.stringify(detail) : null);
}

/** What the platform database says right now, for the health check and the Operations tab. */
export interface PlatformState {
  cronAt: number | null;
  enqueueAt: number | null;
  enqueue: { sent: number; returned: number } | null;
  /** The earliest due time of a tenant that may run (epoch ms; for a new tenant, when its row last changed), or null when there is none. */
  oldestDueAt: number | null;
  /** Tenants past due by OVERDUE_MS, up to COUNT_CAP. */
  overdue: number;
  /** Tenants with FAILING_STREAK or more runs in a row without a clean answer, up to COUNT_CAP. */
  failing: number;
  /** The start of the newest minute with a recorded run (epoch ms). */
  lastRunAt: number | null;
  release: { id: string; kind: string; version: string; state: string; batch: number; updatedAt: number } | null;
}

const minOf = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

/** One D1 batch; every statement reads by primary key or over a partial index of the rows in trouble. */
export async function readPlatformState(db: D1Database, now: number): Promise<PlatformState> {
  const [beats, oldest, oldestNew, overdue, failing, lastRun, release] = await db.batch<Record<string, unknown>>([
    db.prepare(HEARTBEATS_SQL),
    db.prepare(OLDEST_DUE_SQL),
    db.prepare(OLDEST_NEW_SQL),
    db.prepare(OVERDUE_SQL).bind(now - OVERDUE_MS),
    db.prepare(FAILING_SQL).bind(FAILING_STREAK),
    db.prepare(LAST_RUN_SQL),
    db.prepare(ACTIVE_RELEASE_SQL),
  ]);
  const beat = (name: string) => (beats!.results as { name: string; at: number; detail: string | null }[]).find((b) => b.name === name);
  const enqueueBeat = beat("enqueue");
  let enqueue: PlatformState["enqueue"] = null;
  try {
    const parsed = enqueueBeat?.detail ? (JSON.parse(enqueueBeat.detail) as { sent?: unknown; returned?: unknown }) : null;
    if (parsed) enqueue = { sent: Number(parsed.sent) || 0, returned: Number(parsed.returned) || 0 };
  } catch {
    enqueue = null;
  }
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const r = release!.results[0] as { id: string; kind: string; version: string; state: string; batch: number; updated_at: number } | undefined;
  const lastMinute = num((lastRun!.results[0] as { minute?: unknown } | undefined)?.minute);
  return {
    cronAt: beat("cron")?.at ?? null,
    enqueueAt: enqueueBeat?.at ?? null,
    enqueue,
    oldestDueAt: minOf(num((oldest!.results[0] as { oldest?: unknown } | undefined)?.oldest), num((oldestNew!.results[0] as { oldest?: unknown } | undefined)?.oldest)),
    overdue: num((overdue!.results[0] as { n?: unknown } | undefined)?.n) ?? 0,
    failing: num((failing!.results[0] as { n?: unknown } | undefined)?.n) ?? 0,
    lastRunAt: lastMinute === null ? null : lastMinute * MINUTE_MS,
    release: r ? { id: r.id, kind: r.kind, version: r.version, state: r.state, batch: r.batch, updatedAt: r.updated_at } : null,
  };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export interface HealthChecks {
  database: { ok: boolean };
  cron: { ok: boolean | null; lastTickAt: string | null; ageSeconds: number | null };
  queue: { ok: boolean | null; lastEnqueueAt: string | null; ageSeconds: number | null; sent: number | null; returned: number | null };
  scheduler: { ok: boolean | null; oldestOverdueSeconds: number | null; overdueTenants: number | null; lastRunAt: string | null };
  tenants: { ok: boolean | null; failing: number | null; threshold: number };
  release: { ok: boolean | null; inProgress: boolean | null; kind: string | null; state: string | null; version: string | null; batch: number | null };
  config: { ok: boolean; mail: boolean; billing: boolean; provisioning: boolean };
}

export interface HealthReport {
  ok: boolean;
  status: "ok" | "degraded";
  service: "openping-platform";
  checkedAt: string;
  /** How long this answer may be reused (the isolate keeps it this long). */
  maxAgeSeconds: number;
  /** One short sentence per failing check, for people reading it. */
  problems: string[];
  checks: HealthChecks;
}

/** Whether mail, billing and provisioning have every setting they need. Booleans only. */
export function configChecks(env: PlatformEnv): HealthChecks["config"] {
  const mail = mailProblem(env) === null;
  // A stand-in client: this only asks whether the settings are complete, it never calls Stripe.
  const billing = billingSetup(env, () => ({}) as never).ok;
  const provisioning = provisioningSettings(env).ok;
  return { ok: mail && billing && provisioning, mail, billing, provisioning };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const ageSeconds = (now: number, at: number | null) => (at === null ? null : Math.max(0, Math.round((now - at) / 1000)));

function minutesText(ms: number): string {
  const m = Math.round(ms / MINUTE_MS);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

/** The report from the database's state (null when the database didn't answer) and the settings. */
export function healthReport(state: PlatformState | null, config: HealthChecks["config"], now: number): HealthReport {
  const problems: string[] = [];
  let checks: HealthChecks;
  if (!state) {
    problems.push("The platform database didn't answer.");
    checks = {
      database: { ok: false },
      cron: { ok: null, lastTickAt: null, ageSeconds: null },
      queue: { ok: null, lastEnqueueAt: null, ageSeconds: null, sent: null, returned: null },
      scheduler: { ok: null, oldestOverdueSeconds: null, overdueTenants: null, lastRunAt: null },
      tenants: { ok: null, failing: null, threshold: FAILING_DEGRADED },
      release: { ok: null, inProgress: null, kind: null, state: null, version: null, batch: null },
      config,
    };
  } else {
    const cronOk = state.cronAt !== null && now - state.cronAt <= CRON_STALE_MS;
    if (!cronOk) problems.push(state.cronAt === null ? "The cron has never run." : `The cron's last tick was ${minutesText(now - state.cronAt)} ago.`);
    const queueFresh = state.enqueueAt !== null && now - state.enqueueAt <= ENQUEUE_STALE_MS;
    // The enqueue writes its heartbeat even when the queue refused everything it claimed: that is a failure too.
    const queueRefused = queueFresh && state.enqueue !== null && state.enqueue.returned > 0 && state.enqueue.sent === 0;
    const queueOk = queueFresh && !queueRefused;
    if (!queueFresh) {
      problems.push(state.enqueueAt === null ? "The scheduler has never enqueued." : `The scheduler last enqueued ${minutesText(now - state.enqueueAt)} ago.`);
    } else if (queueRefused) {
      problems.push("The queue refused the scheduler's last batch.");
    }
    const overdueMs = state.oldestDueAt === null ? 0 : Math.max(0, now - state.oldestDueAt);
    const schedulerOk = overdueMs <= LAG_DEGRADED_MS;
    if (!schedulerOk) problems.push(`The scheduler is behind: a tenant has waited ${minutesText(overdueMs)} past its due time.`);
    const tenantsOk = state.failing < FAILING_DEGRADED;
    if (!tenantsOk) problems.push(`${state.failing >= COUNT_CAP ? `${COUNT_CAP} or more` : state.failing} tenants' scheduled runs keep failing.`);
    const releaseStuck = state.release !== null && state.release.state !== "paused" && now - state.release.updatedAt > RELEASE_STALE_MS;
    const releaseOk = state.release?.state !== "paused" && !releaseStuck;
    const releaseName = state.release ? `${state.release.kind === "rollback" ? "rollback to" : "rollout of"} ${state.release.version}` : "";
    if (state.release?.state === "paused") problems.push(`The ${releaseName} is paused and needs the owner.`);
    else if (releaseStuck) problems.push(`The ${releaseName} hasn't moved in ${minutesText(now - state.release!.updatedAt)}.`);
    checks = {
      database: { ok: true },
      cron: { ok: cronOk, lastTickAt: iso(state.cronAt), ageSeconds: ageSeconds(now, state.cronAt) },
      queue: {
        ok: queueOk,
        lastEnqueueAt: iso(state.enqueueAt),
        ageSeconds: ageSeconds(now, state.enqueueAt),
        sent: state.enqueue?.sent ?? null,
        returned: state.enqueue?.returned ?? null,
      },
      scheduler: { ok: schedulerOk, oldestOverdueSeconds: Math.round(overdueMs / 1000), overdueTenants: state.overdue, lastRunAt: iso(state.lastRunAt) },
      tenants: { ok: tenantsOk, failing: state.failing, threshold: FAILING_DEGRADED },
      release: {
        ok: releaseOk,
        inProgress: state.release !== null,
        kind: state.release?.kind ?? null,
        state: state.release?.state ?? null,
        version: state.release?.version ?? null,
        batch: state.release?.batch ?? null,
      },
      config,
    };
  }
  if (!config.ok) {
    const off = (["mail", "billing", "provisioning"] as const).filter((k) => !config[k]);
    problems.push(`Not configured: ${off.join(", ")}.`);
  }
  const ok = problems.length === 0;
  return {
    ok,
    status: ok ? "ok" : "degraded",
    service: "openping-platform",
    checkedAt: new Date(now).toISOString(),
    maxAgeSeconds: HEALTH_CACHE_MS / 1000,
    problems,
    checks,
  };
}

// ---------------------------------------------------------------------------
// The endpoint, cached per isolate
// ---------------------------------------------------------------------------

let cached: { at: number; report: HealthReport } | null = null;

/** Tests only. */
export function clearHealthCache(): void {
  cached = null;
}

async function compute(env: PlatformEnv, now: number): Promise<HealthReport> {
  let state: PlatformState | null = null;
  try {
    state = await readPlatformState(env.PLATFORM_DB, now);
  } catch (error) {
    log.error("health.db_failed", { path: "/__health", error });
  }
  const report = healthReport(state, configChecks(env), now);
  // Once per computation (at most about once per isolate per 15 s), and only when something is wrong.
  if (!report.ok) log.warn("health.degraded", { problems: report.problems });
  return report;
}

/**
 * The current report: the isolate's copy while it is fresh, else a new one.
 * Only the finished report is shared between requests, never a pending
 * promise, since Workers ties I/O to the request that started it.
 */
export async function platformHealth(env: PlatformEnv, now: number): Promise<HealthReport> {
  if (cached && now >= cached.at && now - cached.at < HEALTH_CACHE_MS) return cached.report;
  const report = await compute(env, now);
  cached = { at: now, report };
  return report;
}

/** What the public endpoint says: the verdict and each check as a yes or no; no counts, versions or reasons (those are on the Operations tab). */
export interface PublicHealth {
  ok: boolean;
  status: "ok" | "degraded";
  service: "openping-platform";
  checkedAt: string;
  maxAgeSeconds: number;
  checks: Record<keyof HealthChecks, boolean | null>;
}

export function publicHealth(report: HealthReport): PublicHealth {
  const checks = Object.fromEntries(Object.entries(report.checks).map(([name, check]) => [name, check.ok])) as PublicHealth["checks"];
  return { ok: report.ok, status: report.status, service: report.service, checkedAt: report.checkedAt, maxAgeSeconds: EDGE_CACHE_SECONDS, checks };
}

const CLIENT_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" };

/** The location's cache, where the Worker has one (not in every test or local setup). */
export function defaultEdgeCache(): Cache | null {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

/**
 * `make()`'s answer, shared by every isolate in this Cloudflare location for
 * EDGE_CACHE_SECONDS through the Cache API, so a burst of checks reaches the
 * database about once per location per 10 seconds instead of once per
 * request. What the client gets is always `no-store`; only the cache's own
 * copy has a max-age. Any cache failure falls through to `make()`.
 */
export async function edgeCached(key: string, cache: Cache | null, make: () => Promise<{ status: number; body: unknown }>): Promise<Response> {
  if (cache) {
    try {
      const hit = await cache.match(key);
      const status = Number(hit?.headers.get("x-health-status"));
      if (hit && status >= 200 && status <= 599) return new Response(hit.body, { status, headers: { ...CLIENT_HEADERS, "x-health-cache": "hit" } });
      await hit?.body?.cancel();
    } catch {
      // A cache that fails is a cache miss.
    }
  }
  const { status, body } = await make();
  const text = JSON.stringify(body);
  if (cache) {
    try {
      // Stored as a 200 with the real status beside it: a cache keeps a 503 for no one, and the outage is when the cache matters most.
      await cache.put(
        key,
        new Response(text, {
          status: 200,
          headers: { "content-type": CLIENT_HEADERS["content-type"], "cache-control": `public, max-age=${EDGE_CACHE_SECONDS}`, "x-health-status": String(status) },
        }),
      );
    } catch {
      // Not cached this time; the isolate's copy still holds.
    }
  }
  return new Response(text, { status, headers: { ...CLIENT_HEADERS, "x-health-cache": "miss" } });
}

/** The one key per location for each endpoint, whatever the query string. */
export function edgeCacheKey(url: string, path: string): string {
  return `${new URL(url).origin}${path}`;
}

export interface HealthEndpointDeps {
  now: number;
  /** caches.default; null turns the shared cache off (tests). */
  cache: Cache | null;
  /** The caller's address, for the rate limit. */
  clientIp: string | null;
}

/** Per caller (an IPv6 address's /64), when the HEALTH_RATE_LIMIT binding exists: 429 past its limit. Never fails the check itself. */
async function rateLimited(env: PlatformEnv, ip: string | null): Promise<Response | null> {
  if (!env.HEALTH_RATE_LIMIT || !ip) return null;
  const key = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
  try {
    const { success } = await env.HEALTH_RATE_LIMIT.limit({ key });
    if (success) return null;
  } catch {
    return null;
  }
  return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { ...CLIENT_HEADERS, "retry-after": "10" } });
}

/** GET /__health: 200 when every check passes, 503 when any doesn't, with each check as a yes or no. */
export async function healthResponse(env: PlatformEnv, request: Request, deps: HealthEndpointDeps): Promise<Response> {
  const limited = await rateLimited(env, deps.clientIp);
  if (limited) return limited;
  return edgeCached(edgeCacheKey(request.url, PLATFORM_HEALTH_ROUTE), deps.cache, async () => {
    const report = await platformHealth(env, deps.now);
    return { status: report.ok ? 200 : 503, body: publicHealth(report) };
  });
}

/** GET /healthz: the Worker runs and its database answers; behind the same location cache and rate limit, so an outage logs about once per location per 10 seconds. */
export async function livenessResponse(env: PlatformEnv, request: Request, deps: HealthEndpointDeps): Promise<Response> {
  const limited = await rateLimited(env, deps.clientIp);
  if (limited) return limited;
  return edgeCached(edgeCacheKey(request.url, "/healthz"), deps.cache, async () => {
    try {
      await env.PLATFORM_DB.prepare("SELECT 1").first();
      return { status: 200, body: { ok: true, service: "openping-platform", db: "ok" } };
    } catch (error) {
      log.error("health.db_failed", { path: "/healthz", error });
      return { status: 503, body: { ok: false, service: "openping-platform", db: "error" } };
    }
  });
}
