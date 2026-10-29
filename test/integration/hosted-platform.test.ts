import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import {
  BUNDLED_SCHEMA_VERSION,
  BUNDLE_VERSION,
  MIGRATION_LOCK_TTL_MS,
  ensureSchema,
  forgetSchemaCheck,
} from "../../src/worker/lib/migrate";
import { runScheduled } from "../../src/worker/scheduler";
import {
  INTERNAL_HEADER,
  PLAN_LIMITS,
  type HealthResponse,
  type ScheduledRunSummary,
  type TenantProps,
  type UsageCounts,
} from "../../src/shared/hosted-contract";
import pkg from "../../package.json";

/**
 * The platform's internal calls (docs/hosted/CONTRACT.md, section 6) and
 * self-migration, through the real Worker and D1: the scheduler entry, health,
 * the gate that hides both, the bundled migrations applied on the first call
 * after an update, and a plain install that does none of it.
 */

const ORIGIN = "https://openping.test";
const TENANT = "abcdefgh12345678";
const SHELL = "<!doctype html><title>OpenPing</title>";
const URLS = {
  account: "https://app.hosted.test/account",
  billing: "https://app.hosted.test/billing",
  upgrade: "https://app.hosted.test/billing/upgrade",
  signIn: "https://app.hosted.test/sign-in",
  signOut: "https://app.hosted.test/sign-out",
};

const ASSETS = {
  fetch: async () => new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } }),
} as unknown as Fetcher;

let usageReports: UsageCounts[] = [];

const plainEnv = (db: D1Database = env.DB): Env => ({ ...env, DB: db, ASSETS }) as Env;
const hostedEnv = (db: D1Database = env.DB): Env =>
  ({ ...env, DB: db, ASSETS, HOSTED_MODE: "1", TENANT_ID: TENANT }) as Env;

function props(over: Partial<TenantProps> = {}): TenantProps {
  return {
    contract: 1,
    invocation: "platform",
    callId: crypto.randomUUID().replace(/-/g, ""),
    tenant: {
      id: TENANT,
      slug: "acme",
      status: "active",
      plan: "hosted",
      limits: PLAN_LIMITS.hosted,
      trialEndsAt: null,
      urls: URLS,
    },
    platform: {
      sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
      reportUsage: async (counts) => {
        usageReports.push(counts);
      },
      audit: async () => {},
    },
    ...over,
  };
}

function contextWith(p: unknown): ExecutionContext {
  const base = createExecutionContext();
  return {
    waitUntil: (promise: Promise<unknown>) => base.waitUntil(promise),
    passThroughOnException: () => base.passThroughOnException(),
    props: p,
  } as unknown as ExecutionContext;
}

/** A call as the platform makes it: props with invocation "platform" and the call id in the header. */
function platformCall(
  path: string,
  init: { method?: string; body?: unknown; target?: Env; props?: TenantProps; header?: string | null } = {},
): Promise<Response> | Response {
  const p = init.props ?? props();
  const headers = new Headers();
  const header = init.header === undefined ? p.callId : init.header;
  if (header !== null) headers.set(INTERNAL_HEADER, header);
  let body: string | undefined;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  }
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body }),
    init.target ?? hostedEnv(),
    contextWith(p),
  );
}

const scheduledBody = (runId = "run_1") => ({ runId, scheduledTime: Date.now(), cron: "* * * * *" });

async function tableNames(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    .all<{ name: string }>();
  return results.map((r) => r.name).sort();
}

async function appliedMigrations(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
  return results.map((r) => r.name);
}

