import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import "../../src/worker/index";

const API_ORIGIN = "https://openping.test";
const API_TOKEN = "integration-api-token";
const HEARTBEAT_SECRET = "integration-heartbeat-secret";

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("authenticated monitor lifecycle", () => {
  it("enforces authentication and keeps heartbeat credentials one-way", async () => {
    const unauthorized = await exports.default.fetch(`${API_ORIGIN}/api/monitors`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });

    const createdResponse = await apiRequest("/api/monitors", {
      method: "POST",
      body: JSON.stringify({
        type: "heartbeat",
        name: "Integration heartbeat",
        config: {
          intervalSeconds: 300,
          graceSeconds: 30,
          secret: HEARTBEAT_SECRET,
        },
      }),
    });
    expect(createdResponse.status).toBe(201);

    const createdBody = await createdResponse.json<{
      monitor: { id: string; heartbeatToken: string; config: { secret: string } };
    }>();
    const { id, heartbeatToken } = createdBody.monitor;
    expect(id).toMatch(/^mon_/);
    expect(heartbeatToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createdBody.monitor.config.secret).toBe("");

    const stored = await env.DB.prepare(
      "SELECT heartbeat_token, heartbeat_token_hash, config FROM monitors WHERE id = ?",
    )
      .bind(id)
      .first<{ heartbeat_token: string | null; heartbeat_token_hash: string | null; config: string }>();
    expect(stored?.heartbeat_token).toBeNull();
    expect(stored?.heartbeat_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.heartbeat_token_hash).not.toBe(heartbeatToken);
    expect(stored?.config).not.toContain(HEARTBEAT_SECRET);

    const readResponse = await apiRequest(`/api/monitors/${id}`);
    expect(readResponse.status).toBe(200);
    const readBody = await readResponse.json<{
      monitor: { heartbeatToken: string | null; config: { secret: string } };
    }>();
    expect(readBody.monitor.heartbeatToken).toBeNull();
    expect(readBody.monitor.config.secret).toBe("");

    const rejectedBeat = await exports.default.fetch(
      `${API_ORIGIN}/hb/${heartbeatToken}`,
      { method: "POST" },
    );
    expect(rejectedBeat.status).toBe(401);

    const acceptedBeat = await exports.default.fetch(
      `${API_ORIGIN}/hb/${heartbeatToken}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-heartbeat-secret": HEARTBEAT_SECRET,
        },
        body: JSON.stringify({ durationMs: 42, message: "integration ok" }),
      },
    );
    expect(acceptedBeat.status).toBe(200);
    expect(await acceptedBeat.json()).toEqual({ ok: true, monitor: id });

    const state = await env.DB.prepare(
      "SELECT state, last_beat_at, last_success_at FROM monitor_state WHERE monitor_id = ?",
    )
      .bind(id)
      .first<{ state: string; last_beat_at: number | null; last_success_at: number | null }>();
    expect(state?.state).toBe("up");
    expect(state?.last_beat_at).toEqual(expect.any(Number));
    expect(state?.last_success_at).toEqual(expect.any(Number));

    const sample = await env.DB.prepare(
      "SELECT ok, duration_ms, meta FROM samples WHERE monitor_id = ?",
    )
      .bind(id)
      .first<{ ok: number; duration_ms: number | null; meta: string | null }>();
    expect(sample?.ok).toBe(1);
    expect(sample?.duration_ms).toBe(42);
    expect(sample?.meta).toContain("integration ok");

    const deleted = await apiRequest(`/api/monitors/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });

    const remaining = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM monitors WHERE id = ?) AS monitors,
         (SELECT COUNT(*) FROM monitor_state WHERE monitor_id = ?) AS states,
         (SELECT COUNT(*) FROM samples WHERE monitor_id = ?) AS samples`,
    )
      .bind(id, id, id)
      .first<{ monitors: number; states: number; samples: number }>();
    expect(remaining).toEqual({ monitors: 0, states: 0, samples: 0 });
  });

  it("restores heartbeat credentials and remaps related records", async () => {
    const oldMonitorId = "mon_backup_source";
    const incidentId = "inc_backup_source";
    const startsAt = Date.now() + 60_000;
    const importResponse = await apiRequest("/api/data/import", {
      method: "POST",
      body: JSON.stringify({
        data: {
          version: 1,
          monitors: [
            {
              id: oldMonitorId,
              type: "heartbeat",
              name: "Imported integration heartbeat",
              config: { intervalSeconds: 600, graceSeconds: 60 },
            },
          ],
          maintenance: [
            {
              title: "Imported maintenance",
              scope: "monitors",
              monitorIds: [oldMonitorId, "mon_missing"],
              startsAt,
              endsAt: startsAt + 60_000,
            },
          ],
          incidents: [
            {
              id: incidentId,
              monitorId: oldMonitorId,
              status: "resolved",
              title: "Imported incident",
              startedAt: startsAt - 120_000,
              resolvedAt: startsAt - 60_000,
              durationSeconds: 60,
              publicMessage: "Recovered",
            },
          ],
        },
      }),
    });
    expect(importResponse.status).toBe(200);

    const importBody = await importResponse.json<{
      imported: { monitors: number; maintenance: number; incidents: number };
      skipped: { monitors: number; maintenance: number; incidents: number };
      heartbeatMonitors: Array<{ id: string; name: string; heartbeatToken: string }>;
    }>();
    expect(importBody.imported).toEqual({ monitors: 1, maintenance: 1, incidents: 1 });
    expect(importBody.skipped).toEqual({ monitors: 0, maintenance: 0, incidents: 0 });
    expect(importBody.heartbeatMonitors).toHaveLength(1);

    const replacement = importBody.heartbeatMonitors[0]!;
    expect(replacement.id).not.toBe(oldMonitorId);
    expect(replacement.name).toBe("Imported integration heartbeat");
    expect(replacement.heartbeatToken).toMatch(/^[A-Za-z0-9_-]+$/);

    const storedMonitor = await env.DB.prepare(
      "SELECT heartbeat_token, heartbeat_token_hash FROM monitors WHERE id = ?",
    )
      .bind(replacement.id)
      .first<{ heartbeat_token: string | null; heartbeat_token_hash: string | null }>();
    expect(storedMonitor?.heartbeat_token).toBeNull();
    expect(storedMonitor?.heartbeat_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedMonitor?.heartbeat_token_hash).not.toBe(replacement.heartbeatToken);

    const maintenance = await env.DB.prepare(
      "SELECT id, monitor_ids FROM maintenance_windows WHERE title = ?",
    )
      .bind("Imported maintenance")
      .first<{ id: string; monitor_ids: string }>();
    expect(JSON.parse(maintenance?.monitor_ids ?? "null")).toEqual([replacement.id]);

    const incident = await env.DB.prepare(
      "SELECT monitor_id, public FROM incidents WHERE id = ?",
    )
      .bind(incidentId)
      .first<{ monitor_id: string; public: number }>();
    expect(incident).toEqual({ monitor_id: replacement.id, public: 0 });

    const readResponse = await apiRequest(`/api/monitors/${replacement.id}`);
    const readBody = await readResponse.json<{ monitor: { heartbeatToken: string | null } }>();
    expect(readResponse.status).toBe(200);
    expect(readBody.monitor.heartbeatToken).toBeNull();

    const deleteMaintenance = await apiRequest(`/api/maintenance/${maintenance?.id}`, {
      method: "DELETE",
    });
    expect(deleteMaintenance.status).toBe(200);
    const deleteMonitor = await apiRequest(`/api/monitors/${replacement.id}`, {
      method: "DELETE",
    });
    expect(deleteMonitor.status).toBe(200);

    const leftovers = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM monitors WHERE id = ?) AS monitors,
         (SELECT COUNT(*) FROM maintenance_windows WHERE id = ?) AS maintenance,
         (SELECT COUNT(*) FROM incidents WHERE id = ?) AS incidents`,
    )
      .bind(replacement.id, maintenance?.id, incidentId)
      .first<{ monitors: number; maintenance: number; incidents: number }>();
    expect(leftovers).toEqual({ monitors: 0, maintenance: 0, incidents: 0 });
  });
});
