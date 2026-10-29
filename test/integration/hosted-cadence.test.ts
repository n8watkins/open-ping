import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { createMonitor } from "../../src/worker/db/monitors";
import { PLAN_BUDGETS } from "../../src/worker/lib/budget";
import { CRON_CADENCE, platformCadence, type Cadence } from "../../src/worker/lib/cadence";
import { runScheduled, type RunResult } from "../../src/worker/scheduler";
import { createMonitorSchema } from "../../src/shared/schemas";
import { nextScheduledCall, SCHEDULED_MAX_GAP_MS } from "../../src/shared/hosted-contract";

/**
 * Per-monitor check intervals on OpenPing Hosted (lib/cadence.ts), through the
 * real scheduler and D1, with the platform's minute ticks played out on a fake
 * clock: which monitors each call checks, the nextDueAt it answers, how often
 * the tenant ends up being called, the upkeep and run records once per 12
 * minutes, and history that stays right with a sample every minute.
 */

type Ran = Exclude<RunResult, { outcome: "lease_busy" }>;

const MINUTE = 60_000;
/** A 12-minute mark of the clock, so the upkeep slots line up with the test's ticks. */
const T0 = Date.UTC(2026, 9, 26, 6, 0, 0);
const FAST = platformCadence(1);
const STANDARD = platformCadence(12);

async function addMonitor(name: string, extra: Record<string, unknown> = {}) {
  const input = createMonitorSchema.parse({
    type: "http",
    name,
    config: { url: `https://${name.toLowerCase().replace(/\W+/g, "-")}.example.com/` },
    confirmFailures: "off",
    ...extra,
  });
  return createMonitor(env, input);
}

/** One platform call for the tick at `at` (the queue delivers it `lateMs` later). */
async function tick(at: number, cadence: Cadence, lateMs = 0): Promise<Ran> {
  vi.setSystemTime(at + lateMs);
  const result = await runScheduled(
    { cron: "* * * * *", scheduledTime: at, noRetry() {} },
    env,
    { cadence, budget: PLAN_BUDGETS.hosted, confirmDelayMs: 0 },
  );
  expect(result.outcome).toBe("ran");
  return result as Ran;
}

/** The platform's rule (shared/hosted-contract.ts): the first minute tick at or after the next call. */
function nextTick(result: RunResult, now: number): number {
  const summary = { outcome: result.outcome, startedAt: result.startedAt, nextDueAt: "nextDueAt" in result ? result.nextDueAt : undefined };
  return Math.max(now + MINUTE, Math.ceil(nextScheduledCall(summary, now) / MINUTE) * MINUTE);
}

