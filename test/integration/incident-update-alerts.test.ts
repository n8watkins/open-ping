import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { processOutbox } from "../../src/worker/notifications/dispatcher";
import { signPayload } from "../../src/worker/notifications/channels/webhook";
import { upsertSubscription } from "../../src/worker/db/push";
import { ensureVapidPublicKey } from "../../src/worker/notifications/push/vapid";

/**
 * Alerts for incident status updates, against workerd and the real D1
 * migrations: posting an update over REST or MCP queues one encrypted outbox
 * entry per channel that takes the event (never the admin's push devices by
 * default, never a channel the monitor excludes or whose event list leaves it
 * out), `notify: false` queues nothing, and the dispatcher delivers a signed
 * webhook carrying the update and a Slack message showing it.
 */

const ORIGIN = "https://openping.test";
const API_TOKEN = "integration-api-token";
const HOOK_URL = "https://hooks.example.com/openping";
const HOOK_SECRET = "incident-update-hook-secret";
const rand = () => crypto.randomUUID().replaceAll("-", "");
const SLACK_URL = `https://hooks.slack.com/services/T${rand().slice(0, 9)}/B${rand().slice(0, 9)}/${rand()}`;

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  const res = await exports.default.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const body = await res.json<{
    result: { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  }>();
  return body.result;
}

