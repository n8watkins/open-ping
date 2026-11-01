import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { createMonitor, type MonitorRecord } from "../../src/worker/db/monitors";
import { setSetting } from "../../src/worker/db/settings";
import { applyCheckResult } from "../../src/worker/checks/state";
import type { CheckOutcome } from "../../src/worker/checks/types";
import { compactionStatements, resolveRetention } from "../../src/worker/history/rollups";
import { loadRangeHistory } from "../../src/worker/history/range";
import { createMonitorSchema } from "../../src/shared/schemas";

/**
 * With a sample retention shorter than a day, the 24-hour views show only the
 * checks still inside it: a passing check its hour summary logged is no older
 * than the oldest sample row kept, so failures and passes age out together.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Fixed and mid-hour, so nothing depends on the wall clock. */
const T_START = Date.UTC(2026, 9, 20, 3, 7, 13);
const T_END = T_START + 10 * HOUR;
const SAMPLE_HOURS = 6;

let monitor: MonitorRecord;
const checks: { at: number; ok: boolean }[] = [];

const outcome = (at: number, ok: boolean): CheckOutcome => ({
  state: ok ? "up" : "down",
  ok,
  durationMs: ok ? 100 + (at % 97) : undefined,
  statusCode: ok ? 200 : undefined,
  error: ok ? undefined : "timeout",
  attempts: ok ? 1 : 2,
  confirmation: ok ? undefined : "confirmed",
  warmup: false,
  retryRecovered: false,
  fetches: 1,
  at,
});

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T_START - MINUTE);
  await setSetting(env, "retention", JSON.stringify({ sampleHours: SAMPLE_HOURS }));
  monitor = await createMonitor(
    env,
    createMonitorSchema.parse({ type: "http", name: "Short", config: { url: "https://short.example.com/" } }),
  );
  const retention = resolveRetention({ sampleHours: SAMPLE_HOURS });
  let since: number | null = null;
  for (let at = T_START, k = 0; at < T_END; at += 12 * MINUTE, k++) {
    vi.setSystemTime(at);
    // Mostly passing (logged), with a failure and recovery now and then (sample rows).
    const ok = k % 9 !== 4;
    await applyCheckResult(env, monitor, outcome(at, ok));
    checks.push({ at, ok });
    await env.DB.batch(compactionStatements(env, at + 1_000, retention, since).map((s) => s.stmt));
    since = at + 1_000;
  }
  vi.setSystemTime(T_END);
}, 60_000);

afterAll(() => {
  vi.useRealTimers();
});

describe("a sample retention under 24 hours", { timeout: 60_000 }, () => {
  const from = T_END - SAMPLE_HOURS * HOUR;

  it("the monitor page lists only the checks inside it", async () => {
    const res = await exports.default.fetch(`https://openping.test/api/monitors/${monitor.id}/detail`, {
      headers: { authorization: "Bearer integration-api-token" },
    });
    const body = await res.json<{ recentSamples: { at: number }[] }>();
    expect(body.recentSamples.map((s) => s.at)).toEqual(checks.filter((c) => c.at >= from).map((c) => c.at));
  });

  it("the 24-hour chart plots only the passing checks inside it", async () => {
    const h = await loadRangeHistory(env, "24h", T_END, monitor.id);
    expect((h.samples.get(monitor.id) ?? []).map((p) => p.t)).toEqual(
      checks.filter((c) => c.ok && c.at >= from).map((c) => c.at),
    );
  });
});
