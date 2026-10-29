import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PlatformCapability } from "../../src/shared/hosted-contract";
import { createApp } from "../src/app";
import type { PlatformEnv } from "../src/env";
import { generateMasterKey } from "../src/keys";
import { captureLogs, type LogLine } from "../src/log";
import {
  ACTIVE_RELEASE_SQL,
  COUNT_CAP,
  CRON_STALE_MS,
  FAILING_DEGRADED,
  FAILING_SQL,
  FAILING_STREAK,
  HEALTH_CACHE_MS,
  HEARTBEATS_SQL,
  LAG_DEGRADED_MS,
  LAST_RUN_SQL,
  OLDEST_DUE_SQL,
  OLDEST_NEW_SQL,
  OVERDUE_SQL,
  OVERDUE_MS,
  RELEASE_STALE_MS,
  clearHealthCache,
  configChecks,
  healthReport,
  heartbeatStatement,
  platformHealth,
  readPlatformState,
  type PublicHealth,
} from "../src/observability/health";
import {
  DURATION_BUCKETS_MS,
  HOURS_SQL,
  MINUTE_MS,
  MINUTES_KEPT_DAYS,
  OLD_MINUTES_SQL,
  WINDOW_SQL,
  bucketOf,
  quantileFromBuckets,
  rateMinutes,
  runMetrics,
  runMinuteStatements,
  schedulerMinutesCleanup,
  type RunSample,
} from "../src/observability/metrics";
import { FakeDispatcher } from "./fake-dispatcher";

const DOMAIN = "openping.test";
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const db = env.PLATFORM_DB;

/** Every setting mail, billing and provisioning need, made up (nothing is called). */
const CONFIGURED: Partial<PlatformEnv> = {
  RESEND_API_KEY: "re_test_123",
  MAIL_FROM: `OpenPing Hosted <signin@${DOMAIN}>`,
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_123",
  STRIPE_PRICE_HOSTED: "price_hosted1",
  STRIPE_PRICE_FAST: "price_fast12",
  STRIPE_PRICE_MONITOR_PACK: "price_mpack1",
  STRIPE_PRICE_FAST_PACK: "price_fpack1",
  DISPATCH_NAMESPACE: "openping-tenants",
  BUNDLES: {} as R2Bucket,
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CF_API_TOKEN: "token",
  PLATFORM_KEY: generateMasterKey(),
  HANDOFF_PUBLIC_KEY: "A".repeat(43),
};

function platformEnv(over: Partial<PlatformEnv> = {}): PlatformEnv {
  return { ...(env as unknown as PlatformEnv), ...CONFIGURED, ...over };
}

let seq = 0;
async function tenant(options: { nextAt?: number; status?: string; state?: string; ownerSuspended?: boolean; streak?: number; updatedAt?: number } = {}): Promise<string> {
  seq++;
  const id = `obs${String(seq).padStart(13, "0")}`;
  const account = `acc_obs${seq}`;
  await db.batch([
    db.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, 0, 0)").bind(account, `o${seq}@example.com`),
    db
      .prepare(
        `INSERT INTO tenants (id, account_id, slug, script_name, status, plan, provision_state, schedule_next_at, owner_suspended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'hosted', ?, ?, ?, 0, ?)`,
      )
      .bind(id, account, `obs${seq}`, `t-${id}`, options.status ?? "active", options.state ?? "ready", options.nextAt ?? T0 + 5 * MINUTE_MS, options.ownerSuspended ? T0 : null, options.updatedAt ?? T0 - 30_000),
  ]);
  if (options.streak !== undefined) {
    await db
      .prepare(
        `INSERT INTO scheduler_stats (tenant_id, last_run_id, last_at, last_outcome, last_duration_ms, last_lag_ms, streak, day, day_runs, day_errors, day_checked, day_failures, day_d1_queries, day_ms, day_max_ms)
         VALUES (?, 'r', ?, ?, 100, 0, ?, 0, 1, 0, 0, 0, 0, 100, 100)`,
      )
      .bind(id, T0, options.streak > 0 ? "error" : "ran", options.streak)
      .run();
  }
  return id;
}