async function samplesOf(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM samples WHERE monitor_id = ?").bind(id).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Monitors are created a minute before the first tick, so they are due on it.
  vi.setSystemTime(T0 - MINUTE);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM monitors"),
    env.DB.prepare("DELETE FROM samples"),
    env.DB.prepare("DELETE FROM summaries"),
    env.DB.prepare("DELETE FROM scheduler_runs"),
    env.DB.prepare("DELETE FROM locks"),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("per-monitor intervals on the platform", () => {
  it("checks a 1-minute monitor on every tick and a 12-minute one on every 12th", async () => {
    const fast = await addMonitor("Fast", { intervalSeconds: 60 });
    const slow = await addMonitor("Slow");
    for (let k = 0; k <= 24; k++) {
      // A few seconds of queue delay never pushes a check to the next tick.
      const result = await tick(T0 + k * MINUTE, FAST, (k % 3) * 4_000);
      expect(result.nextDueAt).toBe(T0 + (k + 1) * MINUTE - 30_000);
    }
    expect(await samplesOf(fast.id)).toBe(25);
    expect(await samplesOf(slow.id)).toBe(3);
  });

  it("calls a tenant of 12-minute monitors once per 12 minutes, whatever their phase", async () => {
    const a = await addMonitor("Phase A");
    const b = await addMonitor("Phase B");
    // B was created five minutes after A, and first checked then.
    await env.DB.prepare("UPDATE monitor_state SET next_check_at = ? WHERE monitor_id = ?")
      .bind(T0 + 5 * MINUTE + 20_000, b.id)
      .run();
    const calls: number[] = [];
    let at = T0;
    while (at < T0 + 2 * 60 * MINUTE) {
      calls.push(at);
      at = nextTick(await tick(at, STANDARD), at);
    }
    // B lines up with A after its first check; from then on, one call per 12 minutes.
    const gaps = calls.slice(1).map((t, i) => (t - calls[i]!) / MINUTE);
    expect(gaps.slice(2).every((g) => g === 12)).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(11);
    expect(await samplesOf(a.id)).toBe(10);
    expect(await samplesOf(b.id)).toBeGreaterThanOrEqual(10);
  });

  it("checks a 1-minute monitor at the plan's fastest after a downgrade", async () => {
    const fast = await addMonitor("Downgraded", { intervalSeconds: 60 });
    for (let k = 0; k <= 24; k++) await tick(T0 + k * MINUTE, STANDARD);
    expect(await samplesOf(fast.id)).toBe(3);
    const stored = await env.DB.prepare("SELECT interval_seconds FROM monitors WHERE id = ?").bind(fast.id).first();
    expect(stored).toEqual({ interval_seconds: 60 });
  });

  it("keeps one run record and does the upkeep once per 12 minutes", async () => {
    await addMonitor("Fast", { intervalSeconds: 60 });
    const upkeep: boolean[] = [];
    for (let k = 0; k < 24; k++) upkeep.push((await tick(T0 + k * MINUTE, FAST)).upkeep);
    expect(upkeep.map((u, k) => (u ? k : -1)).filter((k) => k >= 0)).toEqual([0, 12]);
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduler_runs").first<{ n: number }>();
    expect(runs?.n).toBe(2);
    // The day summary still follows every check, once per 12 minutes.
    const day = await env.DB.prepare("SELECT checks FROM summaries WHERE period = 'day'").first<{ checks: number }>();
    expect(day?.checks).toBe(13);
  });

  it("keeps uptime and downtime right with a sample every minute", async () => {
    const fast = await addMonitor("Flaky", { intervalSeconds: 60 });
    const failing = new Set([3, 4, 5, 9]);
    for (let k = 0; k < 12; k++) {
      vi.mocked(globalThis.fetch).mockImplementation(async () => new Response("x", { status: failing.has(k) ? 500 : 200 }));
      await tick(T0 + k * MINUTE, FAST);
    }
    const hour = await env.DB.prepare(
      "SELECT checks, ok_checks, monitored_seconds, down_seconds FROM summaries WHERE monitor_id = ? AND period = 'hour'",
    )
      .bind(fast.id)
      .first();
    // Each check accounts for one minute.
    expect(hour).toEqual({ checks: 12, ok_checks: 8, monitored_seconds: 12 * 60, down_seconds: 4 * 60 });
  });

  it("marks a silent heartbeat missed once per 12 minutes, so its downtime isn't counted 12 times", async () => {
    const input = createMonitorSchema.parse({
      type: "heartbeat",
      name: "Nightly job",
      config: { intervalSeconds: 60, graceSeconds: 0 },
    });
    const hb = await createMonitor(env, input);
    await env.DB.prepare("UPDATE monitor_state SET state = 'up', last_beat_at = ? WHERE monitor_id = ?")
      .bind(T0 - 10 * MINUTE, hb.id)
      .run();
    for (let k = 0; k <= 24; k++) await tick(T0 + k * MINUTE, FAST);
    const down = await env.DB.prepare(
      "SELECT SUM(down_seconds) AS s FROM summaries WHERE monitor_id = ? AND period = 'hour'",
    )
      .bind(hb.id)
      .first<{ s: number }>();
    expect(down?.s).toBe(3 * 720);
  });

  it("answers a heartbeat's deadline as the time it next has work", async () => {
    const input = createMonitorSchema.parse({
      type: "heartbeat",
      name: "Every five minutes",
      config: { intervalSeconds: 300, graceSeconds: 60 },
    });
    const hb = await createMonitor(env, input);
    await env.DB.prepare("UPDATE monitor_state SET state = 'up', last_beat_at = ? WHERE monitor_id = ?")
      .bind(T0, hb.id)
      .run();
    const result = await tick(T0 + MINUTE, STANDARD);
    expect(result.nextDueAt).toBe(T0 + 6 * MINUTE + 1);
  });

  it("asks to be called at once when the budget left a due check for later", async () => {
    for (let i = 0; i < 3; i++) await addMonitor(`Backlog ${i}`, { intervalSeconds: 60 });
    vi.setSystemTime(T0);
    const result = await runScheduled({ cron: "* * * * *", scheduledTime: T0, noRetry() {} }, env, {
      cadence: FAST,
      budget: { ...PLAN_BUDGETS.hosted, maxChecks: 2 },
      confirmDelayMs: 0,
    });
    expect(result.outcome).toBe("ran");
    expect((result as Ran).nextDueAt).toBe(T0);
  });

  it("never asks to wait longer than 12 minutes", async () => {
    await addMonitor("Hourly", { intervalSeconds: 3600 });
    const result = await tick(T0, STANDARD);
    expect(result.nextDueAt).toBe(T0 + SCHEDULED_MAX_GAP_MS);
  });
});

describe("a plain install's cron", () => {
  it("still checks every polled monitor on each 12-minute run, whatever interval is stored", async () => {
    const fast = await addMonitor("Brought over from Hosted", { intervalSeconds: 60 });
    const slow = await addMonitor("Hourly", { intervalSeconds: 3600 });
    for (let k = 0; k < 3; k++) {
      vi.setSystemTime(T0 + k * 12 * MINUTE);
      await runScheduled({ cron: "*/12 * * * *", scheduledTime: T0 + k * 12 * MINUTE, noRetry() {} }, env, {
        cadence: CRON_CADENCE,
        confirmDelayMs: 0,
      });
    }
    expect(await samplesOf(fast.id)).toBe(3);
    expect(await samplesOf(slow.id)).toBe(3);
    const next = await env.DB.prepare("SELECT next_check_at FROM monitor_state WHERE monitor_id = ?")
      .bind(fast.id)
      .first<{ next_check_at: number }>();
    // One cron interval after the last check, as before.
    expect(next!.next_check_at - (T0 + 24 * MINUTE)).toBeGreaterThanOrEqual(12 * MINUTE);
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduler_runs").first<{ n: number }>();
    expect(runs?.n).toBe(3);
  });
});
