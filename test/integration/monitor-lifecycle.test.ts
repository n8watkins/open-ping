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
});
