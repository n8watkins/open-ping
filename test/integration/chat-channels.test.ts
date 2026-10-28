import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { enqueue } from "../../src/worker/db/outbox";
import { processOutbox } from "../../src/worker/notifications/dispatcher";

const API_ORIGIN = "https://openping.test";
const API_TOKEN = "integration-api-token";

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

// Capabilities are generated per run so no literal in the repo looks like a
// real credential to secret scanners.
const rand = () => crypto.randomUUID().replaceAll("-", "");
const slackUrl = () => `https://hooks.slack.com/services/T${rand().slice(0, 9)}/B${rand().slice(0, 9)}/${rand()}`;
const teamsUrl = () =>
  `https://${rand().slice(0, 12)}.aa.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/${rand()}/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${rand()}`;
const botToken = () => `${Math.floor(Math.random() * 1e9)}:${rand()}`;

interface Case {
  type: "slack" | "teams" | "telegram";
  config: () => Record<string, string>;
  /** The config fields that must never be stored in plaintext or returned. */
  secrets: string[];
  /** Where the delivery must go, from the plaintext config. */
  target: (config: Record<string, string>) => string;
  /** A successful provider response. */
  ok: () => Response;
  /** A rate-limited response asking for 10 minutes. */
  limited: () => Response;
  check: (body: Record<string, unknown>) => void;
}

const CASES: Case[] = [
  {
    type: "slack",
    config: () => ({ url: slackUrl() }),
    secrets: ["url"],
    target: (c) => c.url!,
    ok: () => new Response("ok", { status: 200 }),
    limited: () => new Response("rate_limited", { status: 429, headers: { "Retry-After": "600" } }),
    check: (body) => {
      expect(body.text).toContain("OpenPing test notification");
      const [attachment] = body.attachments as Array<{ color: string; blocks: Array<{ type: string }> }>;
      expect(attachment!.color).toBe("#2fbf6e");
      expect(attachment!.blocks.map((b) => b.type)).toEqual(["header", "section", "context", "actions"]);
    },
  },
  {
    type: "teams",
    config: () => ({ url: teamsUrl() }),
    secrets: ["url"],
    target: (c) => c.url!,
    ok: () => new Response(null, { status: 202 }),
    limited: () => new Response("", { status: 429, headers: { "Retry-After": "600" } }),
    check: (body) => {
      expect(body.type).toBe("message");
      const [attachment] = body.attachments as Array<{ contentType: string; content: { type: string; actions: unknown[] } }>;
      expect(attachment!.contentType).toBe("application/vnd.microsoft.card.adaptive");
      expect(attachment!.content.type).toBe("AdaptiveCard");
      expect(attachment!.content.actions).toHaveLength(1);
    },
  },
  {
    type: "telegram",
    config: () => ({ botToken: botToken(), chatId: "-1001234567890" }),
    secrets: ["botToken"],
    target: (c) => `https://api.telegram.org/bot${c.botToken}/sendMessage`,
    ok: () => Response.json({ ok: true, result: { message_id: 1 } }),
    limited: () =>
      Response.json(
        { ok: false, error_code: 429, description: "Too Many Requests: retry after 600", parameters: { retry_after: 600 } },
        { status: 429 },
      ),
    check: (body) => {
      expect(body).toMatchObject({ chat_id: "-1001234567890", parse_mode: "HTML" });
      expect(body.text).toContain("<b>✅ OpenPing test notification</b>");
    },
  },
];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function storedConfig(id: string): Promise<string> {
  const row = await env.DB.prepare("SELECT config FROM notification_channels WHERE id = ?").bind(id).first<{ config: string }>();
  return row!.config;
}

