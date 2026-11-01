// The load test report's arithmetic, pinned.

import { describe, expect, it } from "vitest";
import { analyticsRequest, isUnknownFieldError, parseAnalytics } from "./analytics.mjs";
import { answer } from "./echo-worker/index.js";
import { MINUTE_MS, buildReport, collectRuns, costPerTenantMonth, missedRuns, percentile, renderReport } from "./report.mjs";

const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
const W = { windowStart: T0, windowEnd: T0 + 60 * MINUTE_MS, intervalMs: 12 * MINUTE_MS };

describe("percentile", () => {
  it("is the nearest rank", () => {
    const values = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile(values, 100)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("missed runs", () => {
  const every12 = (offset) => Array.from({ length: 5 }, (_, i) => T0 + offset + i * 12 * MINUTE_MS);

  it("are none for a tenant run every 12 minutes, whatever its phase", () => {
    for (const offset of [0, MINUTE_MS, 11 * MINUTE_MS]) expect(missedRuns(every12(offset), W)).toBe(0);
  });

  it("are none for runs a little late (that is queue lag)", () => {
    expect(missedRuns([T0 + MINUTE_MS, T0 + 14 * MINUTE_MS, T0 + 27 * MINUTE_MS, T0 + 40 * MINUTE_MS, T0 + 53 * MINUTE_MS], W)).toBe(0);
  });

  it("count a skipped run, and two", () => {
    const runs = every12(MINUTE_MS);
    expect(missedRuns(runs.filter((_, i) => i !== 2), W)).toBe(1);
    expect(missedRuns(runs.filter((_, i) => i !== 2 && i !== 3), W)).toBe(2);
  });

  it("count runs that stopped before the window ended, or started late", () => {
    expect(missedRuns(every12(MINUTE_MS).slice(0, 3), W)).toBe(2);
    // At the window's start the tenant's phase is unknown, so a late start counts what must at least have been missed.
    expect(missedRuns(every12(MINUTE_MS).slice(2), W)).toBe(1);
  });

  it("are every interval for a tenant that never ran", () => {
    expect(missedRuns([], W)).toBe(5);
  });
});

describe("collecting runs from snapshots", () => {
  it("counts each run once, however many snapshots saw it, and only inside the window", () => {
    const row = (run, at, extra = {}) => ({ tenant_id: "t1", last_run_id: run, last_at: at, last_outcome: "ran", last_lag_ms: 3000, last_duration_ms: 800, last_checked: 20, last_failures: 1, ...extra });
    const snapshots = [
      { at: T0 - MINUTE_MS, rows: [row("r0", T0 - 5 * MINUTE_MS)] },
      { at: T0 + MINUTE_MS, rows: [row("r1", T0 + 30_000)] },
      { at: T0 + 2 * MINUTE_MS, rows: [row("r1", T0 + 30_000)] },
      { at: T0 + 13 * MINUTE_MS, rows: [row("r2", T0 + 12.5 * MINUTE_MS, { last_lag_ms: 9000 })] },
    ];
    const runs = collectRuns(snapshots, W).get("t1");
    expect(runs.map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(runs[1].lagMs).toBe(9000);
  });
});

describe("cost per tenant a month", () => {
  it("scales one hour of one tenant's use to a month at the prices past the allowances", () => {
    // 200 tenants for an hour: 1,000 runs, 200 * 1,000 rows written in their databases, 2,000 in the platform's.
    const cost = costPerTenantMonth({
      windowMs: 3_600_000,
      tenants: 200,
      runs: 1000,
      d1: { rowsWritten: 200_000, rowsRead: 1_000_000 },
      platformD1: { rowsWritten: 5_000, rowsRead: 20_000 },
      workers: { requests: 1000, cpuMs: 20_000 },
    });
    // Per tenant a month (720 hours): 720,000 rows written ($0.72), 3.6 million read ($0.0036),
    // the platform's 18,000 ($0.018), 3,600 requests ($0.00108), 3 queue operations a run ($0.00432), 72,000 CPU ms ($0.00144).
    expect(cost.lines.tenantRowsWritten).toBeCloseTo(0.72, 6);
    expect(cost.lines.tenantRowsRead).toBeCloseTo(0.0036, 6);
    expect(cost.lines.platformRowsWritten).toBeCloseTo(0.018, 6);
    expect(cost.lines.requests).toBeCloseTo(0.00108, 6);
    expect(cost.lines.queue).toBeCloseTo(0.00432, 6);
    expect(cost.lines.cpu).toBeCloseTo(0.00144, 6);
    expect(cost.total).toBeCloseTo(0.72 + 0.0036 + 0.018 + 0.000072 + 0.00108 + 0.00432 + 0.00144, 6);
  });

  it("is not measured without the tenants' own D1 rows", () => {
    expect(costPerTenantMonth({ windowMs: 3_600_000, tenants: 2, runs: 10 }).total).toBeNull();
  });
});

function state({ runsOf = () => [0, 12, 24, 36, 48], lagMs = 4000, outcome = "ran", health = 200, analytics = true } = {}) {
  const tenants = [1, 2].map((n) => ({ tenantId: `t${n}`, slug: `lt-abcd-00${n}`, d1Id: `db${n}` }));
  const snapshots = [];
  for (const t of tenants) {
    for (const m of runsOf(t.tenantId)) {
      snapshots.push({ at: T0 + (m + 1) * MINUTE_MS, rows: [{ tenant_id: t.tenantId, last_run_id: `${t.tenantId}-${m}`, last_at: T0 + m * MINUTE_MS + 5000, last_outcome: outcome, last_lag_ms: lagMs, last_duration_ms: 900, last_checked: 20, last_failures: 1 }] });
    }
  }
  return {
    window: { windowStart: T0, windowEnd: T0 + 60 * MINUTE_MS },
    intervalMinutes: 12,
    monitorsPerTenant: 20,
    tenants,
    snapshots,
    health: Array.from({ length: 60 }, (_, i) => ({ at: T0 + i * MINUTE_MS, status: i === 30 ? health : 200, ok: !(i === 30 && health !== 200), checks: { database: true, scheduler: i === 30 && health !== 200 ? false : true } })),
    minutes: [{ minute: 1, runs: 10, errors: 0, timeouts: 0, busy: 0, lag_max_ms: lagMs }],
    platformDatabaseId: "platform",
    analytics: analytics
      ? {
          d1: [
            { databaseId: "db1", rowsRead: 5000, rowsWritten: 1000 },
            { databaseId: "db2", rowsRead: 5000, rowsWritten: 1000 },
            { databaseId: "platform", rowsRead: 100, rowsWritten: 50 },
            { databaseId: "someone-else", rowsRead: 9e9, rowsWritten: 9e9 },
          ],
          workers: [
            { scriptName: "t-t1", requests: 5, errors: 0, cpuTimeP50: 8000, cpuTimeP99: 20000 },
            { scriptName: "t-t2", requests: 5, errors: 0, cpuTimeP50: 9000, cpuTimeP99: 30000 },
          ],
        }
      : null,
  };
}

describe("the report", () => {
  it("passes a clean hour", () => {
    const r = buildReport(state());
    expect(r.verdict).toBe("pass");
    expect(r.runs).toMatchObject({ total: 10, expected: 10, missed: 0, checked: 200, failedChecks: 10 });
    expect(r.queueLagMs).toEqual({ p50: 4000, p95: 4000, max: 4000 });
    // Other databases in the account are left out.
    expect(r.d1PerTenant).toEqual({ rowsRead: 5000, rowsWritten: 1000 });
    expect(r.cost.total).toBeLessThan(0.83);
    const text = renderReport(r);
    expect(text).toMatch(/^# Load test report: PASS/);
    expect(text).toContain("| No missed scheduler runs | 0 | 0 | pass |");
    expect(text).not.toContain("\u2014");
  });

  it("fails on a missed run, naming the tenant", () => {
    const r = buildReport(state({ runsOf: (id) => (id === "t2" ? [0, 12, 36, 48] : [0, 12, 24, 36, 48]) }));
    expect(r.verdict).toBe("fail");
    expect(r.runs.missed).toBe(1);
    expect(r.runs.worst).toEqual([{ tenantId: "t2", slug: "lt-abcd-002", missed: 1, runs: 4 }]);
  });

  it("fails on queue lag of a minute or more", () => {
    const r = buildReport(state({ lagMs: 61_000 }));
    expect(r.criteria.find((c) => c.name.startsWith("Queue lag")).pass).toBe(false);
  });

  it("fails on runs without a clean answer, and on a failed health check", () => {
    expect(buildReport(state({ outcome: "timeout" })).criteria.find((c) => c.name.startsWith("Runs without")).pass).toBe(false);
    const r = buildReport(state({ health: 503 }));
    expect(r.verdict).toBe("fail");
    expect(r.health.failingChecks).toEqual({ scheduler: 1 });
  });

  it("is incomplete, not a pass, without the analytics", () => {
    const r = buildReport(state({ analytics: false }));
    expect(r.verdict).toBe("incomplete");
    expect(renderReport(r)).toContain("not measured");
  });

  it("fails when a tenant costs more than the cost model's $0.83", () => {
    const s = state();
    s.analytics.d1 = s.analytics.d1.map((d) => (d.databaseId.startsWith("db") ? { ...d, rowsWritten: 2000 } : d));
    // 2,000 rows an hour is 1.44 million a month: $1.44.
    const r = buildReport(s);
    expect(r.cost.total).toBeGreaterThan(1.44);
    expect(r.criteria.find((c) => c.name.startsWith("Cost")).pass).toBe(false);
  });
});

describe("GraphQL Analytics", () => {
  it("asks by minute, or by whole hours scaled to the window", () => {
    const start = Date.UTC(2026, 10, 2, 10, 13);
    const end = start + 3_600_000;
    expect(analyticsRequest({ accountId: "a", start, end, databaseIds: [], scriptNames: [] }).d1Scale).toBe(1);
    const hourly = analyticsRequest({ accountId: "a", start, end, databaseIds: ["d"], scriptNames: ["t-x"], granularity: "hour" });
    expect(hourly.body.variables.d1Start).toBe("2026-11-02T10:00:00.000Z");
    expect(hourly.body.variables.d1End).toBe("2026-11-02T11:00:00.000Z");
    expect(hourly.d1Scale).toBe(0.5);
    expect(hourly.body.query).toContain("datetimeHour_geq");
  });

  it("reads the answer, scaled, and says what went wrong", () => {
    const json = { data: { viewer: { accounts: [{ d1: [{ dimensions: { databaseId: "d" }, sum: { rowsRead: 10, rowsWritten: 4 } }], workers: [{ dimensions: { scriptName: "t-x" }, sum: { requests: 3, errors: 0 }, quantiles: { cpuTimeP50: 1, cpuTimeP99: 2 } }] }] } } };
    expect(parseAnalytics(json, { d1Scale: 0.5 })).toMatchObject({ d1: [{ databaseId: "d", rowsRead: 5, rowsWritten: 2 }], workers: [{ scriptName: "t-x", requests: 3, cpuTimeP99: 2 }] });
    expect(parseAnalytics({ errors: [{ message: "unknown field datetimeMinute_geq" }] }).error).toMatch(/datetimeMinute/);
    expect(isUnknownFieldError("unknown field datetimeMinute_geq")).toBe(true);
    expect(parseAnalytics({ data: { viewer: { accounts: [] } } }).error).toMatch(/no account/);
  });
});

describe("the echo Worker", () => {
  const at = (minute) => Date.UTC(2026, 10, 2, 10, minute);
  it("answers ok, slow, flaky about rate% of minutes, and down in its window", () => {
    expect(answer(new URL("https://e/ok"), at(0))).toEqual({ status: 200 });
    expect(answer(new URL("https://e/slow?ms=1500"), at(0))).toEqual({ status: 200, delayMs: 1500 });
    expect(answer(new URL("https://e/slow?ms=999999"), at(0)).delayMs).toBe(10_000);
    expect(answer(new URL("https://e/window?down=20-29"), at(25)).status).toBe(503);
    expect(answer(new URL("https://e/window?down=20-29"), at(30)).status).toBe(200);
    const down = Array.from({ length: 1000 }, (_, i) => answer(new URL("https://e/flaky?rate=10&m=3"), at(0) + i * 60_000).status).filter((s) => s === 500).length;
    expect(down).toBeGreaterThan(50);
    expect(down).toBeLessThan(150);
    expect(answer(new URL("https://e/other"), at(0)).status).toBe(404);
  });
});
