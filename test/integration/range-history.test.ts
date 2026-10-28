import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import "../../src/worker/index";
import type {
  MonitorHistoryResponse,
  OverviewHistoryResponse,
} from "../../src/shared/time-range";

const API_ORIGIN = "https://openping.test";
const API_TOKEN = "integration-api-token";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

async function createHeartbeat(name: string): Promise<string> {
  const res = await apiRequest("/api/monitors", {
    method: "POST",
    body: JSON.stringify({
      type: "heartbeat",
      name,
      config: { intervalSeconds: 300, graceSeconds: 30 },
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json<{ monitor: { id: string } }>()).monitor.id;
}

function hourSummary(id: string, bucket: number, checks: number, ok: number, latency: number[]) {
  return env.DB.prepare(
    `INSERT INTO summaries (id, monitor_id, period, bucket_start, checks, ok_checks, fail_checks,
       sum_latency_ms, min_latency_ms, max_latency_ms, monitored_seconds, down_seconds)
     VALUES (?, ?, 'hour', ?, ?, ?, ?, ?, ?, ?, 3600, 0)`,
  ).bind(
    `${id}:hour:${bucket}`,
    id,
    bucket,
    checks,
    ok,
    checks - ok,
    latency.reduce((a, b) => a + b, 0),
    Math.min(...latency),
    Math.max(...latency),
  );
}

function interval(id: string, state: string, startedAt: number, endedAt: number | null) {
  return env.DB.prepare(
    `INSERT INTO status_intervals (id, monitor_id, state, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(`iv_${id}_${state}_${startedAt}`, id, state, startedAt, endedAt);
}

let upId = "";
let flakyId = "";
let hourNow = 0;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  upId = await createHeartbeat("Steady app");
  flakyId = await createHeartbeat("Suspended app");
  hourNow = Date.now() - (Date.now() % HOUR);
  const h3 = hourNow - 3 * HOUR;
  const h2 = hourNow - 2 * HOUR;

  await env.DB.batch([
    // Steady: two checked hours, off-hours before them.
    interval(upId, "scheduled_off", hourNow - 2 * DAY, h3),
    interval(upId, "up", h3, null),
    hourSummary(upId, h3, 5, 5, [200, 220, 240, 260, 280]),
    hourSummary(upId, h2, 5, 5, [210, 230, 250, 270, 43_000]),
    // Suspended for an hour, three days ago; an outage two hours back.
    interval(flakyId, "suspended", hourNow - 3 * DAY, hourNow - 3 * DAY + HOUR),
    interval(flakyId, "up", hourNow - 3 * DAY + HOUR, h2),
    interval(flakyId, "down", h2, h2 + 30 * 60_000),
    interval(flakyId, "up", h2 + 30 * 60_000, null),
    hourSummary(flakyId, h2, 5, 2, [400, 500]),
    env.DB.prepare(
      `INSERT INTO incidents (id, monitor_id, status, title, started_at, resolved_at, duration_seconds, error, created_at, updated_at)
       VALUES ('inc_range_1', ?, 'resolved', 'Suspended app is down', ?, ?, 1800, 'timeout', ?, ?)`,
    ).bind(flakyId, h2, h2 + 30 * 60_000, h2, h2),
    env.DB.prepare(
      `INSERT INTO incidents (id, monitor_id, status, title, started_at, resolved_at, duration_seconds, error, created_at, updated_at)
       VALUES ('inc_range_old', ?, 'resolved', 'Old', ?, ?, 60, 'timeout', ?, ?)`,
    ).bind(flakyId, hourNow - 20 * DAY, hourNow - 20 * DAY + 60_000, hourNow - 20 * DAY, hourNow - 20 * DAY),
    env.DB.prepare(
      `INSERT INTO samples (id, monitor_id, at, ok, state, duration_ms)
       VALUES ('s1', ?, ?, 1, 'up', 200), ('s2', ?, ?, 1, 'up', 43000), ('s3', ?, ?, 0, 'down', NULL)`,
    ).bind(upId, h3 + 60_000, upId, h2 + 60_000, upId, h2 + 120_000),
    // Maintenance: one upcoming in two days, one long past.
    env.DB.prepare(
      `INSERT INTO maintenance_windows (id, title, scope, starts_at, ends_at, created_at, updated_at)
       VALUES ('mw_soon', 'Database upgrade', 'global', ?, ?, 0, 0),
              ('mw_past', 'Old window', 'global', ?, ?, 0, 0)`,
    ).bind(hourNow + 2 * DAY, hourNow + 2 * DAY + HOUR, hourNow - 10 * DAY, hourNow - 10 * DAY + HOUR),
  ]);
});

describe("GET /api/overview/history", () => {
  it("requires a session", async () => {
    const res = await exports.default.fetch(`${API_ORIGIN}/api/overview/history?range=7d`);
    expect(res.status).toBe(401);
  });

  it("buckets every monitor by hour and keeps off-hours apart from downtime", async () => {
    const res = await apiRequest("/api/overview/history?range=24h");
    expect(res.status).toBe(200);
    const body = await res.json<OverviewHistoryResponse>();
    expect(body.range).toBe("24h");
    expect(body.bucketMs).toBe(HOUR);
    expect(body.overall.buckets).toHaveLength(24);

    const steady = body.monitors.find((m) => m.id === upId)!;
    expect(steady.buckets).toHaveLength(24);
    const at = (t: number) => steady.buckets.find((b) => b.t === t)!;
    expect(at(hourNow - 5 * HOUR).state).toBe("scheduled_off");
    expect(at(hourNow - 3 * HOUR)).toMatchObject({ state: "up", uptime: 100, avgMs: 240 });
    expect(steady.uptimePct).toBe(100);
    expect(steady.downtimeSeconds).toBe(0);
    expect(steady.offSeconds).toBeGreaterThan(0);
    // 24h percentiles come from the raw OK samples.
    expect(steady.latency).toMatchObject({ basis: "checks", count: 2, max: 43_000 });

    const flaky = body.monitors.find((m) => m.id === flakyId)!;
    const bucket = flaky.buckets.find((b) => b.t === hourNow - 2 * HOUR)!;
    expect(bucket).toMatchObject({ state: "down", uptime: 40 });
    expect(flaky.downtimeSeconds).toBe(1800);

    const overall = body.overall.buckets.find((b) => b.t === hourNow - 2 * HOUR)!;
    expect(overall.state).toBe("down");
    expect(overall.monitors).toMatchObject({ down: 1, up: 1 });
    expect(body.overall.checks).toBe(15);
    expect(body.overall.okChecks).toBe(12);

    expect(body.incidentCount).toBe(1);
    expect(body.incidents[0]).toMatchObject({
      id: "inc_range_1",
      monitorName: "Suspended app",
      status: "resolved",
    });
  });

  it("counts suspensions over 7 days and uses hourly averages for percentiles", async () => {
    const body = await (await apiRequest("/api/overview/history?range=7d")).json<OverviewHistoryResponse>();
    expect(body.overall.buckets).toHaveLength(168);
    const flaky = body.monitors.find((m) => m.id === flakyId)!;
    expect(flaky.suspensions).toBe(1);
    expect(flaky.suspendedSeconds).toBe(3600);
    expect(flaky.downtimeSeconds).toBe(5400);
    expect(flaky.latency.basis).toBe("hourly");
    const suspendedBucket = flaky.buckets.find((b) => b.t === hourNow - 3 * DAY)!;
    expect(suspendedBucket.state).toBe("suspended");
  });

  it("uses day buckets for 30 and 90 days and falls back to 7d for a bad range", async () => {
    const d30 = await (await apiRequest("/api/overview/history?range=30d")).json<OverviewHistoryResponse>();
    expect(d30.bucketMs).toBe(DAY);
    expect(d30.overall.buckets).toHaveLength(30);
    expect(d30.overall.latency.basis).toBe("daily");
    expect(d30.incidentCount).toBe(2);
    const d90 = await (await apiRequest("/api/overview/history?range=90d")).json<OverviewHistoryResponse>();
    expect(d90.overall.buckets).toHaveLength(90);
    const bad = await (await apiRequest("/api/overview/history?range=forever")).json<OverviewHistoryResponse>();
    expect(bad.range).toBe("7d");
  });
});

describe("GET /api/overview maintenance", () => {
  it("lists upcoming maintenance and leaves out windows that ended", async () => {
    const body = await (await apiRequest("/api/overview")).json<{
      maintenance: { active: unknown[]; upcoming: { id: string; title: string }[] };
    }>();
    expect(body.maintenance.active).toEqual([]);
    expect(body.maintenance.upcoming.map((w) => w.id)).toEqual(["mw_soon"]);
  });
});

describe("GET /api/monitors/:id/history", () => {
  it("returns one monitor's buckets, latency stats and every OK check for 24h", async () => {
    const res = await apiRequest(`/api/monitors/${upId}/history?range=24h`);
    expect(res.status).toBe(200);
    const body = await res.json<MonitorHistoryResponse>();
    expect(body.id).toBe(upId);
    expect(body.buckets).toHaveLength(24);
    expect(body.points.map((p) => p.ms)).toEqual([200, 43_000]);
    expect(body.latency).toMatchObject({ median: 21_600, max: 43_000 });
  });

  it("uses bucket averages as points beyond 24h", async () => {
    const body = await (
      await apiRequest(`/api/monitors/${upId}/history?range=7d`)
    ).json<MonitorHistoryResponse>();
    expect(body.points).toEqual([
      { t: hourNow - 3 * HOUR, ms: 240 },
      { t: hourNow - 2 * HOUR, ms: 8792 },
    ]);
  });

  it("404s for an unknown monitor", async () => {
    const res = await apiRequest("/api/monitors/mon_missing/history?range=7d");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/monitors/:id/detail downtime", () => {
  it("reports the suspended share of downtime per window, with 90 days", async () => {
    const body = await (await apiRequest(`/api/monitors/${flakyId}/detail`)).json<{
      uptime: Record<string, number>;
      downtime: Record<string, { downtimeSeconds: number; suspendedSeconds: number; suspensions: number }>;
    }>();
    expect(body.uptime).toHaveProperty("d90");
    expect(body.downtime.d1).toEqual({ downtimeSeconds: 1800, suspendedSeconds: 0, suspensions: 0 });
    expect(body.downtime.d7).toEqual({ downtimeSeconds: 5400, suspendedSeconds: 3600, suspensions: 1 });
  });
});
