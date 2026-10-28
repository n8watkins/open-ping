import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getSetting, setSetting, settingsFromRows, settingsStatement } from "../../src/worker/db/settings";
import { RETRY_AFTER_MS, sendWeeklySummary, WEEKLY_GATE_SETTINGS } from "../../src/worker/notifications/weekly";
import type { Env } from "../../src/worker/types";

/**
 * When the weekly summary goes out, against D1: a failed send waits an hour
 * before the next try instead of retrying every 12-minute run of the day.
 */

const MINUTE = 60_000;
const mailEnv: Env = { ...env, RESEND_API_KEY: "re_test", ADMIN_EMAIL: "owner@example.com" };

/** The gate settings as the scheduler reads them up front. */
async function gate(): Promise<Map<string, string | null>> {
  const res = await settingsStatement(env, WEEKLY_GATE_SETTINGS).all<Parameters<typeof settingsFromRows>[2][number]>();
  return settingsFromRows(env, WEEKLY_GATE_SETTINGS, res.results);
}

const attempt = async (now: number) => sendWeeklySummary(mailEnv, now, await gate());

let resend: ReturnType<typeof vi.fn>;
function stubResend(status: number) {
  resend = vi.fn(async () => new Response(status === 200 ? '{"id":"e"}' : "error", { status }));
  vi.spyOn(globalThis, "fetch").mockImplementation(resend as unknown as typeof fetch);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'weekly_summary_%'").run();
  await setSetting(env, "weekly_summary_enabled", "true");
});

afterEach(() => vi.restoreAllMocks());

describe("weekly summary schedule", () => {
  it("waits an hour after a failed send instead of retrying every run", async () => {
    stubResend(500);
    // Monday 2 Nov 2026, 09:05 UTC: the default send time.
    const first = Date.UTC(2026, 10, 2, 9, 5);
    expect(await attempt(first)).toMatchObject({ sent: false });
    expect(resend).toHaveBeenCalledOnce();
    // The next runs that hour skip it.
    for (const later of [12, 24, 48]) {
      expect(await attempt(first + later * MINUTE)).toMatchObject({ sent: false, reason: "not_due" });
    }
    expect(resend).toHaveBeenCalledOnce();
    // An hour on, it tries again, and this time the email goes out.
    stubResend(200);
    expect(await attempt(first + RETRY_AFTER_MS)).toMatchObject({ sent: true });
    expect(resend).toHaveBeenCalledOnce();
    expect(await getSetting(env, "weekly_summary_last_sent")).toBe(String(first + RETRY_AFTER_MS));
    // Sent: the rest of the day sends nothing.
    expect(await attempt(first + 3 * RETRY_AFTER_MS)).toMatchObject({ sent: false, reason: "not_due" });
  });
});
