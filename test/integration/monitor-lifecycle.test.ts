import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { enqueue } from "../../src/worker/db/outbox";
import { processOutbox } from "../../src/worker/notifications/dispatcher";
import { runScheduled } from "../../src/worker/scheduler";

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

  it("records one incident for a heartbeat missed across scheduler runs", async () => {
    const createdResponse = await apiRequest("/api/monitors", {
      method: "POST",
      body: JSON.stringify({
        type: "heartbeat",
        name: "Scheduler integration heartbeat",
        config: { intervalSeconds: 60, graceSeconds: 0 },
      }),
    });
    const createdBody = await createdResponse.json<{ monitor: { id: string } }>();
    const monitorId = createdBody.monitor.id;
    const staleBeatAt = Date.now() - 120_000;
    await env.DB.prepare(
      `UPDATE monitor_state
       SET state = 'warming_up', state_since = ?, last_beat_at = ?, next_check_at = ?
       WHERE monitor_id = ?`,
    )
      .bind(staleBeatAt, staleBeatAt, staleBeatAt + 60_000, monitorId)
      .run();

    const controller: ScheduledController = {
      cron: "*/12 * * * *",
      scheduledTime: Date.now(),
      noRetry() {},
    };
    await runScheduled(controller, env);
    await runScheduled(controller, env);

    const state = await env.DB.prepare(
      `SELECT state, last_error, consecutive_failures, active_incident_id
       FROM monitor_state WHERE monitor_id = ?`,
    )
      .bind(monitorId)
      .first<{
        state: string;
        last_error: string | null;
        consecutive_failures: number;
        active_incident_id: string | null;
      }>();
    expect(state?.state).toBe("down");
    expect(state?.last_error).toBe("heartbeat_missed");
    expect(state?.consecutive_failures).toBe(2);
    expect(state?.active_incident_id).toMatch(/^inc_/);

    const incidents = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM incidents WHERE monitor_id = ? AND status = 'open'",
    )
      .bind(monitorId)
      .first<{ count: number }>();
    expect(incidents?.count).toBe(1);

    const samples = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM samples WHERE monitor_id = ? AND error = 'heartbeat_missed'",
    )
      .bind(monitorId)
      .first<{ count: number }>();
    expect(samples?.count).toBe(1);

    const summaries = await env.DB.prepare(
      `SELECT period, down_seconds
       FROM summaries WHERE monitor_id = ? ORDER BY period`,
    )
      .bind(monitorId)
      .all<{ period: string; down_seconds: number }>();
    expect(summaries.results).toEqual([
      { period: "day", down_seconds: 1440 },
      { period: "hour", down_seconds: 1440 },
      { period: "month", down_seconds: 1440 },
    ]);

    const runs = await env.DB.prepare(
      `SELECT ok, monitors_checked, check_failures
       FROM scheduler_runs ORDER BY started_at DESC LIMIT 2`,
    ).all<{ ok: number; monitors_checked: number; check_failures: number }>();
    expect(runs.results).toHaveLength(2);
    for (const run of runs.results) {
      expect(run).toMatchObject({ ok: 1, monitors_checked: 1, check_failures: 1 });
    }

    const deleted = await apiRequest(`/api/monitors/${monitorId}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
  });

  it("parks idempotent deliveries whose channel was removed", async () => {
    const eventKey = "integration:missing-channel";
    let channelId: string | undefined;
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected provider request"));

    try {
      const createdResponse = await apiRequest("/api/channels", {
        method: "POST",
        body: JSON.stringify({
          type: "webhook",
          name: "Removed channel integration",
          config: { url: "https://notifications.example.com/openping" },
        }),
      });
      const createdBody = await createdResponse.json<{
        channel: { id: string; type: string };
      }>();
      channelId = createdBody.channel.id;
      expect(createdResponse.status).toBe(201);
      expect(channelId).toMatch(/^ch_/);
      expect(createdBody.channel.type).toBe("webhook");

      const entry = {
        eventKey,
        channelId,
        channelType: "webhook",
        eventType: "test",
        payload: {
          event: "test",
          monitorId: "test",
          monitorName: "Removed channel",
          state: "up",
          title: "Integration notification",
          body: "This delivery must be parked without an outbound request.",
          detectedAt: Date.now(),
        },
      };
      await enqueue(env, [entry]);
      await enqueue(env, [entry]);

      const before = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM notification_outbox WHERE event_key = ?",
      )
        .bind(eventKey)
        .first<{ count: number }>();
      expect(before?.count).toBe(1);

      const deleted = await apiRequest(`/api/channels/${channelId}`, {
        method: "DELETE",
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ ok: true });
      const removed = await apiRequest(`/api/channels/${channelId}`);
      expect(removed.status).toBe(404);

      const queuedAfterDelete = await env.DB.prepare(
        `SELECT channel_id, status, attempts, last_error
         FROM notification_outbox WHERE event_key = ?`,
      )
        .bind(eventKey)
        .first<{
          channel_id: string | null;
          status: string;
          attempts: number;
          last_error: string | null;
        }>();
      expect(queuedAfterDelete).toEqual({
        channel_id: channelId,
        status: "pending",
        attempts: 0,
        last_error: null,
      });

      const result = await processOutbox(env, Date.now());
      expect(result).toEqual({ processed: 1, sent: 0, failed: 1 });
      expect(providerFetch).not.toHaveBeenCalled();

      const parked = await env.DB.prepare(
        `SELECT status, attempts, last_error, next_attempt_at
         FROM notification_outbox WHERE event_key = ?`,
      )
        .bind(eventKey)
        .first<{
          status: string;
          attempts: number;
          last_error: string | null;
          next_attempt_at: number | null;
        }>();
      expect(parked).toMatchObject({
        status: "dead",
        attempts: 5,
        last_error: "channel_unavailable",
      });
      expect(parked?.next_attempt_at).toEqual(expect.any(Number));

      const secondPass = await processOutbox(env, Date.now() + 24 * 60 * 60 * 1000);
      expect(secondPass).toEqual({ processed: 0, sent: 0, failed: 0 });
      expect(providerFetch).not.toHaveBeenCalled();
    } finally {
      providerFetch.mockRestore();
      await env.DB.prepare("DELETE FROM notification_outbox WHERE event_key = ?")
        .bind(eventKey)
        .run();
      if (channelId) {
        await apiRequest(`/api/channels/${channelId}`, { method: "DELETE" });
      }
    }
  });

  it("delivers a signed webhook and records durable success", async () => {
    const eventKey = "integration:successful-webhook";
    const corruptEventKey = "integration:corrupt-webhook";
    const malformedEventKey = "integration:malformed-webhook";
    const webhookUrl = "https://notifications.example.com/openping-success";
    const webhookSecret = "integration-signing-secret";
    let channelId: string | undefined;
    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    try {
      const createdResponse = await apiRequest("/api/channels", {
        method: "POST",
        body: JSON.stringify({
          type: "webhook",
          name: "Successful webhook integration",
          config: { url: webhookUrl, secret: webhookSecret },
        }),
      });
      expect(createdResponse.status).toBe(201);
      const createdBody = await createdResponse.json<{
        channel: { id: string; config: { url: string; secret: string } };
      }>();
      channelId = createdBody.channel.id;
      expect(createdBody.channel.config).toEqual({ url: "", secret: "" });

      let storedChannel = await env.DB.prepare(
        "SELECT config FROM notification_channels WHERE id = ?",
      )
        .bind(channelId)
        .first<{ config: string }>();
      expect(storedChannel?.config).not.toContain(webhookUrl);
      expect(storedChannel?.config).not.toContain(webhookSecret);

      // Simulate a pre-hardening plaintext row. A normal authenticated read
      // must redact both capabilities and lazily replace them with ciphertext.
      await env.DB.prepare(
        "UPDATE notification_channels SET config = ? WHERE id = ?",
      )
        .bind(JSON.stringify({ url: webhookUrl, secret: webhookSecret }), channelId)
        .run();
      const upgradedResponse = await apiRequest(`/api/channels/${channelId}`);
      expect(upgradedResponse.status).toBe(200);
      const upgradedBody = await upgradedResponse.json<{
        channel: { config: { url: string; secret: string } };
      }>();
      expect(upgradedBody.channel.config).toEqual({ url: "", secret: "" });
      storedChannel = await env.DB.prepare(
        "SELECT config FROM notification_channels WHERE id = ?",
      )
        .bind(channelId)
        .first<{ config: string }>();
      expect(storedChannel?.config).not.toContain(webhookUrl);
      expect(storedChannel?.config).not.toContain(webhookSecret);

      // Match the browser's redacted edit flow: both capability fields are
      // blank in the form, and an unchanged optional secret is omitted from
      // the submitted config. The stored URL and secret must survive.
      const editedResponse = await apiRequest(`/api/channels/${channelId}`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Edited successful webhook integration",
          config: { url: "" },
        }),
      });
      expect(editedResponse.status).toBe(200);
      const editedBody = await editedResponse.json<{
        channel: { name: string; config: { url: string; secret: string } };
      }>();
      expect(editedBody.channel).toMatchObject({
        name: "Edited successful webhook integration",
        config: { url: "", secret: "" },
      });
      storedChannel = await env.DB.prepare(
        "SELECT config FROM notification_channels WHERE id = ?",
      )
        .bind(channelId)
        .first<{ config: string }>();
      expect(storedChannel?.config).toMatch(/"url":"v1:/);
      expect(storedChannel?.config).toMatch(/"secret":"v1:/);
      expect(storedChannel?.config).not.toContain(webhookUrl);
      expect(storedChannel?.config).not.toContain(webhookSecret);

      const deliveryPayload = {
        event: "test",
        monitorId: "test",
        monitorName: "Successful webhook",
        state: "up",
        title: "Integration notification",
        body: "The provider accepted this mocked delivery.",
        detectedAt: Date.now(),
      };
      await enqueue(env, [
        {
          eventKey,
          channelId,
          channelType: "webhook",
          eventType: "test",
          payload: deliveryPayload,
        },
      ]);

      const storedDelivery = await env.DB.prepare(
        "SELECT payload FROM notification_outbox WHERE event_key = ?",
      )
        .bind(eventKey)
        .first<{ payload: string }>();
      expect(storedDelivery?.payload).toMatch(/^v1:/);
      expect(storedDelivery?.payload).not.toContain("Integration notification");

      // Existing queues can contain plaintext JSON from an older deployment.
      // The dispatcher must continue draining those rows during the upgrade.
      await env.DB.prepare(
        "UPDATE notification_outbox SET payload = ? WHERE event_key = ?",
      )
        .bind(JSON.stringify(deliveryPayload), eventKey)
        .run();

      const result = await processOutbox(env, Date.now());
      expect(result).toEqual({ processed: 1, sent: 1, failed: 0 });
      expect(providerFetch).toHaveBeenCalledOnce();

      const [requestUrl, requestInit] = providerFetch.mock.calls[0]!;
      expect(requestUrl).toBe(webhookUrl);
      expect(requestInit?.method).toBe("POST");
      const requestHeaders = new Headers(requestInit?.headers);
      expect(requestHeaders.get("content-type")).toBe("application/json");
      expect(requestHeaders.get("x-openping-timestamp")).toMatch(/^\d+$/);
      expect(requestHeaders.get("x-openping-signature")).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(String(requestInit?.body)).toContain("Integration notification");

      const delivery = await env.DB.prepare(
        "SELECT status, attempts, last_error, payload FROM notification_outbox WHERE event_key = ?",
      )
        .bind(eventKey)
        .first<{
          status: string;
          attempts: number;
          last_error: string | null;
          payload: string;
        }>();
      expect(delivery).toMatchObject({ status: "sent", attempts: 0, last_error: null });
      expect(delivery?.payload).toMatch(/^v1:/);
      expect(delivery?.payload).not.toContain("Integration notification");

      const channelResult = await env.DB.prepare(
        "SELECT last_success_at, last_failure_at, last_error FROM notification_channels WHERE id = ?",
      )
        .bind(channelId)
        .first<{
          last_success_at: number | null;
          last_failure_at: number | null;
          last_error: string | null;
        }>();
      expect(channelResult?.last_success_at).toEqual(expect.any(Number));
      expect(channelResult?.last_failure_at).toBeNull();
      expect(channelResult?.last_error).toBeNull();

      await enqueue(env, [
        {
          eventKey: corruptEventKey,
          channelId,
          channelType: "webhook",
          eventType: "test",
          payload: deliveryPayload,
        },
      ]);
      await env.DB.prepare(
        "UPDATE notification_outbox SET payload = ? WHERE event_key = ?",
      )
        .bind("v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==", corruptEventKey)
        .run();

      providerFetch.mockClear();
      const corruptResult = await processOutbox(env, Date.now());
      expect(corruptResult).toEqual({ processed: 1, sent: 0, failed: 1 });
      expect(providerFetch).not.toHaveBeenCalled();
      const corruptDelivery = await env.DB.prepare(
        "SELECT status, attempts, last_error FROM notification_outbox WHERE event_key = ?",
      )
        .bind(corruptEventKey)
        .first<{ status: string; attempts: number; last_error: string | null }>();
      expect(corruptDelivery).toEqual({
        status: "failed",
        attempts: 1,
        last_error: "payload_decryption_failed",
      });

      await enqueue(env, [
        {
          eventKey: malformedEventKey,
          channelId,
          channelType: "webhook",
          eventType: "test",
          payload: deliveryPayload,
        },
      ]);
      await env.DB.prepare(
        "UPDATE notification_outbox SET payload = ? WHERE event_key = ?",
      )
        .bind(JSON.stringify({ unexpected: true }), malformedEventKey)
        .run();

      providerFetch.mockClear();
      const malformedResult = await processOutbox(env, Date.now());
      expect(malformedResult).toEqual({ processed: 1, sent: 0, failed: 1 });
      expect(providerFetch).not.toHaveBeenCalled();
      const malformedDelivery = await env.DB.prepare(
        "SELECT status, attempts, last_error FROM notification_outbox WHERE event_key = ?",
      )
        .bind(malformedEventKey)
        .first<{ status: string; attempts: number; last_error: string | null }>();
      expect(malformedDelivery).toEqual({
        status: "failed",
        attempts: 1,
        last_error: "payload_invalid_shape",
      });
    } finally {
      providerFetch.mockRestore();
      await env.DB.prepare(
        "DELETE FROM notification_outbox WHERE event_key IN (?, ?, ?)",
      )
        .bind(eventKey, corruptEventKey, malformedEventKey)
        .run();
      if (channelId) {
        await apiRequest(`/api/channels/${channelId}`, { method: "DELETE" });
      }
    }
  });

  it("runs a due HTTP monitor through the scheduler success path", async () => {
    const targetUrl = "https://health.example.com/openping";
    let monitorId: string | undefined;
    const providerFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== targetUrl) {
        throw new Error(`unexpected outbound request: ${url}`);
      }
      return new Response('{"status":"healthy"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const createdResponse = await apiRequest("/api/monitors", {
        method: "POST",
        body: JSON.stringify({
          type: "http",
          name: "Scheduler HTTP integration",
          config: { url: targetUrl },
          assertions: [
            { kind: "json_path_equals", path: "status", value: "healthy" },
          ],
        }),
      });
      expect(createdResponse.status).toBe(201);
      const createdBody = await createdResponse.json<{ monitor: { id: string } }>();
      monitorId = createdBody.monitor.id;

      const controller: ScheduledController = {
        cron: "*/12 * * * *",
        scheduledTime: Date.now(),
        noRetry() {},
      };
      await runScheduled(controller, env);
      expect(providerFetch).toHaveBeenCalledOnce();

      const state = await env.DB.prepare(
        `SELECT state, last_status_code, last_error, consecutive_successes,
                last_success_at, next_check_at
         FROM monitor_state WHERE monitor_id = ?`,
      )
        .bind(monitorId)
        .first<{
          state: string;
          last_status_code: number | null;
          last_error: string | null;
          consecutive_successes: number;
          last_success_at: number | null;
          next_check_at: number | null;
        }>();
      expect(state).toMatchObject({
        state: "up",
        last_status_code: 200,
        last_error: null,
        consecutive_successes: 1,
      });
      expect(state?.last_success_at).toEqual(expect.any(Number));
      expect(state?.next_check_at).toEqual(expect.any(Number));

      const sample = await env.DB.prepare(
        `SELECT ok, state, status_code, attempts, warmup, error
         FROM samples WHERE monitor_id = ?`,
      )
        .bind(monitorId)
        .first<{
          ok: number;
          state: string;
          status_code: number | null;
          attempts: number;
          warmup: number;
          error: string | null;
        }>();
      expect(sample).toEqual({
        ok: 1,
        state: "up",
        status_code: 200,
        attempts: 1,
        warmup: 1,
        error: null,
      });

      const run = await env.DB.prepare(
        `SELECT ok, monitors_checked, monitors_skipped, check_failures
         FROM scheduler_runs ORDER BY started_at DESC LIMIT 1`,
      ).first<{
        ok: number;
        monitors_checked: number;
        monitors_skipped: number;
        check_failures: number;
      }>();
      expect(run).toEqual({
        ok: 1,
        monitors_checked: 1,
        monitors_skipped: 0,
        check_failures: 0,
      });
    } finally {
      providerFetch.mockRestore();
      if (monitorId) {
        await apiRequest(`/api/monitors/${monitorId}`, { method: "DELETE" });
      }
    }
  });
});