/** The cron and the enqueue ran `ago` ms before T0. */
async function beats(ago = 30_000) {
  await db.batch([heartbeatStatement(db, "cron", T0 - ago), heartbeatStatement(db, "enqueue", T0 - ago, { sent: 2, returned: 0 })]);
}

async function release(state: string) {
  await db
    .prepare(
      `INSERT INTO releases (id, kind, version, state, batch_size, batch, requested_by, created_at, updated_at)
       VALUES (?, 'rollout', '0.17.0', ?, 50, 1, 'cli', ?, ?)`,
    )
    .bind(`rel_${state}`, state, T0, T0)
    .run();
}

const report = (over: Partial<PlatformEnv> = {}, now = T0) => platformHealth(platformEnv(over), now);

beforeAll(async () => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  clearHealthCache();
  await db.batch([
    db.prepare("DELETE FROM platform_heartbeats"),
    db.prepare("DELETE FROM scheduler_minutes"),
    db.prepare("DELETE FROM scheduler_stats"),
    db.prepare("DELETE FROM release_tenants"),
    db.prepare("DELETE FROM releases"),
    db.prepare("DELETE FROM tenants"),
    db.prepare("DELETE FROM accounts"),
  ]);
});

let restoreLogs: (() => void) | null = null;
afterEach(() => {
  restoreLogs?.();
  restoreLogs = null;
});

// ---------------------------------------------------------------------------
// The health endpoint's states
// ---------------------------------------------------------------------------