describe.each(CASES)("$type channel", (c) => {
  it("encrypts the capability, redacts it, delivers a test and honours a 429", async () => {
    const config = c.config();
    const providerFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => c.ok());

    // Create: the response never carries the capability back.
    const created = await apiRequest("/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: c.type, name: `Integration ${c.type}`, config }),
    });
    expect(created.status).toBe(201);
    const { channel } = await created.json<{ channel: { id: string; config: Record<string, string> } }>();
    for (const field of c.secrets) expect(channel.config[field]).toBe("");
    const listed = await (await apiRequest("/api/channels")).text();
    for (const field of c.secrets) expect(listed).not.toContain(config[field]);

    // At rest: every secret field is ciphertext.
    let raw = await storedConfig(channel.id);
    for (const field of c.secrets) {
      expect(raw).not.toContain(config[field]);
      expect(JSON.parse(raw)[field]).toMatch(/^v2:/);
    }

    // The browser's redacted edit flow keeps the stored secret.
    const edited = await apiRequest(`/api/channels/${channel.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: `Edited ${c.type}`,
        config: c.type === "telegram" ? { botToken: "", chatId: config.chatId } : { url: "" },
      }),
    });
    expect(edited.status).toBe(200);
    raw = await storedConfig(channel.id);
    for (const field of c.secrets) expect(JSON.parse(raw)[field]).toMatch(/^v2:/);

    // Send test: one request to exactly the configured destination.
    const tested = await apiRequest(`/api/channels/${channel.id}/test`, { method: "POST" });
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ ok: true });
    expect(providerFetch).toHaveBeenCalledOnce();
    const [url, init] = providerFetch.mock.calls[0]!;
    expect(String(url)).toBe(c.target(config));
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    c.check(JSON.parse(String(init?.body)));

    // A rate-limited delivery is retried no sooner than the provider asked.
    providerFetch.mockReset();
    providerFetch.mockImplementation(async () => c.limited());
    const eventKey = `integration:${c.type}:rate-limited`;
    await enqueue(env, [
      {
        eventKey,
        channelId: channel.id,
        channelType: c.type,
        eventType: "down",
        payload: {
          event: "down",
          monitorId: "m_integration",
          monitorName: "Checkout <api>",
          state: "down",
          title: "🔴 Checkout <api> is down",
          body: "Checkout <api> is down (timeout).",
          error: "timeout",
          detectedAt: Date.now(),
        },
      },
    ]);
    const before = Date.now();
    expect(await processOutbox(env, before)).toEqual({ processed: 1, sent: 0, failed: 1 });
    expect(providerFetch).toHaveBeenCalledOnce();
    const delivery = await env.DB.prepare(
      "SELECT status, attempts, next_attempt_at, last_error FROM notification_outbox WHERE event_key = ?",
    )
      .bind(eventKey)
      .first<{ status: string; attempts: number; next_attempt_at: number; last_error: string }>();
    expect(delivery).toMatchObject({ status: "failed", attempts: 1 });
    expect(delivery!.next_attempt_at).toBeGreaterThanOrEqual(before + 600_000);
    for (const field of c.secrets) expect(delivery!.last_error).not.toContain(config[field]);
    const health = await env.DB.prepare("SELECT last_error FROM notification_channels WHERE id = ?")
      .bind(channel.id)
      .first<{ last_error: string }>();
    expect(health!.last_error).toMatch(/^(slack|teams|telegram)_error/);

    await env.DB.prepare("DELETE FROM notification_outbox WHERE event_key = ?").bind(eventKey).run();
    expect((await apiRequest(`/api/channels/${channel.id}`, { method: "DELETE" })).status).toBe(200);
  });
});

describe("chat channel destinations", () => {
  it("rejects destinations outside each provider's own hosts", async () => {
    const bad = [
      { type: "slack", config: { url: "https://hooks.example.com/services/T0/B0/x" } },
      { type: "slack", config: { url: "http://hooks.slack.com/services/T0/B0/x" } },
      { type: "teams", config: { url: "https://attacker.example/workflows/x" } },
      { type: "teams", config: { url: "https://powerplatform.com.attacker.example/workflows/x" } },
      { type: "telegram", config: { botToken: "123:../../evil", chatId: "1" } },
      { type: "telegram", config: { botToken: botToken(), chatId: "not a chat" } },
    ];
    for (const body of bad) {
      const res = await apiRequest("/api/channels", { method: "POST", body: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("refuses to deliver a stored config that was moved to another host", async () => {
    const providerFetch = vi.spyOn(globalThis, "fetch");
    const created = await apiRequest("/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "slack", config: { url: slackUrl() } }),
    });
    const { channel } = await created.json<{ channel: { id: string } }>();
    // Simulate a hand-edited row (the API would have refused this URL).
    await env.DB.prepare("UPDATE notification_channels SET config = ? WHERE id = ?")
      .bind(JSON.stringify({ url: "https://internal.example.com/services/a/b/c" }), channel.id)
      .run();
    const tested = await apiRequest(`/api/channels/${channel.id}/test`, { method: "POST" });
    expect(tested.status).toBe(502);
    expect(await tested.json()).toMatchObject({ ok: false, error: "invalid_slack_url: not_slack_host" });
    expect(providerFetch).not.toHaveBeenCalled();
    await apiRequest(`/api/channels/${channel.id}`, { method: "DELETE" });
  });

  it("fails closed when a capability can't be decrypted", async () => {
    const providerFetch = vi.spyOn(globalThis, "fetch");
    const created = await apiRequest("/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "telegram", config: { botToken: botToken(), chatId: "42" } }),
    });
    const { channel } = await created.json<{ channel: { id: string } }>();
    // A value sealed under some other key.
    await env.DB.prepare("UPDATE notification_channels SET config = ? WHERE id = ?")
      .bind(JSON.stringify({ botToken: "v2:00000000:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==", chatId: "42" }), channel.id)
      .run();
    const tested = await apiRequest(`/api/channels/${channel.id}/test`, { method: "POST" });
    expect(await tested.json()).toMatchObject({ ok: false, error: "channel_secret_unreadable" });
    expect(providerFetch).not.toHaveBeenCalled();
    await apiRequest(`/api/channels/${channel.id}`, { method: "DELETE" });
  });
});
