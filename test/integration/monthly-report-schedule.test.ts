import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { countingD1 } from "../../src/worker/lib/budget";
import { getSetting, setSetting, settingsFromRows, settingsStatement } from "../../src/worker/db/settings";
import { resolveRetention } from "../../src/worker/history/rollups";
import { MONTHLY_GATE_SETTINGS, RETRY_AFTER_MS, sendMonthlyReport } from "../../src/worker/notifications/monthly";
import type { Env } from "../../src/worker/types";

/**
 * When the monthly report goes out, against D1: it catches up on any day after
 * the 1st until last month's report is sent, and a failed send waits an hour
 * before the next try instead of retrying every 12-minute run.
 */

const MINUTE = 60_000;
const mailEnv: Env = { ...env, RESEND_API_KEY: "re_test", ADMIN_EMAIL: "owner@example.com" };
const retention = resolveRetention(null);

/** The gate settings as the scheduler reads them up front. */
async function gate(): Promise<Map<string, string | null>> {
  const res = await settingsStatement(env, MONTHLY_GATE_SETTINGS).all<Parameters<typeof settingsFromRows>[2][number]>();
  return settingsFromRows(env, MONTHLY_GATE_SETTINGS, res.results);
}

/** One scheduler-style call: the settings read up front, then the send, counted. */
async function attempt(now: number) {
  const usage = { d1: 0 };
  const result = await sendMonthlyReport({ ...mailEnv, DB: countingD1(env.DB, usage) }, now, await gate(), retention);
  return { ...result, d1: usage.d1 };
}

let resend: ReturnType<typeof vi.fn>;
function stubResend(status: number) {
  resend = vi.fn(async () => new Response(status === 200 ? '{"id":"e"}' : "error", { status }));
  vi.spyOn(globalThis, "fetch").mockImplementation(resend as unknown as typeof fetch);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'monthly_report_%' OR key = 'timezone'").run();
  await setSetting(env, "monthly_report_enabled", "true");
  await setSetting(env, "timezone", "UTC");
});

afterEach(() => vi.restoreAllMocks());

describe("monthly report schedule", () => {
  it("catches up a report that wasn't sent on the 1st, once", async () => {
    stubResend(200);
    // 3 Dec, mid-morning: November's report never went out.
    const now = Date.UTC(2026, 11, 3, 10);
    expect(await attempt(now)).toMatchObject({ sent: true, d1: 2 });
    expect(resend).toHaveBeenCalledOnce();
    expect(await getSetting(env, "monthly_report_last_sent")).toBe("2026-11");
    // Sent: later runs that month cost nothing and send nothing.
    expect(await attempt(now + 12 * MINUTE)).toMatchObject({ sent: false, reason: "not_due", d1: 0 });
    expect(await attempt(Date.UTC(2026, 11, 28))).toMatchObject({ sent: false, reason: "not_due" });
    expect(resend).toHaveBeenCalledOnce();
  });

  it("still waits for 09:00 on the 1st", async () => {
    stubResend(200);
    expect(await attempt(Date.UTC(2026, 11, 1, 8, 59))).toMatchObject({ sent: false, reason: "not_due", d1: 0 });
    expect(await attempt(Date.UTC(2026, 11, 1, 9))).toMatchObject({ sent: true });
  });

  it("waits an hour after a failed send instead of retrying every run", async () => {
    stubResend(500);
    const first = Date.UTC(2026, 11, 1, 9, 5);
    expect(await attempt(first)).toMatchObject({ sent: false, d1: 1 });
    expect(resend).toHaveBeenCalledOnce();
    expect(await getSetting(env, "monthly_report_last_sent")).toBeNull();
    // The next runs that hour skip it, at no cost.
    for (const later of [12, 24, 48]) {
      expect(await attempt(first + later * MINUTE)).toMatchObject({ sent: false, reason: "not_due", d1: 0 });
    }
    expect(resend).toHaveBeenCalledOnce();
    // An hour on, it tries again, and this time the email goes out.
    stubResend(200);
    expect(await attempt(first + RETRY_AFTER_MS)).toMatchObject({ sent: true, d1: 2 });
    expect(await getSetting(env, "monthly_report_last_sent")).toBe("2026-11");
  });
});