/** A D1 binding that fails every query, like a database that doesn't answer. */
const deadDb = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare" || prop === "batch" || prop === "exec") {
      return () => {
        throw new Error("D1_ERROR: the database is unavailable");
      };
    }
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as D1Database;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => {
  usageReports = [];
  forgetSchemaCheck();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a plain install (HOSTED_MODE unset)", () => {
  it("answers the internal paths as it always did, with the app shell, even with props and the header", async () => {
    for (const [path, method] of [
      ["/__platform/health", "GET"],
      ["/__platform/scheduled", "POST"],
      ["/__platform/anything", "GET"],
    ] as const) {
      const res = await platformCall(path, {
        method,
        body: method === "POST" ? scheduledBody() : undefined,
        target: plainEnv(),
      });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(SHELL);
    }
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduler_runs").first<{ n: number }>();
    expect(runs!.n).toBe(0);
  });

  it("never migrates its own database: that is `npm run deploy`'s job", async () => {
    const before = await tableNames(env.FRESH_DB);
    expect(before).toEqual([]);
    const res = await worker.fetch(new Request(`${ORIGIN}/status`), plainEnv(env.FRESH_DB), contextWith(undefined));
    expect(res.status).toBe(200);
    expect(await tableNames(env.FRESH_DB)).toEqual([]);
  });

  it("still runs the cron the same way", async () => {
    const result = await runScheduled({ cron: "*/12 * * * *", scheduledTime: Date.now(), noRetry() {} }, plainEnv());
    expect(result.outcome).toBe("ran");
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduler_runs").first<{ n: number }>();
    expect(runs!.n).toBe(1);
    await env.DB.prepare("DELETE FROM scheduler_runs").run();
  });
});

