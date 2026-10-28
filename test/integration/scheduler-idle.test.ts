import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { countingD1 } from "../../src/worker/lib/budget";
import { runScheduled } from "../../src/worker/scheduler";

// A cron run whose monitors are all outside their schedule checks nothing, so
// its wall time is just its D1 round trips. Cron Triggers run on whichever
// Cloudflare machine has spare capacity, often far from the database, and in
// production one round trip from a cron run measured about 160 ms. This suite
// reproduces that: it seeds an install shaped like the live one (three
// business-hours monitors, about three weeks of hourly history) and runs the
// scheduler against a D1 binding that adds that delay to every round trip.

const API_ORIGIN = "https://openping.test";
const ROUND_TRIP_MS = 160;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer integration-api-token");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

const controller: ScheduledController = {
  cron: "*/12 * * * *",
  scheduledTime: Date.now(),
  noRetry() {},
};

/** A D1 binding where every round trip (a query, or a whole batch) takes `ms` longer. */
function slowD1(db: D1Database, ms: number): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const wait = () => new Promise((resolve) => setTimeout(resolve, ms));
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (prop === "first" || prop === "run" || prop === "all" || prop === "raw") {
          const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => Promise<unknown>;
          return async (...args: unknown[]) => {
            await wait();
            return fn.apply(target, args);
          };
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
        return async (statements: D1PreparedStatement[]) => {
          await wait();
          return target.batch(statements.map((s) => real.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A business-hours schedule that is off for the whole of today and tomorrow (UTC). */
function offTodaySchedule() {
  const today = new Date().getUTCDay();
  return {
    mode: "business_hours",
    weekdays: [(today + 3) % 7, (today + 4) % 7],
    start: "08:00",
    end: "17:00",
    timezone: "UTC",
  };
}

async function latestRun() {
  return env.DB.prepare(
    `SELECT monitors_checked, monitors_skipped, duration_ms, d1_queries
       FROM scheduler_runs ORDER BY started_at DESC LIMIT 1`,
  ).first<{
    monitors_checked: number;
    monitors_skipped: number;
    duration_ms: number;
    d1_queries: number | null;
  }>();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await apiRequest("/api/monitors", {
      method: "POST",
      body: JSON.stringify({
        type: "http",
        name: `Office hours ${i}`,
        config: { url: `https://app${i}.example.com/` },
        schedule: offTodaySchedule(),
      }),
    });
    expect(res.status).toBe(201);
    ids.push(((await res.json()) as { monitor: { id: string } }).monitor.id);
  }

  // About three weeks of business-day history per monitor, like the live install.
  const now = Date.now();
  const rows: D1PreparedStatement[] = [];
  for (const id of ids) {
    for (let d = 1; d <= 22; d++) {
      const day = now - (now % DAY_MS) - d * DAY_MS;
      for (let h = 15; h < 24; h++) {
        const bucket = day + h * HOUR_MS;
        rows.push(
          env.DB.prepare(
            `INSERT INTO summaries (id, monitor_id, period, bucket_start, checks, ok_checks,
               fail_checks, retry_recoveries, sum_latency_ms, monitored_seconds, down_seconds)
             VALUES (?, ?, 'hour', ?, 5, 5, 0, 0, 900, 3600, 0)`,
          ).bind(`${id}:hour:${bucket}`, id, bucket),
        );
      }
    }
  }
  await env.DB.batch(rows);
});

describe("an off-hours cron run", () => {
  it("checks nothing, records its D1 round trips, and finishes in a handful of them", async () => {
    // The first run moves every monitor to scheduled_off; the later ones are
    // the steady state the live install sits in outside office hours.
    await runScheduled(controller, env);
    const first = await latestRun();
    expect(first?.monitors_checked).toBe(0);

    const usage = { d1: 0 };
    const fetches = vi.spyOn(globalThis, "fetch");
    await runScheduled(controller, { ...env, DB: countingD1(slowD1(env.DB, ROUND_TRIP_MS), usage) });
    expect(fetches).not.toHaveBeenCalled();
    fetches.mockRestore();

    const run = await latestRun();
    console.log(
      `[idle] round trips per off-hours run: ${usage.d1}, duration ${run?.duration_ms} ms at ${ROUND_TRIP_MS} ms each`,
    );
    expect(run).toMatchObject({ monitors_checked: 0, monitors_skipped: 3 });
    // The run records its own total, the final batch included.
    expect(run?.d1_queries).toBe(usage.d1);
    // Start, end-of-run work, finish: three round trips.
    expect(usage.d1).toBe(3);
    // Well under a second even when every round trip is slow.
    expect(run?.duration_ms).toBeLessThan(1000);
  });

  it("writes nothing when another run holds the lease", async () => {
    const count = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduler_runs").first<{ n: number }>())?.n ?? 0;
    const before = await count();
    await env.DB.prepare(
      "INSERT INTO locks (name, holder, acquired_at, expires_at) VALUES ('scheduler', 'other-run', ?, ?)",
    )
      .bind(Date.now(), Date.now() + 60_000)
      .run();

    const usage = { d1: 0 };
    await runScheduled(controller, { ...env, DB: countingD1(env.DB, usage) });

    expect(usage.d1).toBe(1);
    expect(await count()).toBe(before);
    const lock = await env.DB.prepare("SELECT holder FROM locks WHERE name = 'scheduler'").first<{
      holder: string;
    }>();
    expect(lock?.holder).toBe("other-run");
    await env.DB.prepare("DELETE FROM locks").run();
  });

  it("releases the lease and records the run for the next tick", async () => {
    await runScheduled(controller, env);
    const locks = await env.DB.prepare("SELECT COUNT(*) AS n FROM locks").first<{ n: number }>();
    expect(locks?.n).toBe(0);
    const run = await latestRun();
    expect(run?.d1_queries).toBe(3);
  });
});
