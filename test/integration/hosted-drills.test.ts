import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { createMonitor, getMonitor } from "../../src/worker/db/monitors";
import { PLAN_BUDGETS } from "../../src/worker/lib/budget";
import { platformCadence } from "../../src/worker/lib/cadence";
import { decryptConfig } from "../../src/worker/lib/secret-config";
import { runScheduled } from "../../src/worker/scheduler";
import { createMonitorSchema } from "../../src/shared/schemas";
import { MONITOR_DEFAULTS, httpConfig, monitorSeedSql, monitorTargets } from "../../scripts/hosted-drills/seed.mjs";
import { sealConfig } from "../../scripts/hosted-drills/keys.mjs";

/**
 * The load test seeds each tenant's monitors as SQL straight into its
 * database (scripts/hosted-drills/seed.mjs, docs/hosted/LAUNCH_DRILLS.md),
 * since a Hosted tenant has no API token to create them through. These tests
 * hold that SQL to createMonitor: the same row, the same sealed config read
 * back, and monitors the real scheduler checks.
 */

const ECHO = "https://openping-loadtest-echo-staging.example.workers.dev";
const T0 = Date.UTC(2026, 10, 2, 6, 0, 0);

async function seed(count: number) {
  const sql = await monitorSeedSql({
    targets: monitorTargets(ECHO, count),
    seal: (config) => sealConfig(env.MASTER_KEY!, config),
    now: T0 - 60_000,
    newMonitorId: () => `mon_${crypto.randomUUID()}`,
  });
  const statements = sql.split(";\n").map((s) => s.trim()).filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 - 60_000);
  await env.DB.batch(["monitor_state", "monitors", "samples", "summaries", "scheduler_runs", "locks"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the load test's seeded monitors", () => {
  it("are the defaults createMonitor fills in for an HTTP monitor with just a URL", () => {
    const parsed = createMonitorSchema.parse({ type: "http", name: "x", config: { url: `${ECHO}/ok` } });
    if (parsed.type !== "http") throw new Error("http");
    expect(httpConfig(`${ECHO}/ok`)).toEqual(parsed.config);
    expect({ schedule: parsed.schedule, assertions: parsed.assertions, notify: parsed.notify, public: parsed.public, confirmFailures: parsed.confirmFailures }).toEqual(MONITOR_DEFAULTS);
  });

  it("are stored exactly as createMonitor stores the same monitor", async () => {
    await seed(1);
    const seededRow = await env.DB.prepare("SELECT * FROM monitors").first<Record<string, unknown>>();
    const seededState = await env.DB.prepare("SELECT * FROM monitor_state").first<Record<string, unknown>>();
    const [target] = monitorTargets(ECHO, 1);
    const created = await createMonitor(env, createMonitorSchema.parse({ type: "http", name: target!.name, config: { url: target!.url } }));
    const createdRow = await env.DB.prepare("SELECT * FROM monitors WHERE id = ?").bind(created.id).first<Record<string, unknown>>();
    const createdState = await env.DB.prepare("SELECT * FROM monitor_state WHERE monitor_id = ?").bind(created.id).first<Record<string, unknown>>();

    const comparable = (row: Record<string, unknown>) => {
      const { id: _id, config: _config, created_at: _c, updated_at: _u, ...rest } = row;
      return rest;
    };
    expect(comparable(seededRow!)).toEqual(comparable(createdRow!));
    // The sealed configs differ only by their random IV: both open to the same document.
    const open = async (row: Record<string, unknown>) => decryptConfig(env, JSON.parse(String(row.config)));
    expect(await open(seededRow!)).toEqual(await open(createdRow!));
    const stateOf = (row: Record<string, unknown>) => {
      const { monitor_id: _m, state_since: _s, next_check_at: _n, updated_at: _u, ...rest } = row;
      return rest;
    };
    expect(stateOf(seededState!)).toEqual(stateOf(createdState!));
    // And the app reads it as the monitor it is.
    const read = await getMonitor(env, String(seededRow!.id));
    expect(read).toMatchObject({ type: "http", name: target!.name, intervalSeconds: 720, enabled: true });
  });

  it("are checked by the real scheduler on a Hosted tenant's run, against the echo Worker", async () => {
    await seed(20);
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("ok");
    });
    vi.setSystemTime(T0);
    const result = await runScheduled({ cron: "* * * * *", scheduledTime: T0, noRetry() {} }, env, {
      cadence: platformCadence(12),
      budget: PLAN_BUDGETS.hosted,
      confirmDelayMs: 0,
    });
    expect(result.outcome).toBe("ran");
    const samples = await env.DB.prepare("SELECT COUNT(DISTINCT monitor_id) AS n FROM samples").first<{ n: number }>();
    expect(samples?.n).toBe(20);
    expect(new Set(urls.filter((u) => u.startsWith(ECHO)).map((u) => new URL(u).pathname))).toEqual(new Set(["/ok", "/flaky", "/slow", "/window"]));
  });
});
