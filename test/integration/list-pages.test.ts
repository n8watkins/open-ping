import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import "../../src/worker/index";

/**
 * The reads behind the Monitors, Incidents and Maintenance pages, against real
 * D1: the Monitors list figures (?include=stats), the incident sort orders the
 * dashboard offers, and a "pause alerts now" window.
 */

const ORIGIN = "https://openping.test";
const HOUR = 3_600_000;

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer integration-api-token");
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

const now = Date.now();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const monitor = (id: string, name: string) =>
    env.DB.prepare(
      `INSERT INTO monitors (id, type, name, config, schedule, public, sort_order, created_at, updated_at)
       VALUES (?, 'http', ?, ?, '{"mode":"always"}', '{"visible":false}', 0, ?, ?)`,
    ).bind(id, name, JSON.stringify({ url: `https://${id}.example.com/` }), now, now);
  const hour = (monitorId: string, hoursAgo: number, ok: number, latency: number) =>
    env.DB.prepare(
      `INSERT INTO summaries (id, monitor_id, period, bucket_start, checks, ok_checks, fail_checks,
         sum_latency_ms, monitored_seconds, down_seconds)
       VALUES (?, ?, 'hour', ?, 5, ?, ?, ?, 3600, ?)`,
    ).bind(
      `${monitorId}:hour:${hoursAgo}`,
      monitorId,
      now - hoursAgo * HOUR,
      ok,
      5 - ok,
      ok * latency,
      (5 - ok) * 720,
    );
  const incident = (id: string, monitorId: string, startedHoursAgo: number, durationSeconds: number) =>
    env.DB.prepare(
      `INSERT INTO incidents (id, monitor_id, status, title, started_at, resolved_at, duration_seconds,
         error, root_cause, created_at, updated_at)
       VALUES (?, ?, 'resolved', 'Down', ?, ?, ?, 'timeout', 'timeout', ?, ?)`,
    ).bind(
      id,
      monitorId,
      now - startedHoursAgo * HOUR,
      now - startedHoursAgo * HOUR + durationSeconds * 1000,
      durationSeconds,
      now,
      now,
    );
  await env.DB.batch([
    monitor("mon_list_a", "Alpha"),
    monitor("mon_list_b", "Beta"),
    hour("mon_list_a", 2, 5, 200),
    hour("mon_list_a", 3, 5, 300),
    hour("mon_list_a", 4, 4, 250),
    // Eight days ago: outside the 7-day window.
    hour("mon_list_a", 8 * 24, 0, 0),
    incident("inc_list_1", "mon_list_a", 50, 600),
    incident("inc_list_2", "mon_list_a", 10, 3600),
    incident("inc_list_3", "mon_list_b", 30, 60),
  ]);
});

describe("the Monitors list figures", () => {
  it("are left out unless asked for", async () => {
    const body = await api("/api/monitors").then((r) => r.json<Record<string, unknown>>());
    expect(body.monitors).toHaveLength(2);
    expect(body.stats).toBeUndefined();
  });

  it("give 7-day uptime, the typical response and the latest incident per monitor", async () => {
    const res = await api("/api/monitors?include=stats");
    expect(res.status).toBe(200);
    const body = await res.json<{
      monitors: { id: string }[];
      stats: Record<string, { uptime7d: number; checks7d: number; typicalResponseMs: number | null; lastIncidentAt: number | null; incidentOpen: boolean }>;
    }>();
    expect(body.monitors).toHaveLength(2);
    expect(body.stats.mon_list_a).toEqual({
      uptime7d: (14 / 15) * 100,
      checks7d: 15,
      typicalResponseMs: 250,
      lastIncidentAt: now - 10 * HOUR,
      incidentOpen: false,
    });
    expect(body.stats.mon_list_b).toMatchObject({
      uptime7d: 100,
      checks7d: 0,
      typicalResponseMs: null,
      lastIncidentAt: now - 30 * HOUR,
    });
  });
});

describe("incident sort orders", () => {
  async function ids(sort: string): Promise<string[]> {
    const body = await api(`/api/incidents?sort=${sort}`).then((r) => r.json<{ incidents: { id: string }[] }>());
    return body.incidents.map((i) => i.id);
  }

  it("lists newest first by default, and oldest first or longest downtime on request", async () => {
    expect(await ids("")).toEqual(["inc_list_2", "inc_list_3", "inc_list_1"]);
    expect(await ids("oldest")).toEqual(["inc_list_1", "inc_list_3", "inc_list_2"]);
    expect(await ids("longest")).toEqual(["inc_list_2", "inc_list_1", "inc_list_3"]);
  });
});

describe("pausing alerts now", () => {
  it("creates a window that is active at once and can be ended early", async () => {
    const start = Date.now();
    const created = await api("/api/maintenance", {
      method: "POST",
      body: JSON.stringify({
        title: "Alerts paused for 30 min",
        scope: "monitors",
        monitorIds: ["mon_list_a"],
        startsAt: start,
        endsAt: start + 30 * 60_000,
      }),
    });
    expect(created.status).toBe(201);
    const { window } = await created.json<{ window: { id: string } }>();

    const ended = await api(`/api/maintenance/${window.id}/end`, { method: "POST" });
    expect(ended.status).toBe(200);
    const body = await ended.json<{ outcome: string; window: { endsAt: number } }>();
    expect(body.outcome).toBe("ended");
    expect(body.window.endsAt).toBeLessThan(start + 30 * 60_000);
  });
});
