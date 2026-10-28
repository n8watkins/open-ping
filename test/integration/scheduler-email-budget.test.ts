import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { getSetting, setSetting, settingsFromRows, settingsStatement } from "../../src/worker/db/settings";
import { countingD1, PLAN_BUDGETS, WEEKLY_SUMMARY_D1 } from "../../src/worker/lib/budget";
import { sendWeeklySummary, WEEKLY_GATE_SETTINGS } from "../../src/worker/notifications/weekly";
import { runScheduled } from "../../src/worker/scheduler";
import type { Env } from "../../src/worker/types";

// The weekly summary is the most expensive thing a run does after its checks.
// The budget keeps room for it (lib/budget.ts WEEKLY_SUMMARY_D1), and when a
// failing write batch's retries have spent that room, the run skips it rather
// than going past the plan's limit; it is still due, so a later run sends it.

const API_ORIGIN = "https://openping.test";
const MONITORS = 30;
const controller: ScheduledController = { cron: "*/12 * * * *", scheduledTime: Date.now(), noRetry() {} };

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer integration-api-token");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

/** Mail goes out (Resend is stubbed) and the summary is due right now. */
const { APP_URL: _appUrl, ...envWithoutAppUrl } = env;
const mailEnv: Env = { ...(envWithoutAppUrl as Env), RESEND_API_KEY: "re_test", ADMIN_EMAIL: "owner@example.com" };

async function makeWeeklyDue() {
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'weekly_summary_%'").run();
  await setSetting(env, "weekly_summary_enabled", "true");
  await setSetting(env, "weekly_summary_day", String(new Date().getUTCDay()));
  await setSetting(env, "weekly_summary_hour", "0");
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
  for (let i = 0; i < MONITORS; i++) {
    const res = await apiRequest("/api/monitors", {
      method: "POST",
      body: JSON.stringify({ type: "http", name: `Email budget ${i}`, config: { url: `https://e${i}.example.com/` } }),
    });
    expect(res.status).toBe(201);
  }
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare("DROP TRIGGER IF EXISTS broken_samples").run();
});

describe("the weekly summary and the run's D1 budget", () => {
  it("costs no more than the budget keeps for it", async () => {
    await makeWeeklyDue();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"id":"e"}'));
    const gate = await settingsStatement(env, WEEKLY_GATE_SETTINGS).all<Parameters<typeof settingsFromRows>[2][number]>();
    const usage = { d1: 0 };
    const res = await sendWeeklySummary(
      { ...mailEnv, DB: countingD1(env.DB, usage) },
      Date.now(),
      await settingsFromRows(env, WEEKLY_GATE_SETTINGS, gate.results),
    );
    expect(res).toMatchObject({ sent: true });
    expect(usage.d1).toBeLessThanOrEqual(WEEKLY_SUMMARY_D1);
  });

  it("is skipped, not sent past the limit, when a failing batch's retries spent its room, and goes out next run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await makeWeeklyDue();
    await env.DB.prepare("UPDATE monitor_state SET state = 'up', next_check_at = 0").run();
    // Every sample insert fails: the run's batch fails and each monitor's
    // writes are retried in parts, as far as the budget lets them.
    await env.DB.prepare(
      `CREATE TRIGGER broken_samples BEFORE INSERT ON samples
         BEGIN SELECT RAISE(ABORT, 'broken for this test'); END`,
    ).run();
    const usage = { d1: 0 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"id":"e"}'));
    await runScheduled(controller, { ...mailEnv, DB: countingD1(env.DB, usage) }, { budget: PLAN_BUDGETS.free });
    expect(usage.d1).toBeLessThanOrEqual(PLAN_BUDGETS.free.d1Queries);
    expect(await getSetting(env, "weekly_summary_last_sent")).toBeNull();

    // Repaired, and nothing left to check: the next run has room and sends it.
    await env.DB.prepare("DROP TRIGGER broken_samples").run();
    await env.DB.prepare("UPDATE monitor_state SET next_check_at = ?").bind(Date.now() + 3_600_000).run();
    const next = { d1: 0 };
    await runScheduled(controller, { ...mailEnv, DB: countingD1(env.DB, next) }, { budget: PLAN_BUDGETS.free });
    expect(next.d1).toBeLessThanOrEqual(PLAN_BUDGETS.free.d1Queries);
    expect(await getSetting(env, "weekly_summary_last_sent")).not.toBeNull();
  });
});
