import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { firstCheckWithin } from "../../src/worker/checks/first-check";
import { getMonitor } from "../../src/worker/db/monitors";

// A new monitor is checked as soon as it is created (checks/first-check.ts), so
// the dashboard shows a real state within seconds instead of after the next
// cron run.

const API_ORIGIN = "https://openping.test";
const TOKEN = "integration-api-token";

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

async function create(body: Record<string, unknown>) {
  const res = await apiRequest("/api/monitors", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return res.json<{
    monitor: { id: string };
    firstCheck: Record<string, unknown>;
  }>();
}

async function stateOf(id: string) {
  return env.DB.prepare("SELECT state, last_checked_at, next_check_at FROM monitor_state WHERE monitor_id = ?")
    .bind(id)
    .first<{ state: string; last_checked_at: number | null; next_check_at: number }>();
}

/** A schedule whose only active day is not today, so the monitor is off right now. */
function offTodaySchedule() {
  const today = new Date().getUTCDay();
  return { mode: "business_hours", weekdays: [(today + 3) % 7], start: "08:00", end: "17:00", timezone: "UTC" };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => vi.restoreAllMocks());

describe("first check right away", () => {
  it("checks a new HTTP monitor in the create request and stores the result", async () => {
    const fetches = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok", { status: 200 }));
    const before = Date.now();
    const { monitor, firstCheck } = await create({
      type: "http",
      name: "First check up",
      config: { url: "https://first-up.example.com/" },
    });

    expect(fetches).toHaveBeenCalledOnce();
    expect(firstCheck).toMatchObject({ status: "checked", state: "up", ok: true, statusCode: 200 });
    const st = await stateOf(monitor.id);
    expect(st?.state).toBe("up");
    expect(st?.last_checked_at).toBeGreaterThanOrEqual(before);
    // The next check is a full interval away, so the cron doesn't repeat it.
    expect(st!.next_check_at).toBeGreaterThan(Date.now() + 10 * 60_000);

    const detail = await (await apiRequest(`/api/monitors/${monitor.id}/detail`)).json<{
      recentSamples: { state: string }[];
    }>();
    expect(detail.recentSamples.map((s) => s.state)).toEqual(["up"]);
  });

  it("a failing first check shows warming up, never alerts, and is not re-checked", async () => {
    const fetches = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 500 }));
    const { monitor, firstCheck } = await create({
      type: "http",
      name: "First check down",
      config: { url: "https://first-down.example.com/" },
    });

    expect(fetches).toHaveBeenCalledOnce();
    expect(firstCheck).toMatchObject({ status: "checked", state: "warming_up", ok: false, error: "status_out_of_range" });
    expect((await stateOf(monitor.id))?.state).toBe("warming_up");
    const incidents = await env.DB.prepare("SELECT COUNT(*) AS n FROM incidents WHERE monitor_id = ?")
      .bind(monitor.id)
      .first<{ n: number }>();
    expect(incidents?.n).toBe(0);
  });

  it("an off-hours monitor shows scheduled off at once, without a request", async () => {
    const fetches = vi.spyOn(globalThis, "fetch");
    const { monitor, firstCheck } = await create({
      type: "http",
      name: "First check off hours",
      config: { url: "https://first-off.example.com/" },
      schedule: offTodaySchedule(),
    });

    expect(fetches).not.toHaveBeenCalled();
    expect(firstCheck).toEqual({ status: "scheduled_off", state: "scheduled_off" });
    const st = await stateOf(monitor.id);
    expect(st?.state).toBe("scheduled_off");
    expect(st!.next_check_at).toBeGreaterThan(Date.now());
  });

  it("a monitor created inside a maintenance window shows maintenance", async () => {
    const now = Date.now();
    const win = await apiRequest("/api/maintenance", {
      method: "POST",
      body: JSON.stringify({ title: "Deploy", scope: "global", startsAt: now - 60_000, endsAt: now + 600_000 }),
    });
    expect(win.status).toBe(201);
    const { window } = await win.json<{ window: { id: string } }>();
    const fetches = vi.spyOn(globalThis, "fetch");
    try {
      const { monitor, firstCheck } = await create({
        type: "dns",
        name: "First check maintenance",
        config: { hostname: "first-maint.example.com", recordType: "A" },
      });
      expect(fetches).not.toHaveBeenCalled();
      expect(firstCheck).toEqual({ status: "maintenance", state: "maintenance" });
      expect((await stateOf(monitor.id))?.state).toBe("maintenance");
    } finally {
      await apiRequest(`/api/maintenance/${window.id}`, { method: "DELETE" });
    }
  });

  it("a heartbeat waits for its first ping", async () => {
    const { monitor, firstCheck } = await create({
      type: "heartbeat",
      name: "First check heartbeat",
      config: { intervalSeconds: 3600, graceSeconds: 300 },
    });
    expect(firstCheck).toEqual({ status: "skipped", reason: "heartbeat" });
    expect((await stateOf(monitor.id))?.state).toBe("unknown");
  });

  it("a slow first check answers 'running' and finishes in the background", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await gate;
      return new Response("ok");
    });
    // Created directly so the first check isn't run by the route.
    const { monitor: created } = await (async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("skip"));
      return create({ type: "http", name: "First check slow", config: { url: "https://first-slow.example.com/" } });
    })();
    const monitor = (await getMonitor(env, created.id))!;
    const background: Promise<unknown>[] = [];

    const result = await firstCheckWithin(env, monitor, (p) => background.push(p), 20);
    expect(result).toEqual({ status: "running" });
    expect(background).toHaveLength(1);

    release();
    await expect(background[0]).resolves.toMatchObject({ status: "checked", state: "up" });
    expect((await stateOf(monitor.id))?.state).toBe("up");
  });
});