describe("the platform health check", () => {
  it("is ok when the cron is fresh, nobody is overdue or failing, and everything is configured", async () => {
    await beats();
    await tenant();
    const r = await report();
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ ok: true, status: "ok", service: "openping-platform", maxAgeSeconds: 15 });
    expect(r.checks).toEqual({
      database: { ok: true },
      cron: { ok: true, lastTickAt: new Date(T0 - 30_000).toISOString(), ageSeconds: 30 },
      queue: { ok: true, lastEnqueueAt: new Date(T0 - 30_000).toISOString(), ageSeconds: 30, sent: 2, returned: 0 },
      scheduler: { ok: true, oldestOverdueSeconds: 0, overdueTenants: 0, lastRunAt: null },
      tenants: { ok: true, failing: 0, threshold: FAILING_DEGRADED },
      release: { ok: true, inProgress: false, kind: null, state: null, version: null, batch: null },
      config: { ok: true, mail: true, billing: true, provisioning: true },
    });
  });

  it("is degraded when the database doesn't answer, and says only that", async () => {
    const broken = { ...db, batch: async () => Promise.reject(new Error("D1_ERROR: network")) } as unknown as D1Database;
    const lines: LogLine[] = [];
    restoreLogs = captureLogs((l) => lines.push(l));
    const r = await report({ PLATFORM_DB: broken });
    expect(r.ok).toBe(false);
    expect(r.checks.database).toEqual({ ok: false });
    expect(r.checks.cron.ok).toBeNull();
    expect(r.checks.scheduler.ok).toBeNull();
    expect(r.problems).toEqual(["The platform database didn't answer."]);
    expect(lines.map((l) => l.event)).toEqual(["health.db_failed", "health.degraded"]);
  });

  it("is degraded when the cron has never run, or stopped more than 3 minutes ago", async () => {
    expect((await report()).checks.cron).toEqual({ ok: false, lastTickAt: null, ageSeconds: null });
    expect((await report()).problems).toContain("The cron has never run.");
    clearHealthCache();
    await beats(CRON_STALE_MS + 60_000);
    const r = await report();
    expect(r.checks.cron.ok).toBe(false);
    expect(r.checks.queue.ok).toBe(false);
    expect(r.problems).toContain("The cron's last tick was 4 minutes ago.");
    // Exactly 3 minutes is still fresh: a tick can land a few seconds late.
    clearHealthCache();
    await beats(CRON_STALE_MS);
    expect((await report()).ok).toBe(true);
  });

  it("tells a cron that can't reach the queue from one that stopped", async () => {
    await db.batch([heartbeatStatement(db, "cron", T0 - 20_000), heartbeatStatement(db, "enqueue", T0 - 10 * MINUTE_MS, { sent: 0, returned: 0 })]);
    const r = await report();
    expect(r.checks.cron.ok).toBe(true);
    expect(r.checks.queue.ok).toBe(false);
    expect(r.problems).toEqual(["The scheduler last enqueued 10 minutes ago."]);
  });

  it("measures queue lag as the oldest due tenant's wait, and alarms past 5 minutes", async () => {
    await beats();
    await tenant({ nextAt: T0 - 90_000 }); // a run in progress: late, not overdue
    let r = await report();
    expect(r.ok).toBe(true);
    expect(r.checks.scheduler).toMatchObject({ ok: true, oldestOverdueSeconds: 90, overdueTenants: 0 });

    clearHealthCache();
    await tenant({ nextAt: T0 - OVERDUE_MS - 1 });
    await tenant({ nextAt: T0 - LAG_DEGRADED_MS - 60_000 });
    r = await report();
    expect(r.ok).toBe(false);
    expect(r.checks.scheduler).toMatchObject({ ok: false, oldestOverdueSeconds: 360, overdueTenants: 2 });
    expect(r.problems).toEqual(["The scheduler is behind: a tenant has waited 6 minutes past its due time."]);
  });

  it("never counts a tenant that may not run (suspended, paused by the owner, not ready) as overdue", async () => {
    await beats();
    const long = T0 - 60 * MINUTE_MS;
    await tenant({ nextAt: long, status: "suspended" });
    await tenant({ nextAt: long, ownerSuspended: true });
    await tenant({ nextAt: long, state: "uploaded" });
    // A tenant that just became ready (due 0) is the cron's next claim, not lag.
    await tenant({ nextAt: 0, updatedAt: T0 - 30_000 });
    const r = await report();
    expect(r.ok).toBe(true);
    expect(r.checks.scheduler).toMatchObject({ oldestOverdueSeconds: 30, overdueTenants: 0 });
  });

  it("counts a new tenant that never gets its first run, from when it became ready", async () => {
    await beats();
    await tenant({ nextAt: 0, updatedAt: T0 - 3 * MINUTE_MS });
    let r = await report();
    expect(r.checks.scheduler).toMatchObject({ ok: true, oldestOverdueSeconds: 180, overdueTenants: 1 });
    clearHealthCache();
    await tenant({ nextAt: 0, updatedAt: T0 - 20 * MINUTE_MS });
    r = await report();
    expect(r.checks.scheduler).toMatchObject({ ok: false, oldestOverdueSeconds: 1200, overdueTenants: 2 });
  });

  it("is degraded when the queue refused the scheduler's last batch, though the enqueue ran", async () => {
    await db.batch([heartbeatStatement(db, "cron", T0 - 20_000), heartbeatStatement(db, "enqueue", T0 - 20_000, { sent: 0, returned: 40 })]);
    let r = await report();
    expect(r.checks.queue).toMatchObject({ ok: false, sent: 0, returned: 40 });
    expect(r.problems).toEqual(["The queue refused the scheduler's last batch."]);
    // Some sent and some given back is a partial hiccup the next tick retries, not an outage.
    clearHealthCache();
    await heartbeatStatement(db, "enqueue", T0 - 20_000, { sent: 100, returned: 40 }).run();
    r = await report();
    expect(r.checks.queue.ok).toBe(true);
  });

  it("counts tenants failing 3 runs in a row, and alarms at 5 of them", async () => {
    await beats();
    for (let i = 0; i < FAILING_DEGRADED - 1; i++) await tenant({ streak: FAILING_STREAK });
    await tenant({ streak: FAILING_STREAK - 1 }); // not yet
    await tenant({ streak: 0 });
    await tenant({ streak: 9, status: "suspended" }); // can't run, so it isn't failing now
    let r = await report();
    expect(r.checks.tenants).toEqual({ ok: true, failing: FAILING_DEGRADED - 1, threshold: FAILING_DEGRADED });
    expect(r.ok).toBe(true);
    clearHealthCache();
    await tenant({ streak: 12 });
    r = await report();
    expect(r.checks.tenants).toEqual({ ok: false, failing: FAILING_DEGRADED, threshold: FAILING_DEGRADED });
    expect(r.problems).toEqual([`${FAILING_DEGRADED} tenants' scheduled runs keep failing.`]);
  });

  it("shows a release in progress, and alarms when it is paused for the owner", async () => {
    await beats();
    await release("canary");
    let r = await report();
    expect(r.ok).toBe(true);
    expect(r.checks.release).toEqual({ ok: true, inProgress: true, kind: "rollout", state: "canary", version: "0.17.0", batch: 1 });
    clearHealthCache();
    await db.prepare("UPDATE releases SET state = 'paused'").run();
    r = await report();
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(["The rollout of 0.17.0 is paused and needs the owner."]);
    // Rolling, but nothing has moved for over an hour: stuck.
    clearHealthCache();
    await db.prepare("UPDATE releases SET state = 'rolling', updated_at = ?").bind(T0 - RELEASE_STALE_MS - 60_000).run();
    r = await report();
    expect(r.checks.release.ok).toBe(false);
    expect(r.problems).toEqual(["The rollout of 0.17.0 hasn't moved in 61 minutes."]);
    clearHealthCache();
    await db.prepare("UPDATE releases SET updated_at = ?").bind(T0 - RELEASE_STALE_MS + 60_000).run();
    expect((await report()).checks.release.ok).toBe(true);
    // A finished release isn't in progress.
    clearHealthCache();
    await db.prepare("UPDATE releases SET state = 'done'").run();
    expect((await report()).checks.release.inProgress).toBe(false);
  });

  it("says whether mail, billing and provisioning are configured, as yes or no only", async () => {
    await beats();
    const r = await report({ RESEND_API_KEY: undefined, STRIPE_WEBHOOK_SECRET: "", CF_API_TOKEN: undefined });
    expect(r.checks.config).toEqual({ ok: false, mail: false, billing: false, provisioning: false });
    expect(r.problems).toEqual(["Not configured: mail, billing, provisioning."]);
    // Never which setting, never a value.
    const text = JSON.stringify(r);
    for (const leak of ["RESEND", "STRIPE", "CF_", "sk_test", "whsec", "re_test", "token"]) expect(text).not.toContain(leak);
    expect(configChecks(platformEnv()).ok).toBe(true);
  });

  it("reuses its answer for 15 seconds per isolate, then looks again", async () => {
    await beats();
    expect((await report({}, T0)).ok).toBe(true);
    await db.prepare("DELETE FROM platform_heartbeats").run();
    expect((await report({}, T0 + HEALTH_CACHE_MS - 1)).ok).toBe(true);
    expect((await report({}, T0 + HEALTH_CACHE_MS)).ok).toBe(false);
    // A clock that went backwards never serves an answer from the future.
    clearHealthCache();
    await beats();
    await report({}, T0 + 1_000);
    await db.prepare("DELETE FROM platform_heartbeats").run();
    expect((await report({}, T0)).ok).toBe(false);
  });

  it("stops counting at 1,000 so a disaster can't make it expensive", () => {
    const r = healthReport(
      { cronAt: T0, enqueueAt: T0, enqueue: null, oldestDueAt: T0, overdue: COUNT_CAP, failing: COUNT_CAP, lastRunAt: null, release: null },
      { ok: true, mail: true, billing: true, provisioning: true },
      T0,
    );
    expect(r.problems).toEqual([`${COUNT_CAP} or more tenants' scheduled runs keep failing.`]);
  });
});