describe("self-migration in hosted mode", () => {
  it("never migrates from a public call: it answers 503 updating until a platform call has", async () => {
    expect(await tableNames(env.FRESH_DB)).toEqual([]);
    const publicCall = (accept?: string) =>
      worker.fetch(
        new Request(`${ORIGIN}/api/auth/status`, { headers: accept ? { accept } : {} }),
        hostedEnv(env.FRESH_DB),
        contextWith(props({ invocation: "public" })),
      );
    const api = await publicCall();
    expect(api.status).toBe(503);
    expect(api.headers.get("retry-after")).toBe("10");
    expect(await api.json()).toEqual({ error: "hosted_updating" });
    // A browser's page load gets a page that reloads itself.
    const page = await worker.fetch(
      new Request(`${ORIGIN}/monitors`, { headers: { accept: "text/html,application/xhtml+xml" } }),
      hostedEnv(env.FRESH_DB),
      contextWith(props({ invocation: "public" })),
    );
    expect(page.status).toBe(503);
    expect(page.headers.get("retry-after")).toBe("10");
    expect(await page.text()).toContain("This OpenPing is updating");
    // Nothing was written: no bookkeeping, no lock.
    expect(await tableNames(env.FRESH_DB)).toEqual([]);

    // The platform's next call migrates; then the public call goes through.
    expect((await platformCall("/__platform/health", { target: hostedEnv(env.FRESH_DB) })).status).toBe(200);
    expect((await publicCall()).status).toBe(200);
  });

  it("the platform call applied every bundled migration to the fresh database, in order, once", async () => {
    const applied = await appliedMigrations(env.FRESH_DB);
    expect(applied).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
    expect(await tableNames(env.FRESH_DB)).toEqual(
      expect.arrayContaining(["monitors", "scheduler_runs", "used_handoff_nonces", "d1_migrations", "d1_migrations_lock"]),
    );
    // The lock is released.
    const lock = await env.FRESH_DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations_lock").first<{ n: number }>();
    expect(lock!.n).toBe(0);

    // Once seen current, the next call in the same isolate doesn't even look.
    expect(await ensureSchema(env.FRESH_DB)).toEqual({ ok: true, applied: 0, schemaVersion: BUNDLED_SCHEMA_VERSION });
    const prepare = vi.spyOn(env.FRESH_DB, "prepare");
    const again = await ensureSchema(env.FRESH_DB);
    expect(again).toEqual({ ok: true, applied: 0, schemaVersion: BUNDLED_SCHEMA_VERSION });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("agrees with Wrangler's bookkeeping: a database Wrangler migrated needs nothing", async () => {
    const result = await ensureSchema(env.DB);
    expect(result).toEqual({ ok: true, applied: 0, schemaVersion: BUNDLED_SCHEMA_VERSION });
  });

  it("applies only what is missing, and each migration whole or not at all", async () => {
    const migrations = [
      { name: "9001_add_a.sql", queries: ["CREATE TABLE selfmig_a (id TEXT PRIMARY KEY)"] },
      {
        name: "9002_broken.sql",
        queries: ["CREATE TABLE selfmig_b (id TEXT PRIMARY KEY)", "INSERT INTO no_such_table VALUES (1)"],
      },
    ];
    const result = await ensureSchema(env.FRESH_DB, { migrations });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("failed");
    expect(result.applied).toBe(1);
    expect(result.error).toMatch(/^migration 9002_broken\.sql failed: /);
    const tables = await tableNames(env.FRESH_DB);
    expect(tables).toContain("selfmig_a");
    // The failed migration's first statement was rolled back with it.
    expect(tables).not.toContain("selfmig_b");
    expect(await appliedMigrations(env.FRESH_DB)).toContain("9001_add_a.sql");
    expect(await appliedMigrations(env.FRESH_DB)).not.toContain("9002_broken.sql");
    const lock = await env.FRESH_DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations_lock").first<{ n: number }>();
    expect(lock!.n).toBe(0);

    // For 30 seconds this isolate answers the same failure without trying again.
    const prepare = vi.spyOn(env.FRESH_DB, "prepare");
    expect(await ensureSchema(env.FRESH_DB, { migrations })).toEqual(result);
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();

    // Fixed in the next bundle: only that one is applied.
    const fixed = [migrations[0]!, { name: "9002_broken.sql", queries: ["CREATE TABLE selfmig_b (id TEXT PRIMARY KEY)"] }];
    expect(await ensureSchema(env.FRESH_DB, { migrations: fixed })).toEqual({ ok: true, applied: 1, schemaVersion: 9002 });
  });

  it("lets one call migrate at a time: two at once apply each migration once", async () => {
    const migrations = [
      { name: "9003_c.sql", queries: ["CREATE TABLE selfmig_c (id TEXT PRIMARY KEY)"] },
      { name: "9004_d.sql", queries: ["ALTER TABLE selfmig_c ADD COLUMN note TEXT"] },
    ];
    const [a, b] = await Promise.all([
      ensureSchema(env.FRESH_DB, { migrations, pollMs: 10 }),
      ensureSchema(env.FRESH_DB, { migrations, pollMs: 10 }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect((a.ok ? a.applied : 0) + (b.ok ? b.applied : 0)).toBe(2);
    const names = await appliedMigrations(env.FRESH_DB);
    expect(names.filter((n) => n === "9003_c.sql")).toHaveLength(1);
    expect(names.filter((n) => n === "9004_d.sql")).toHaveLength(1);
  });

  it("waits for a call that holds the lock, and takes over a lock its holder left to expire", async () => {
    const migrations = [{ name: "9005_e.sql", queries: ["CREATE TABLE selfmig_e (id TEXT PRIMARY KEY)"] }];
    await env.FRESH_DB.prepare("INSERT INTO d1_migrations_lock (name, holder, expires_at) VALUES ('schema', 'other', ?)")
      .bind(Date.now() + MIGRATION_LOCK_TTL_MS)
      .run();
    // While it waits it only reads: no batch (the lock write) until the lock is free.
    const batch = vi.spyOn(env.FRESH_DB, "batch");
    const busy = await ensureSchema(env.FRESH_DB, { migrations, waitMs: 50, pollMs: 10 });
    expect(busy).toMatchObject({ ok: false, reason: "busy" });
    expect(batch).not.toHaveBeenCalled();
    batch.mockRestore();
    expect(await tableNames(env.FRESH_DB)).not.toContain("selfmig_e");

    await env.FRESH_DB.prepare("UPDATE d1_migrations_lock SET expires_at = ? WHERE name = 'schema'").bind(Date.now() - 1).run();
    expect(await ensureSchema(env.FRESH_DB, { migrations, waitMs: 0 })).toEqual({ ok: true, applied: 1, schemaVersion: 9005 });
  });

  it("looks again after 10 minutes, or at once after a query finds a column missing", async () => {
    expect((await ensureSchema(env.DB)).ok).toBe(true);
    const prepare = vi.spyOn(env.DB, "prepare");
    await ensureSchema(env.DB);
    expect(prepare).not.toHaveBeenCalled();

    const later = Date.now() + 11 * 60_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    await ensureSchema(env.DB);
    expect(prepare).toHaveBeenCalled();
    now.mockRestore();
    prepare.mockClear();

    // A request whose query meets a schema it didn't expect.
    const broken = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            if (/FROM monitors/.test(query)) throw new Error("D1_ERROR: no such column: confirmed_from");
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/monitors`, { headers: { authorization: "Bearer integration-api-token" } }),
      hostedEnv(broken),
      contextWith(props({ invocation: "public" })),
    );
    expect(res.status).toBe(500);
    prepare.mockClear();
    await ensureSchema(env.DB);
    expect(prepare).toHaveBeenCalled();
  });
});

describe("the internal paths in hosted mode", () => {
  it("answers 404 not_found to anything but a platform call", async () => {
    const p = props();
    const cases: { name: string; init: Parameters<typeof platformCall>[1] }[] = [
      { name: "no header", init: { props: p, header: null } },
      { name: "wrong header", init: { props: p, header: "x".repeat(32) } },
      { name: "a public call with the header", init: { props: { ...p, invocation: "public" }, header: p.callId } },
    ];
    for (const { name, init } of cases) {
      for (const [path, method] of [
        ["/__platform/health", "GET"],
        ["/__platform/scheduled", "POST"],
        ["/__platform", "GET"],
      ] as const) {
        const res = await platformCall(path, { ...init, method, body: method === "POST" ? scheduledBody() : undefined });
        expect(res.status, `${name} ${path}`).toBe(404);
        expect(await res.json(), `${name} ${path}`).toEqual({ error: "not_found" });
      }
    }
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduler_runs").first<{ n: number }>();
    expect(runs!.n).toBe(0);
  });

  it("answers an unknown internal path 404 even for a platform call", async () => {
    const res = await platformCall("/__platform/releases");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("refuses a scheduled call with a malformed body", async () => {
    for (const body of ["not json", { runId: "", scheduledTime: 1, cron: "" }, { runId: "r", cron: "*" }]) {
      const res = await platformCall("/__platform/scheduled", { body });
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /__platform/scheduled", () => {
  it("runs what scheduled() runs and answers its summary", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok", { status: 200 }));
    const created = await worker.fetch(
      new Request(`${ORIGIN}/api/monitors`, {
        method: "POST",
        headers: { authorization: "Bearer integration-api-token", "content-type": "application/json" },
        body: JSON.stringify({ type: "http", name: "Hosted site", config: { url: "https://hosted-site.example.com/" } }),
      }),
      plainEnv(),
      contextWith(undefined),
    );
    expect(created.status).toBe(201);
    // Make it due, as if its interval had passed since the first check.
    await env.DB.prepare("UPDATE monitor_state SET next_check_at = 0").run();
    await env.DB.prepare("DELETE FROM scheduler_runs").run();
    const now = Date.now();

    const res = await platformCall("/__platform/scheduled", { body: scheduledBody("run_ok") });
    expect(res.status).toBe(200);
    const summary = await res.json<ScheduledRunSummary>();
    expect(summary).toMatchObject({
      runId: "run_ok",
      outcome: "ran",
      version: pkg.version,
      schemaVersion: BUNDLED_SCHEMA_VERSION,
      migrationsApplied: 0,
      checked: 1,
      failures: 0,
      deferred: 0,
    });
    expect(summary.error).toBeUndefined();
    expect(summary.startedAt).toBeGreaterThanOrEqual(now);
    // The site was just checked, on the plan's 12 minutes: next due about one
    // interval on, on a 12-minute mark of the clock less the 30 seconds a call
    // may come early (lib/cadence.ts), and never more than 12 minutes away.
    const MAX_GAP = 12 * 60_000;
    expect(summary.nextDueAt).toBeGreaterThan(summary.startedAt + 5 * 60_000);
    expect(summary.nextDueAt).toBeLessThanOrEqual(summary.startedAt + MAX_GAP);
    expect([MAX_GAP - 30_000, (summary.startedAt + MAX_GAP) % MAX_GAP]).toContain(summary.nextDueAt! % MAX_GAP);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    // At least the run's own three round trips, plus the migration check and the usage report.
    expect(summary.d1Queries).toBeGreaterThanOrEqual(5);

    // The same run record a cron run writes, with the cron the platform sent.
    const run = await env.DB.prepare("SELECT cron, ok, monitors_checked FROM scheduler_runs ORDER BY started_at DESC LIMIT 1").first();
    expect(run).toEqual({ cron: "* * * * *", ok: 1, monitors_checked: 1 });
    // And the usage report at the end of the run.
    expect(usageReports).toHaveLength(1);
    expect(usageReports[0]).toMatchObject({ monitors: 1, channels: 0 });
    expect(usageReports[0]!.statusPages).toBeGreaterThanOrEqual(1);
  });

  it("answers lease_busy when another run holds the lease, and runs nothing", async () => {
    await env.DB.prepare("INSERT INTO locks (name, holder, acquired_at, expires_at) VALUES ('scheduler', 'other', ?, ?)")
      .bind(Date.now(), Date.now() + 60_000)
      .run();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduler_runs").first<{ n: number }>();
    const res = await platformCall("/__platform/scheduled", { body: scheduledBody("run_busy") });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId: "run_busy", outcome: "lease_busy", checked: 0 });
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduler_runs").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    expect(usageReports).toHaveLength(0);
    await env.DB.prepare("DELETE FROM locks WHERE name = 'scheduler'").run();
  });

  it("answers 200 with outcome failed when the database doesn't answer", async () => {
    const res = await platformCall("/__platform/scheduled", { body: scheduledBody("run_dead"), target: hostedEnv(deadDb) });
    expect(res.status).toBe(200);
    const summary = await res.json<ScheduledRunSummary>();
    expect(summary).toMatchObject({ runId: "run_dead", outcome: "failed", version: BUNDLE_VERSION });
    expect(summary.error).toMatch(/unavailable/);
    // No nextDueAt after a failure: the platform calls again on its next tick.
    expect(summary.nextDueAt).toBeUndefined();
  });
});

describe("GET /__platform/health", () => {
  it("reports the version, the schema and the last run", async () => {
    const res = await platformCall("/__platform/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const health = await res.json<HealthResponse>();
    expect(health).toMatchObject({
      ok: true,
      version: pkg.version,
      schemaVersion: BUNDLED_SCHEMA_VERSION,
      bundledSchemaVersion: BUNDLED_SCHEMA_VERSION,
      migrating: false,
    });
    expect(health.lastRun).toMatchObject({ outcome: "ran" });
    expect(health.lastRun!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("stays ok on a newer schema, as after a rollback to an older bundle", async () => {
    await env.DB.prepare("INSERT INTO d1_migrations (name) VALUES ('9999_from_a_newer_release.sql')").run();
    const health = await (await platformCall("/__platform/health")).json<HealthResponse>();
    expect(health).toMatchObject({ ok: true, schemaVersion: 9999, bundledSchemaVersion: BUNDLED_SCHEMA_VERSION });
    await env.DB.prepare("DELETE FROM d1_migrations WHERE name = '9999_from_a_newer_release.sql'").run();
  });

  it("answers 503 while another call is migrating, without waiting for it", async () => {
    const latest = env.TEST_MIGRATIONS.at(-1)!.name;
    await env.DB.prepare("DELETE FROM d1_migrations WHERE name = ?").bind(latest).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS d1_migrations_lock (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    ).run();
    await env.DB.prepare("INSERT INTO d1_migrations_lock (name, holder, expires_at) VALUES ('schema', 'other', ?)")
      .bind(Date.now() + MIGRATION_LOCK_TTL_MS)
      .run();
    try {
      const started = Date.now();
      const res = await platformCall("/__platform/health");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, migrating: true, schemaVersion: BUNDLED_SCHEMA_VERSION - 1 });
    } finally {
      await env.DB.prepare("DELETE FROM d1_migrations_lock").run();
      await env.DB.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(latest).run();
    }
  });

  it("answers 503 when the database doesn't answer", async () => {
    const res = await platformCall("/__platform/health", { target: hostedEnv(deadDb) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, version: BUNDLE_VERSION, bundledSchemaVersion: BUNDLED_SCHEMA_VERSION });
  });
});