async function createChannel(body: Record<string, unknown>): Promise<string> {
  const res = await api("/api/channels", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return (await res.json<{ channel: { id: string } }>()).channel.id;
}

async function createMonitor(name: string, notifyChannels: string[] = []): Promise<string> {
  const res = await api("/api/monitors", {
    method: "POST",
    body: JSON.stringify({
      type: "http",
      name,
      config: { url: `https://${name.toLowerCase().replace(/\W/g, "")}.example.com/health` },
      notify: { channels: notifyChannels },
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json<{ monitor: { id: string } }>()).monitor.id;
}

async function insertOpenIncident(id: string, monitorId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO incidents (id, monitor_id, status, title, started_at, http_status, error, public, created_at, updated_at)
     VALUES (?, ?, 'open', ?, ?, 503, 'HTTP 503', 0, ?, ?)`,
  )
    .bind(id, monitorId, `${id} title`, now - 600_000, now, now)
    .run();
}

interface OutboxRow {
  id: string;
  event_key: string;
  event_type: string;
  channel_id: string | null;
  channel_type: string;
  monitor_id: string | null;
  payload: string;
  status: string;
}

async function outboxFor(updateId: string): Promise<OutboxRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM notification_outbox WHERE substr(event_key, 1, length(?1)) = ?1 ORDER BY channel_type",
  )
    .bind(`incident_update:${updateId}:`)
    .all<OutboxRow>();
  return results ?? [];
}

let hookId = "";
let slackId = "";
let disabledId = "";
let monitorId = "";
let restrictedId = "";
const INCIDENT = "inc_update_alerts";
const RESTRICTED_INCIDENT = "inc_update_alerts_restricted";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of ["notification_outbox", "push_subscriptions", "notification_channels", "incident_updates", "incidents", "monitor_state", "monitors"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // A push device is subscribed: incident updates still don't go to it by default.
  await ensureVapidPublicKey(env);
  await upsertSubscription(env, { endpoint: "https://push.example.com/send/admin", p256dh: "p256dh", auth: "auth", userAgent: "Firefox" });

  hookId = await createChannel({ type: "webhook", name: "Hook", config: { url: HOOK_URL, secret: HOOK_SECRET } });
  slackId = await createChannel({ type: "slack", name: "Ops Slack", config: { url: SLACK_URL } });
  await createChannel({ type: "webhook", name: "Down only", config: { url: "https://hooks.example.com/down" }, events: ["down"] });
  disabledId = await createChannel({ type: "webhook", name: "Off", config: { url: "https://hooks.example.com/off" } });
  expect((await api(`/api/channels/${disabledId}`, { method: "PUT", body: JSON.stringify({ enabled: false }) })).status).toBe(200);

  monitorId = await createMonitor("Checkout API");
  restrictedId = await createMonitor("Billing", [slackId]);
  await insertOpenIncident(INCIDENT, monitorId);
  await insertOpenIncident(RESTRICTED_INCIDENT, restrictedId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("alerts for incident status updates", () => {
  let updateId = "";

  it("queues one encrypted alert per channel that takes incident updates", async () => {
    const res = await api(`/api/incidents/${INCIDENT}/updates`, {
      method: "POST",
      body: JSON.stringify({ status: "identified", message: "A bad deploy; rolling it back." }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ update: { id: string }; alertsQueued: number; alertsError?: string }>();
    expect(body.alertsQueued).toBe(2);
    expect(body.alertsError).toBeUndefined();
    updateId = body.update.id;

    const rows = await outboxFor(updateId);
    expect(rows.map((r) => [r.channel_type, r.channel_id])).toEqual([
      ["slack", slackId],
      ["webhook", hookId],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ event_type: "incident_update", monitor_id: monitorId, status: "pending" });
      expect(row.payload).toMatch(/^v2:/);
      expect(row.payload).not.toContain("rolling it back");
    }
    // Not the down-only channel, not the disabled one, not the push device.
    const pushRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE channel_type = 'push'").first<{ n: number }>();
    expect(pushRows?.n).toBe(0);
  });

  it("posts quietly with notify false, and rejects a notify that isn't a boolean", async () => {
    const res = await api(`/api/incidents/${INCIDENT}/updates`, {
      method: "POST",
      body: JSON.stringify({ status: "monitoring", message: "Watching it.", notify: false }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ update: { id: string }; alertsQueued: number }>();
    expect(body.alertsQueued).toBe(0);
    expect(await outboxFor(body.update.id)).toEqual([]);

    const bad = await api(`/api/incidents/${INCIDENT}/updates`, {
      method: "POST",
      body: JSON.stringify({ status: "monitoring", message: "Watching it.", notify: "no" }),
    });
    expect(bad.status).toBe(400);
  });

  it("alerts only the channels a restricted monitor allows", async () => {
    const res = await api(`/api/incidents/${RESTRICTED_INCIDENT}/updates`, {
      method: "POST",
      body: JSON.stringify({ status: "investigating", message: "Looking into failed payments." }),
    });
    const body = await res.json<{ update: { id: string }; alertsQueued: number }>();
    expect(body.alertsQueued).toBe(1);
    expect((await outboxFor(body.update.id)).map((r) => r.channel_id)).toEqual([slackId]);
  });

  it("queues alerts from the MCP tool too, and notify false keeps it quiet there", async () => {
    const loud = await mcpCall("post_incident_update", { id: INCIDENT, status: "monitoring", message: "A fix is out." });
    expect(loud.isError).toBeFalsy();
    expect(loud.content[0]!.text).toContain("Queued 2 alerts");
    const loudId = (loud.structuredContent as { update: { id: string } }).update.id;
    expect(await outboxFor(loudId)).toHaveLength(2);

    const quiet = await mcpCall("post_incident_update", { id: INCIDENT, status: "monitoring", message: "Still fine.", notify: false });
    expect(quiet.content[0]!.text).toContain("No alerts were sent");
    expect(await outboxFor((quiet.structuredContent as { update: { id: string } }).update.id)).toEqual([]);
  });

  it("delivers a signed webhook carrying the update and a Slack message showing it", async () => {
    // Deliver only the first update's two entries.
    const mine = (await outboxFor(updateId)).map((r) => r.id);
    await env.DB.prepare(
      `UPDATE notification_outbox SET next_attempt_at = ? WHERE id NOT IN (${mine.map(() => "?").join(",")})`,
    )
      .bind(Date.now() + 3_600_000, ...mine)
      .run();

    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).startsWith("https://hooks.slack.com/") ? new Response("ok") : new Response(null, { status: 204 }),
    );
    const r = await processOutbox(env, Date.now() + 1000);
    expect(r).toEqual({ processed: 2, sent: 2, failed: 0 });
    expect(provider).toHaveBeenCalledTimes(2);

    const hookCall = provider.mock.calls.find(([url]) => String(url) === HOOK_URL)!;
    const headers = new Headers(hookCall[1]?.headers);
    const raw = String(hookCall[1]?.body);
    const timestamp = headers.get("x-openping-timestamp")!;
    expect(headers.get("x-openping-signature")).toBe(`sha256=${await signPayload(HOOK_SECRET, `${timestamp}.${raw}`)}`);
    const sent = JSON.parse(raw);
    expect(sent).toMatchObject({
      event: "incident_update",
      monitorId,
      monitorName: "Checkout API",
      state: "down",
      title: "📢 Incident update: Checkout API - Identified",
      body: "A bad deploy; rolling it back.",
      url: `${ORIGIN}/incidents?incident=${INCIDENT}`,
      incidentId: INCIDENT,
      update: { id: updateId, status: "identified", label: "Identified", message: "A bad deploy; rolling it back." },
    });
    expect(sent.detectedAt).toBe(sent.update.postedAt);

    const slackCall = provider.mock.calls.find(([url]) => String(url) === SLACK_URL)!;
    const slack = JSON.parse(String(slackCall[1]?.body));
    expect(slack.text).toContain("Incident update: Checkout API - Identified");
    expect(slack.attachments[0].color).toBe("#f5a524");

    const statuses = await env.DB.prepare(
      `SELECT status FROM notification_outbox WHERE id IN (${mine.map(() => "?").join(",")})`,
    )
      .bind(...mine)
      .all<{ status: string }>();
    expect(statuses.results.map((s) => s.status)).toEqual(["sent", "sent"]);
  });

  it("queues nothing for an incident that doesn't exist", async () => {
    const res = await api("/api/incidents/inc_missing/updates", {
      method: "POST",
      body: JSON.stringify({ status: "identified", message: "x" }),
    });
    expect(res.status).toBe(404);
  });
});
