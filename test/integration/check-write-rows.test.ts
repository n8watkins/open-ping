import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { createMonitor, type MonitorRecord } from "../../src/worker/db/monitors";
import { applyCheckResult, recordHeartbeat } from "../../src/worker/checks/state";
import type { CheckOutcome } from "../../src/worker/checks/types";
import { compactionStatements, resolveRetention } from "../../src/worker/history/rollups";
import { createMonitorSchema } from "../../src/shared/schemas";
import { rowsD1, type Rows } from "./d1-rows";

/**
 * How many D1 rows one check writes (D1 bills each row written, its index
 * entries included: docs/HOSTED_PLAN.md, "Cost per customer, measured").
 *
 * A passing check that changes nothing but the numbers writes the monitor's
 * state (with its next-check index entry) and adds itself to its hour's
 * summary, which also keeps its time, response time and status code for the
 * 24-hour views: 3 rows. Only a check with something more to say (a failure,
 * a state change, a warm-up, a blip a re-check cleared, a beat's message) adds
 * a full sample row, and the status timeline is written only when the state
 * changes.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Mid-hour, so the next checks land in an hour summary that already exists. */
const T0 = Date.UTC(2026, 9, 26, 6, 20, 0);

const up = (at: number, extra: Partial<CheckOutcome> = {}): CheckOutcome => ({
  state: "up",
  ok: true,
  durationMs: 120,
  statusCode: 200,
  attempts: 1,
  warmup: false,
  retryRecovered: false,
  fetches: 1,
  at,
  ...extra,
});

const down = (at: number): CheckOutcome => ({
  ...up(at),
  state: "down",
  ok: false,
  durationMs: undefined,
  statusCode: undefined,
  error: "timeout",
  attempts: 2,
  confirmation: "confirmed",
});

async function http(name: string): Promise<MonitorRecord> {
  return createMonitor(
    env,
    createMonitorSchema.parse({ type: "http", name, config: { url: "https://rows.example.com/" }, confirmFailures: "off" }),
  );
}

/** The rows `fn` writes through the real write path. */
async function written(fn: (e: typeof env) => Promise<unknown>): Promise<number> {
  const rows: Rows = { read: 0, written: 0 };
  await fn({ ...env, DB: rowsD1(env.DB, rows) });
  return rows.written;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 - MINUTE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rows one check writes", () => {
  it("a passing check that changes nothing: 3 rows, and no sample row", async () => {
    const m = await http("Steady");
    await applyCheckResult(env, m, up(T0));
    await applyCheckResult(env, m, up(T0 + MINUTE));
    const samplesBefore = await count("SELECT COUNT(*) AS n FROM samples WHERE monitor_id = ?", m.id);
    vi.setSystemTime(T0 + 2 * MINUTE);
    expect(await written((e) => applyCheckResult(e, m, up(T0 + 2 * MINUTE, { durationMs: 340 })))).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM samples WHERE monitor_id = ?", m.id)).toBe(samplesBefore);
  });

  it("the first check of an hour also starts its summary: 6 rows", async () => {
    const m = await http("New hour");
    await applyCheckResult(env, m, up(T0));
    const next = T0 - (T0 % HOUR) + HOUR + 5_000;
    vi.setSystemTime(next);
    expect(await written((e) => applyCheckResult(e, m, up(next)))).toBe(6);
  });

  it("a DNS check that resolves the same: 3 rows, its records kept for the monitor page", async () => {
    const m = await createMonitor(
      env,
      createMonitorSchema.parse({ type: "dns", name: "Records", config: { hostname: "rows.example.com", recordType: "A" } }),
    );
    const meta = { records: ["192.0.2.7"] };
    await applyCheckResult(env, m, up(T0, { statusCode: undefined, meta }));
    vi.setSystemTime(T0 + MINUTE);
    expect(await written((e) => applyCheckResult(e, m, up(T0 + MINUTE, { statusCode: undefined, meta })))).toBe(3);
  });

  it("a failing check keeps its full sample, but the unchanged timeline costs nothing", async () => {
    const m = await http("Failing");
    await applyCheckResult(env, m, up(T0));
    await applyCheckResult(env, m, down(T0 + MINUTE));
    vi.setSystemTime(T0 + 2 * MINUTE);
    // State 2, sample 3, hour summary 1, the open incident's observation 1.
    expect(await written((e) => applyCheckResult(e, m, down(T0 + 2 * MINUTE)))).toBe(7);
  });

  it("a beat without a message: 3 rows; one with a message keeps its sample", async () => {
    const hb = await createMonitor(
      env,
      createMonitorSchema.parse({ type: "heartbeat", name: "Beats", config: { intervalSeconds: 300, graceSeconds: 60 } }),
    );
    await recordHeartbeat(env, hb, { at: T0 });
    vi.setSystemTime(T0 + MINUTE);
    expect(await written((e) => recordHeartbeat(e, hb, { at: T0 + MINUTE, durationMs: 900 }))).toBe(3);
    vi.setSystemTime(T0 + 2 * MINUTE);
    expect(await written((e) => recordHeartbeat(e, hb, { at: T0 + 2 * MINUTE, message: "nightly ok" }))).toBe(6);
  });

  it("the upkeep clears an hour's check times once, after a day, a row for each hour", async () => {
    const m = await http("Pruned");
    for (let k = 0; k < 4; k++) await applyCheckResult(env, m, up(T0 + k * MINUTE));
    const retention = resolveRetention(null);
    const later = T0 + 26 * HOUR;
    const run = (e: typeof env, since: number | null) =>
      e.DB.batch(compactionStatements(e, later, retention, since).map((s) => s.stmt));
    await run(env, later - 12 * MINUTE);
    const left = await count(
      "SELECT COUNT(*) AS n FROM summaries WHERE monitor_id = ? AND period = 'hour' AND check_log IS NOT NULL",
      m.id,
    );
    expect(left).toBe(0);
    // Nothing is left to clear, so the next pass writes nothing for it.
    expect(await written((e) => run(e, later))).toBe(0);
  });
});
