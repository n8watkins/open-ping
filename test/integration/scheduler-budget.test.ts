import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { countingD1, PLAN_BUDGETS } from "../../src/worker/lib/budget";
import { runScheduled } from "../../src/worker/scheduler";
import type { Env } from "../../src/worker/types";

// A cron run on the Workers Free plan may make only 50 D1 queries and 50
// outbound fetches (lib/budget.ts). These runs count both from outside the
// scheduler, lease and run record included, the way Cloudflare would.

const API_ORIGIN = "https://openping.test";
const MONITORS = 30;

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

/** One cron run with every D1 query and outbound fetch counted. */
async function countedRun(extra: Partial<Env> = {}, status = 200) {
  const usage = { d1: 0 };
  const fetches = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(status === 200 ? "ok" : "down", { status }),
  );
  await runScheduled(controller, { ...env, ...extra, DB: countingD1(env.DB, usage) });
  const calls = fetches.mock.calls.length;
  fetches.mockRestore();
  return { d1: usage.d1, fetches: calls };
}

async function checkedCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM monitor_state WHERE last_success_at IS NOT NULL",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (let i = 0; i < MONITORS; i++) {
    const res = await apiRequest("/api/monitors", {
      method: "POST",
      body: JSON.stringify({
        type: "http",
        name: `Budget monitor ${i}`,
        config: { url: `https://site${i}.example.com/health` },
      }),
    });
    expect(res.status).toBe(201);
  }
});

afterEach(() => vi.restoreAllMocks());

describe("scheduler budget", () => {
  it("keeps every Free-plan run inside 50 D1 queries and 50 fetches, and catches up over later runs", async () => {
    const perRun: number[] = [];
    for (let run = 0; run < 12 && (await checkedCount()) < MONITORS; run++) {
      const before = await checkedCount();
      const used = await countedRun();
      perRun.push((await checkedCount()) - before);
      expect(used.d1).toBeLessThanOrEqual(50);
      expect(used.fetches).toBeLessThanOrEqual(50);
      // Every run makes progress while monitors are due.
      expect(perRun.at(-1)).toBeGreaterThan(0);
    }
    expect(await checkedCount()).toBe(MONITORS);
    // The first run can't fit all 30 on Free, so some waited for a later tick.
    expect(perRun[0]).toBeLessThan(MONITORS);
    console.log(`[budget] Free plan: checks per run ${perRun.join(", ")}`);
  });

  it("stays inside the Free budget when every check fails and opens an incident", async () => {
    // A warm-up grace cycle, then real failures that open incidents and queue alerts.
    await env.DB.prepare("UPDATE monitor_state SET next_check_at = 0, state = 'up'").run();
    for (let run = 0; run < 4; run++) {
      const used = await countedRun({}, 500);
      expect(used.d1).toBeLessThanOrEqual(50);
      expect(used.fetches).toBeLessThanOrEqual(50);
    }
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM incidents WHERE status = 'open'").first<{
      n: number;
    }>();
    expect(open?.n ?? 0).toBeGreaterThan(0);
    // Each failing check waits 10s before its retry (checks/runner.ts).
  }, 120_000);

  it("runs the whole backlog at once on Paid", async () => {
    await env.DB.prepare("UPDATE monitor_state SET next_check_at = 0, last_success_at = NULL").run();
    const used = await countedRun({ WORKERS_PLAN: "paid" });
    expect(await checkedCount()).toBe(MONITORS);
    expect(used.d1).toBeLessThanOrEqual(PLAN_BUDGETS.paid.d1Queries);
  });
});
