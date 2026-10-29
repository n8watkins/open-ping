import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { compactionStatements, resolveRetention } from "../../src/worker/history/rollups";
import { PLAN_BUDGETS } from "../../src/worker/lib/budget";
import { runScheduled } from "../../src/worker/scheduler";

// The history rollups (history/rollups.ts) recompute day and month buckets
// from the hour rows. They must give the same totals as a full recompute while
// reading and writing only what changed: D1 bills every row read and written,
// and on the Free plan a day's rows are capped (docs/FREE_TIER.md).

const API_ORIGIN = "https://openping.test";
const MONITORS = 20;
/** Days of hourly history seeded: just inside the 64 days hour rows are kept. */
const HISTORY_DAYS = 63;

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer integration-api-token");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

interface Rows {
  read: number;
  written: number;
}

/** A D1 binding that adds up the rows every query read and wrote, as D1 bills them (meta). */
function rowsD1(db: D1Database, rows: Rows): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const add = <T>(result: T): T => {
    for (const r of Array.isArray(result) ? result : [result]) {
      const meta = (r as { meta?: { rows_read?: number; rows_written?: number } } | null)?.meta;
      rows.read += meta?.rows_read ?? 0;
      rows.written += meta?.rows_written ?? 0;
    }
    return result;
  };
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (prop === "run" || prop === "all") {
          const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => Promise<unknown>;
          return async (...args: unknown[]) => add(await fn.apply(target, args));
        }
        if (prop === "first" || prop === "raw") {
          // Not billed through meta here; the scheduler uses batches and all().
          const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => Promise<unknown>;
          return (...args: unknown[]) => fn.apply(target, args);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(proxy, stmt);
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query));
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) =>
          add(await target.batch(statements.map((s) => real.get(s) ?? s)));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const controller: ScheduledController = { cron: "*/12 * * * *", scheduledTime: Date.now(), noRetry() {} };

/** One scheduler run, and the rows it read and wrote. */
async function measuredRun(): Promise<Rows> {
  const rows = { read: 0, written: 0 };
  await runScheduled(controller, { ...env, DB: rowsD1(env.DB, rows) }, { budget: PLAN_BUDGETS.paid });
  return rows;
}

/** Every derived bucket, keyed by id, to compare passes. */
async function derived(): Promise<Map<string, unknown>> {
  const { results } = await env.DB.prepare(
    `SELECT id, checks, ok_checks, fail_checks, retry_recoveries, sum_latency_ms, min_latency_ms,
            max_latency_ms, monitored_seconds, down_seconds
       FROM summaries WHERE period IN ('day', 'month') ORDER BY id`,
  ).all<{ id: string }>();
  return new Map(results.map((r) => [r.id, r]));
}

/** Seeds HISTORY_DAYS of hour rows for every monitor, ending the hour before `now`. */
async function seedHistory(now: number) {
  await env.DB.prepare(
    `WITH RECURSIVE h(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM h WHERE n < ?2)
     INSERT OR IGNORE INTO summaries
       (id, monitor_id, period, bucket_start, checks, ok_checks, fail_checks, sum_latency_ms,
        min_latency_ms, max_latency_ms, monitored_seconds, down_seconds)
     SELECT m.id || ':hour:' || ((?1 / 3600000 - n) * 3600000), m.id, 'hour', (?1 / 3600000 - n) * 3600000,
            5, 5 - (n % 7 = 0), n % 7 = 0, 400 + n % 50, 60 + n % 11, 140 + n % 13, 3600, 720 * (n % 7 = 0)
       FROM monitors m, h`,
  )
    .bind(now, HISTORY_DAYS * 24)
    .run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
  for (let i = 0; i < MONITORS; i++) {
    const res = await apiRequest("/api/monitors", {
      method: "POST",
      body: JSON.stringify({ type: "http", name: `History ${i}`, config: { url: `https://h${i}.example.com/` } }),
    });
    expect(res.status).toBe(201);
  }
  vi.restoreAllMocks();
  await seedHistory(Date.now());
});

afterEach(() => vi.restoreAllMocks());

describe("history rollups", () => {
  it("an incremental pass gives the same day and month totals as a full recompute", async () => {
    const retention = resolveRetention(null);
    const now = Date.now();
    await env.DB.batch(compactionStatements(env, now, retention, null).map((s) => s.stmt));
    const full = await derived();
    expect(full.size).toBeGreaterThan(MONITORS * HISTORY_DAYS);

    // New checks land in the current hour, as a run's writes do.
    await env.DB.prepare(
      `UPDATE summaries SET checks = checks + 3, ok_checks = ok_checks + 2, fail_checks = fail_checks + 1,
              down_seconds = down_seconds + 60, monitored_seconds = monitored_seconds + 180
        WHERE period = 'hour' AND bucket_start = (SELECT MAX(bucket_start) FROM summaries WHERE period = 'hour')`,
    ).run();
    const rows = { read: 0, written: 0 };
    const measured = { ...env, DB: rowsD1(env.DB, rows) };
    await measured.DB.batch(compactionStatements(measured, now + 12 * 60_000, retention, now).map((s) => s.stmt));
    const incremental = await derived();
    // The pass read at most two days of hour rows and two months of day rows
    // per monitor (a full recompute reads all 63 days of hour rows), and wrote
    // only the day and the month that changed for each.
    expect(rows.written).toBe(2 * MONITORS);
    expect(rows.read).toBeLessThan(MONITORS * (2 * 24 + 62 + 20));

    await env.DB.batch(compactionStatements(env, now + 12 * 60_000, retention, null).map((s) => s.stmt));
    expect(incremental).toEqual(await derived());
    // Only the day and the month that changed were rewritten, for each monitor.
    const changed = [...incremental].filter(([id, row]) => JSON.stringify(full.get(id)) !== JSON.stringify(row));
    expect(changed.length).toBe(2 * MONITORS);
  });

  it("a scheduler run on a two-month-old install reads and writes only recent rows", async () => {
    // The first run after an update recomputes everything once (no finished run to start from).
    await measuredRun();
    const idle = await measuredRun();
    // Before: 1,347 rows written and about 160,000 read by every run, checking
    // nothing, on this install (20 monitors, 63 days of history). That is
    // about 160,000 writes and 19 million reads a day at the 12-minute
    // cadence, past the Free plan's 100,000 and 5 million.
    expect(idle.written).toBeLessThan(50);
    expect(idle.read).toBeLessThan(5_000);
  }, 60_000);
});
