import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { createChannel } from "../../src/worker/db/channels";
import { upsertSubscription } from "../../src/worker/db/push";
import { countingD1, PLAN_BUDGETS } from "../../src/worker/lib/budget";
import { ensureVapidPublicKey } from "../../src/worker/notifications/push/vapid";
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
async function countedRun(extra: Partial<Env> = {}, status = 200, opts: { confirmDelayMs?: number } = {}) {
  const usage = { d1: 0 };
  const fetches = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(status === 200 ? "ok" : "down", { status }),
  );
  await runScheduled(controller, { ...env, ...extra, DB: countingD1(env.DB, usage) }, opts);
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
  // Each create runs a first check (checks/first-check.ts); undo those below so
  // every monitor starts never-checked and due, as the budget runs expect.
  const created = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
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
  created.mockRestore();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE monitor_state SET state = 'unknown', next_check_at = 0, last_checked_at = NULL,
         last_success_at = NULL, consecutive_successes = 0, warmup = 0`,
    ),
    env.DB.prepare("DELETE FROM samples"),
    env.DB.prepare("DELETE FROM summaries"),
    env.DB.prepare("DELETE FROM status_intervals"),
  ]);
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
    // The first run can't fit all 30 on Free, so some waited for a later tick,
    // but checks share the run's D1 batches, so most fit (8 when each check
    // wrote on its own).
    expect(perRun[0]).toBeLessThan(MONITORS);
    expect(perRun[0]).toBeGreaterThanOrEqual(20);
    console.log(`[budget] Free plan: checks per run ${perRun.join(", ")}`);
  });

  it("stays inside the Free budget when every check fails and opens an incident", async () => {
    // A warm-up grace cycle, then real failures that open incidents and queue alerts.
    await env.DB.prepare("UPDATE monitor_state SET next_check_at = 0, state = 'up'").run();
    const perRun: number[] = [];
    for (let run = 0; run < 4; run++) {
      // No pause before each re-check: the budget is what's measured here.
      const used = await countedRun({}, 500, { confirmDelayMs: 0 });
      expect(used.d1).toBeLessThanOrEqual(50);
      expect(used.fetches).toBeLessThanOrEqual(50);
      const latest = await env.DB.prepare(
        "SELECT monitors_checked AS n FROM scheduler_runs ORDER BY started_at DESC LIMIT 1",
      ).first<{ n: number }>();
      perRun.push(latest?.n ?? 0);
    }
    console.log(`[budget] Free plan, failing checks: checks per run ${perRun.join(", ")}`);
    // Each failing check holds its re-check's fetches, so many fit (3 when each
    // check wrote on its own) and only a run's last check, started without the
    // hold to use the end of the budget, may have to defer its re-check.
    expect(perRun[0]).toBeGreaterThanOrEqual(10);
    const deferred = await env.DB.prepare(
      "SELECT COALESCE(SUM(confirmations_deferred), 0) AS n FROM scheduler_runs WHERE monitors_checked > 0",
    ).first<{ n: number }>();
    expect(deferred?.n).toBeLessThanOrEqual(perRun.filter((n) => n > 0).length + 2);
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM incidents WHERE status = 'open'").first<{
      n: number;
    }>();
    expect(open?.n ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it("counts every redirect hop as a fetch, so redirecting checks stay inside the Free budget", async () => {
    // Every monitor redirects the most times a check follows (checks/http.ts),
    // so each check makes six fetches, and Cloudflare counts all six.
    await env.DB.prepare(
      `UPDATE monitor_state SET state = 'up', next_check_at = 0, active_incident_id = NULL`,
    ).run();
    await env.DB.prepare("UPDATE incidents SET status = 'resolved'").run();
    for (let run = 0; run < 2; run++) {
      const usage = { d1: 0 };
      const fetches = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const hop = Number(url.searchParams.get("hop") ?? "0");
        if (hop < 5) {
          url.searchParams.set("hop", String(hop + 1));
          return new Response(null, { status: 302, headers: { location: url.toString() } });
        }
        return new Response("ok", { status: 200 });
      });
      await runScheduled(controller, { ...env, DB: countingD1(env.DB, usage) });
      const calls = fetches.mock.calls.length;
      fetches.mockRestore();
      expect(usage.d1).toBeLessThanOrEqual(50);
      // Within the plan's own budget, not just Cloudflare's hard cap.
      expect(calls).toBeLessThanOrEqual(PLAN_BUDGETS.free.subrequests);
      expect(calls).toBeGreaterThan(0);
    }
  });

  it("runs the whole backlog at once on Paid", async () => {
    await env.DB.prepare("UPDATE monitor_state SET next_check_at = 0, last_success_at = NULL").run();
    const used = await countedRun({ WORKERS_PLAN: "paid" });
    expect(await checkedCount()).toBe(MONITORS);
    expect(used.d1).toBeLessThanOrEqual(PLAN_BUDGETS.paid.d1Queries);
  });
});

describe("alert deliveries and the Free budget", () => {
  const b64url = (buf: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

  it("stays inside 50 D1 queries with Web Push devices and an email channel on every alert", async () => {
    // Three monitors fail; each alert fans out to an email channel and three
    // push devices, and a push delivery reads its device and the VAPID keys.
    await ensureVapidPublicKey(env);
    for (let i = 0; i < 3; i++) {
      const key = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ])) as CryptoKeyPair;
      await upsertSubscription(env, {
        endpoint: `https://push.example.com/device-${i}`,
        p256dh: b64url((await crypto.subtle.exportKey("raw", key.publicKey)) as ArrayBuffer),
        auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
      });
    }
    await createChannel(env, { type: "email", config: { to: "ops@example.com" } });
    await env.DB.batch([
      env.DB.prepare("UPDATE incidents SET status = 'resolved'"),
      env.DB.prepare("DELETE FROM notification_outbox"),
      env.DB.prepare(
        "UPDATE monitor_state SET state = 'up', active_incident_id = NULL, next_check_at = ?",
      ).bind(Date.now() + 3_600_000),
      env.DB.prepare(
        `UPDATE monitor_state SET next_check_at = 0
          WHERE monitor_id IN (SELECT monitor_id FROM monitor_state ORDER BY monitor_id LIMIT 3)`,
      ),
    ]);

    for (let run = 0; run < 3; run++) {
      const used = await countedRun({}, 500, { confirmDelayMs: 0 });
      expect(used.d1).toBeLessThanOrEqual(PLAN_BUDGETS.free.d1Queries);
      expect(used.fetches).toBeLessThanOrEqual(50);
    }
    const tried = await env.DB.prepare(
      `SELECT channel_type, COUNT(*) AS n FROM notification_outbox WHERE status <> 'pending' GROUP BY channel_type`,
    ).all<{ channel_type: string; n: number }>();
    const byType = Object.fromEntries(tried.results.map((r) => [r.channel_type, r.n]));
    // Every alert went out (or was tried) within those runs.
    expect(byType).toMatchObject({ email: 3, push: 9 });
  });
});