describe("GET app.<domain>/__health and /healthz", () => {
  const appWith = (edgeCache: Cache | null) =>
    createApp({ dispatcher: () => new FakeDispatcher(), capability: () => ({}) as PlatformCapability, now: () => T0, edgeCache });
  const app = appWith(null);

  async function get(host: string, path = "/__health", over: Partial<PlatformEnv> = {}, a = app, ip = "192.0.2.7") {
    const ctx = createExecutionContext();
    const res = await a.fetch(new Request(`https://${host}${path}`, { headers: { "cf-connecting-ip": ip } }), platformEnv(over), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("answers 200 with each check as a yes or no, and nothing else, uncached by anything between", async () => {
    await beats();
    await tenant({ streak: 4 });
    await release("rolling");
    const res = await get(`app.${DOMAIN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as PublicHealth;
    expect(body).toEqual({
      ok: true,
      status: "ok",
      service: "openping-platform",
      checkedAt: new Date(T0).toISOString(),
      maxAgeSeconds: 10,
      checks: { database: true, cron: true, queue: true, scheduler: true, tenants: true, release: true, config: true },
    });
  });

  it("answers 503 when it isn't, so a plain HTTP monitor alerts on the status alone, and never says why in public", async () => {
    await release("paused");
    for (let i = 0; i < FAILING_DEGRADED; i++) await tenant({ streak: 7 });
    const res = await get(`app.${DOMAIN}`, "/__health", { STRIPE_WEBHOOK_SECRET: "" });
    expect(res.status).toBe(503);
    const text = await res.text();
    const body = JSON.parse(text) as PublicHealth;
    expect(body).toMatchObject({ ok: false, status: "degraded" });
    // The part a public status page watches is in the JSON, at a stable path.
    expect(body.checks).toMatchObject({ scheduler: true, cron: false, tenants: false, release: false, config: false });
    // No counts, versions, reasons or setting names.
    for (const leak of ["0.17.0", "problems", "failing", "billing", "STRIPE", "sent", String(FAILING_DEGRADED)]) expect(text).not.toContain(leak);
  });

  it("is only on the platform's own host, never on a customer's", async () => {
    const res = await get(`acme.${DOMAIN}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("openping-platform");
  });

  it("needs no sign-in, and the liveness check beside it still answers", async () => {
    await beats();
    expect((await get(`app.${DOMAIN}`)).status).toBe(200);
    const live = await get(`app.${DOMAIN}`, "/healthz");
    expect(live.status).toBe(200);
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(await live.json()).toEqual({ ok: true, service: "openping-platform", db: "ok" });
  });

  it("shares each answer per location for 10 seconds, so a burst reaches the database once", async () => {
    const cache = await caches.open(`health-${crypto.randomUUID()}`);
    const cachedApp = appWith(cache);
    await beats();
    let batches = 0;
    let firsts = 0;
    const counting = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") return (s: D1PreparedStatement[]) => (batches++, target.batch(s));
        if (prop === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (sql === "SELECT 1") {
              return { first: () => (firsts++, statement.first()) } as unknown as D1PreparedStatement;
            }
            return statement;
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    for (let i = 0; i < 20; i++) {
      clearHealthCache(); // not the isolate's copy: the location's
      const health = await get(`app.${DOMAIN}`, `/__health?n=${i}`, { PLATFORM_DB: counting }, cachedApp);
      expect(health.status).toBe(200);
      expect(health.headers.get("cache-control")).toBe("no-store");
      expect(health.headers.get("x-health-cache")).toBe(i === 0 ? "miss" : "hit");
      expect((await get(`app.${DOMAIN}`, "/healthz", { PLATFORM_DB: counting }, cachedApp)).status).toBe(200);
    }
    expect(batches).toBe(1);
    expect(firsts).toBe(1);
  });

  it("caches an outage's 503 the same way, so it logs about once per location per 10 seconds", async () => {
    const cache = await caches.open(`health-${crypto.randomUUID()}`);
    const cachedApp = appWith(cache);
    const broken = { prepare: () => ({ first: () => Promise.reject(new Error("D1 down")) }), batch: () => Promise.reject(new Error("D1 down")) } as unknown as D1Database;
    const lines: LogLine[] = [];
    restoreLogs = captureLogs((l) => lines.push(l));
    for (let i = 0; i < 5; i++) {
      clearHealthCache();
      expect((await get(`app.${DOMAIN}`, "/healthz", { PLATFORM_DB: broken }, cachedApp)).status).toBe(503);
      expect((await get(`app.${DOMAIN}`, "/__health", { PLATFORM_DB: broken }, cachedApp)).status).toBe(503);
    }
    expect(lines.filter((l) => l.event === "health.db_failed")).toHaveLength(2);
  });

  it("answers 429 to one caller past the rate limit binding, and keys an IPv6 caller by its /64", async () => {
    await beats();
    const keys: string[] = [];
    const limiter: RateLimit = { limit: async ({ key }) => (keys.push(key), { success: keys.length <= 2 }) };
    expect((await get(`app.${DOMAIN}`, "/__health", { HEALTH_RATE_LIMIT: limiter }, app, "2001:db8:1:2:3:4:5:6")).status).toBe(200);
    expect((await get(`app.${DOMAIN}`, "/healthz", { HEALTH_RATE_LIMIT: limiter }, app, "2001:db8:1:2:9:9:9:9")).status).toBe(200);
    const limited = await get(`app.${DOMAIN}`, "/__health", { HEALTH_RATE_LIMIT: limiter }, app, "2001:db8:1:2::1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("10");
    expect(new Set(keys)).toEqual(new Set(["2001:db8:1:2"]));
    // A limiter that fails never fails the check.
    const failing: RateLimit = { limit: async () => Promise.reject(new Error("binding down")) };
    expect((await get(`app.${DOMAIN}`, "/__health", { HEALTH_RATE_LIMIT: failing })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Indexed reads: the plans and the rows read
// ---------------------------------------------------------------------------

async function plan(sql: string, ...binds: unknown[]): Promise<string> {
  const rows = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
  return rows.results.map((r) => r.detail).join(" | ");
}

/** A full scan of a table, as opposed to SCAN of a subquery or a SEARCH. */
const FULL_SCAN = /SCAN (tenants|t|s|scheduler_stats|scheduler_minutes|releases|platform_heartbeats)\b/;

describe("the health check's reads", () => {
  it("each read by primary key or over a partial index, never a table scan", async () => {
    const plans = {
      heartbeats: await plan(HEARTBEATS_SQL),
      oldest: await plan(OLDEST_DUE_SQL),
      oldestNew: await plan(OLDEST_NEW_SQL),
      overdue: await plan(OVERDUE_SQL, T0),
      failing: await plan(FAILING_SQL, FAILING_STREAK),
      lastRun: await plan(LAST_RUN_SQL),
      release: await plan(ACTIVE_RELEASE_SQL),
    };
    expect(plans.heartbeats).toContain("SEARCH platform_heartbeats USING PRIMARY KEY (name=?)");
    expect(plans.oldest).toContain("SEARCH tenants USING INDEX idx_tenants_schedule_due (schedule_next_at>?)");
    expect(plans.overdue).toContain("SEARCH tenants USING INDEX idx_tenants_schedule_due (schedule_next_at<?)");
    expect(plans.oldestNew).toContain("SEARCH tenants USING INDEX idx_tenants_schedule_due (schedule_next_at=?)");
    // The failing index first, then each failing tenant's row by its key.
    expect(plans.failing).toContain("SEARCH s USING COVERING INDEX idx_scheduler_stats_failing (streak>?)");
    expect(plans.failing).toMatch(/SEARCH t USING INDEX sqlite_autoindex_tenants_1 \(id=\?\)/);
    expect(plans.failing.indexOf("idx_scheduler_stats_failing")).toBeLessThan(plans.failing.indexOf("SEARCH t"));
    expect(plans.lastRun).toContain("SEARCH scheduler_minutes");
    expect(plans.release).toContain("SEARCH releases USING INDEX idx_releases_active");
    for (const [name, p] of Object.entries(plans)) expect(p, name).not.toMatch(FULL_SCAN);
  });

  it("reads a handful of rows on a healthy platform, however many tenants it has", async () => {
    await beats();
    for (let i = 0; i < 60; i++) await tenant({ streak: 0 });
    await tenant({ nextAt: T0 - 10 * MINUTE_MS, streak: 4 });
    await db.batch(runMinuteStatements(db, [sample(T0 - MINUTE_MS)]));
    const statements = [
      db.prepare(HEARTBEATS_SQL),
      db.prepare(OLDEST_DUE_SQL),
      db.prepare(OLDEST_NEW_SQL),
      db.prepare(OVERDUE_SQL).bind(T0 - OVERDUE_MS),
      db.prepare(FAILING_SQL).bind(FAILING_STREAK),
      db.prepare(LAST_RUN_SQL),
      db.prepare(ACTIVE_RELEASE_SQL),
    ];
    const results = await db.batch(statements);
    const read = results.map((r) => r.meta.rows_read);
    // 61 tenants, 61 stats rows: the reads stay at the rows in trouble plus index probes.
    expect(read.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(14);
    const state = await readPlatformState(db, T0);
    expect(state).toMatchObject({ overdue: 1, failing: 1, oldestDueAt: T0 - 10 * MINUTE_MS, lastRunAt: T0 - MINUTE_MS });
  });
});

// ---------------------------------------------------------------------------
// The run metrics
// ---------------------------------------------------------------------------

function sample(at: number, over: Partial<RunSample> = {}): RunSample {
  return { at, outcome: "ran", durationMs: 300, lagMs: 2_000, checked: 4, failures: 0, ...over };
}

describe("the run metrics", () => {
  it("bucket durations and read the p95 as the bound of the bucket it falls in", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(250)).toBe(0);
    expect(bucketOf(251)).toBe(1);
    expect(bucketOf(60_000)).toBe(DURATION_BUCKETS_MS.length - 1);
    expect(bucketOf(60_001)).toBe(DURATION_BUCKETS_MS.length);
    expect(quantileFromBuckets([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.95)).toEqual({ ms: null, over: false });
    // 95 fast runs and 5 slow: the 95th is still fast; one more slow and it isn't.
    expect(quantileFromBuckets([95, 0, 0, 0, 0, 0, 5, 0, 0, 0], 0.95)).toEqual({ ms: 250, over: false });
    expect(quantileFromBuckets([94, 0, 0, 0, 0, 0, 6, 0, 0, 0], 0.95)).toEqual({ ms: 15_000, over: false });
    expect(quantileFromBuckets([1, 0, 0, 0, 0, 0, 0, 0, 0, 99], 0.95)).toEqual({ ms: null, over: true });
  });

  it("add a batch's runs to their minute in one write per minute", async () => {
    const m = T0 - 3 * MINUTE_MS;
    const statements = runMinuteStatements(db, [
      sample(m + 1_000),
      sample(m + 2_000, { outcome: "timeout", durationMs: 40_000, lagMs: 9_000 }),
      sample(m + 70_000, { outcome: "lease_busy", durationMs: 20 }),
    ]);
    expect(statements).toHaveLength(2);
    await db.batch(statements);
    // A second batch in the same minute adds to it.
    await db.batch(runMinuteStatements(db, [sample(m + 5_000, { outcome: "failed", durationMs: 1_500, checked: 2, failures: 2 })]));
    const row = await db.prepare("SELECT * FROM scheduler_minutes WHERE minute = ?").bind(m / MINUTE_MS).first<Record<string, number>>();
    expect(row).toMatchObject({ runs: 3, errors: 2, timeouts: 1, busy: 0, checked: 10, failures: 2, total_ms: 41_800, max_ms: 40_000, lag_max_ms: 9_000, d1: 1, d3: 1, d8: 1 });
  });

  it("answer runs a minute, failures, the p95 and queue lag over 15 minutes, an hour and a day", async () => {
    const now = T0 + 30_000; // half way through a minute: that minute isn't counted yet
    const runs: RunSample[] = [];
    for (let i = 1; i <= 10; i++) runs.push(sample(T0 - i * MINUTE_MS, { durationMs: 200 }), sample(T0 - i * MINUTE_MS + 1, { durationMs: 900 }));
    runs.push(sample(T0 - 2 * MINUTE_MS, { outcome: "error", durationMs: 5_000, lagMs: 70_000 }));
    runs.push(sample(T0 - 3 * 60 * MINUTE_MS, { durationMs: 100 })); // only in the day
    runs.push(sample(T0 + 10_000)); // the current minute: not yet
    await db.batch(runMinuteStatements(db, runs));
    const metrics = await runMetrics(db, now);
    expect(metrics.until).toBe(T0);
    const [quarter, hour, day] = metrics.windows;
    expect(quarter).toMatchObject({ minutes: 15, runs: 21, errors: 1, maxMs: 5_000, maxLagMs: 70_000, p95Ms: 1_000, p95Over: false });
    expect(quarter!.runsPerMinute).toBeCloseTo(21 / 15);
    expect(hour).toMatchObject({ minutes: 60, runs: 21 });
    expect(day).toMatchObject({ minutes: 1440, runs: 22 });
    // The data starts 3 hours back: the day's rate is over those 180 minutes, not 1,440.
    expect(day!.runsPerMinute).toBeCloseTo(22 / 180);
    expect(metrics.hours.map((h) => [new Date(h.at).toISOString(), h.runs, h.errors])).toEqual([
      ["2026-11-02T06:00:00.000Z", 1, 0],
      ["2026-11-02T08:00:00.000Z", 21, 1],
    ]);
    // An empty window is zeros, not an error.
    await db.prepare("DELETE FROM scheduler_minutes").run();
    expect((await runMetrics(db, now)).windows[0]).toMatchObject({ runs: 0, runsPerMinute: 0, p95Ms: null, avgMs: 0 });
  });

  it("read by a range of the primary key: a day is at most 1,440 minutes, 15 minutes at most 15", async () => {
    for (const sql of [WINDOW_SQL, HOURS_SQL]) {
      const p = await plan(sql, 1, 2);
      expect(p).toContain("SEARCH scheduler_minutes USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)");
      expect(p).not.toMatch(FULL_SCAN);
    }
    expect(await plan(OLD_MINUTES_SQL, 1)).toContain("SEARCH scheduler_minutes USING INTEGER PRIMARY KEY (rowid<?)");
    // Two days of minutes; the 15-minute window reads its 15.
    const all: RunSample[] = [];
    for (let i = 1; i <= 2 * 1440; i++) all.push(sample(T0 - i * MINUTE_MS));
    for (let i = 0; i < all.length; i += 90) await db.batch(runMinuteStatements(db, all.slice(i, i + 90)));
    const to = T0 / MINUTE_MS;
    const quarter = await db.prepare(WINDOW_SQL).bind(to - 15, to).all();
    expect(quarter.meta.rows_read).toBeLessThanOrEqual(16);
    const day = await db.prepare(HOURS_SQL).bind(to - 1440, to).all();
    expect(day.results).toHaveLength(24);
    // Each of the day's minutes once, and once more from the GROUP BY's sorter: never the older day.
    expect(day.meta.rows_read).toBeLessThanOrEqual(2 * 1441);
  });

  it("rate over the whole window, or the minutes since the data starts when that is shorter", () => {
    expect(rateMinutes(1440, 10_000, null)).toBe(1440);
    expect(rateMinutes(1440, 10_000, 10_000 - 90)).toBe(90);
    expect(rateMinutes(15, 10_000, 10_000 - 90)).toBe(15);
    expect(rateMinutes(15, 10_000, 10_000)).toBe(1);
  });

  it("keep 8 days", async () => {
    const keep = Math.floor(T0 / MINUTE_MS) - MINUTES_KEPT_DAYS * 1440;
    await db.batch(runMinuteStatements(db, [sample((keep - 1) * MINUTE_MS), sample(keep * MINUTE_MS), sample(T0 - MINUTE_MS)]));
    await schedulerMinutesCleanup(db, T0).run();
    const left = await db.prepare("SELECT minute FROM scheduler_minutes ORDER BY minute").all<{ minute: number }>();
    expect(left.results.map((r) => r.minute)).toEqual([keep, T0 / MINUTE_MS - 1]);
  });
});
