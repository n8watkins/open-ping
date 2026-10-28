import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import "../../src/worker/index";

const ORIGIN = "https://openping.test";
const API_TOKEN = "integration-api-token";
const PROTOCOL = "2025-06-18";
const HTTP_AUTH_TOKEN = "integration-upstream-bearer";
const HEADER_SECRET = "integration-header-secret";

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function mcpPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

let nextId = 1;
async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const res = await mcpPost({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) });
  expect(res.status).toBe(200);
  const body = await res.json<{ result?: T; error?: { message: string } }>();
  expect(body.error).toBeUndefined();
  return body.result as T;
}

function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return rpc<ToolResult>("tools/call", { name, arguments: args });
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    "INSERT INTO settings (key, value, encrypted, updated_at) VALUES ('timezone', 'America/Los_Angeles', 0, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(Date.now())
    .run();
});

describe("/mcp over JSON-RPC against D1", () => {
  it("requires the bearer token and serves no browser surface", async () => {
    const anonymous = await exports.default.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");

    const wrong = await mcpPost({}, { authorization: "Bearer wrong" });
    expect(wrong.status).toBe(401);

    const preflight = await exports.default.fetch(`${ORIGIN}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const metadata = await exports.default.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    expect(metadata.status).toBe(404);
    expect(metadata.headers.get("content-type")).toContain("application/json");
  });

  it("initializes, lists tools and reports status", async () => {
    const init = await rpc<{ protocolVersion: string; serverInfo: { name: string }; capabilities: { tools?: unknown } }>(
      "initialize",
      { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "integration", version: "1" } },
    );
    expect(init.protocolVersion).toBe(PROTOCOL);
    expect(init.serverInfo.name).toBe("openping");
    expect(init.capabilities.tools).toBeDefined();

    const { tools } = await rpc<{ tools: { name: string }[] }>("tools/list");
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_status", "create_monitor", "delete_monitor"]));

    const status = await call("get_status");
    expect(status.isError).toBeUndefined();
    expect(status.content[0]!.text).toContain("Times in America/Los_Angeles");
    expect(status.structuredContent).toMatchObject({ timezone: "America/Los_Angeles" });
  });

  it("runs a monitor through create, read, partial update, pause, uptime and delete", async () => {
    const created = await call("create_monitor", {
      type: "http",
      name: "MCP integration API",
      config: {
        url: "https://api.example.com/health?key=visible-in-url",
        headers: [{ name: "X-Api-Key", value: HEADER_SECRET }],
        auth: { type: "bearer", token: HTTP_AUTH_TOKEN },
      },
      schedule: { mode: "business_hours", weekdays: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", timezone: "America/Los_Angeles" },
    });
    expect(created.isError).toBeUndefined();
    const id = (created.structuredContent!.monitor as { id: string }).id;
    expect(id).toMatch(/^mon_/);
    expect(JSON.stringify(created)).not.toContain(HTTP_AUTH_TOKEN);
    expect(JSON.stringify(created)).not.toContain(HEADER_SECRET);

    // Stored sealed: the raw row holds neither secret.
    const row = await env.DB.prepare("SELECT config FROM monitors WHERE id = ?").bind(id).first<{ config: string }>();
    expect(row!.config).not.toContain(HTTP_AUTH_TOKEN);

    const invalid = await call("create_monitor", { type: "tcp", name: "SMTP", config: { host: "mail.example.com", port: 25 } });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]!.text).toContain("port 25");

    const read = await call("get_monitor", { id });
    const config = (read.structuredContent!.monitor as { config: Record<string, unknown> }).config;
    expect(config.auth).toEqual({ type: "bearer", token: "" });
    expect(config.headers).toEqual([{ name: "X-Api-Key", value: "" }]);
    expect((read.structuredContent!.monitor as { createdAt: string }).createdAt).toMatch(/[-+]\d\d:\d\d$/);

    const updated = await call("update_monitor", { id, name: "MCP integration API v2", config: { url: "https://api.example.com/v2" } });
    expect(updated.isError).toBeUndefined();
    // The REST API (which reads the decrypted row) proves the stored secrets survived.
    const stored = await import("../../src/worker/db/monitors").then((m) => m.getMonitor(env, id));
    expect(stored!.name).toBe("MCP integration API v2");
    expect(stored!.config).toMatchObject({
      url: "https://api.example.com/v2",
      auth: { type: "bearer", token: HTTP_AUTH_TOKEN },
      headers: [{ name: "X-Api-Key", value: HEADER_SECRET }],
    });

    const paused = await call("pause_monitor", { id });
    expect((paused.structuredContent!.monitor as { paused: boolean }).paused).toBe(true);
    const listed = await call("list_monitors");
    expect(listed.content[0]!.text).toContain(`${id} paused`);
    await call("resume_monitor", { id });

    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const summary = (period: "hour" | "day", bucket: number, checks: number, ok: number, down: number) =>
      env.DB.prepare(
        `INSERT INTO summaries (id, monitor_id, period, bucket_start, checks, ok_checks, fail_checks, monitored_seconds, down_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(`${id}:${period}:${bucket}`, id, period, bucket, checks, ok, checks - ok, checks * 720, down);
    await env.DB.batch([
      summary("hour", hour - 3_600_000, 10, 9, 720),
      summary("hour", hour - 10 * 86_400_000, 10, 10, 0),
      summary("day", day - 60 * 86_400_000, 20, 19, 720),
    ]);
    const uptime = await call("get_uptime", { monitorId: id });
    const m = (uptime.structuredContent!.monitors as Record<string, { uptimePct: number; checks: number }>[])[0]!;
    expect(m.d1).toMatchObject({ uptimePct: 90, checks: 10 });
    expect(m.d7).toMatchObject({ uptimePct: 90, checks: 10 });
    expect(m.d30).toMatchObject({ uptimePct: 95, checks: 20 });
    expect(m.d90).toMatchObject({ uptimePct: 95, checks: 20 });
    expect(uptime.content[0]!.text).toContain("90% / 90% / 95% / 95%");

    // The REST uptime endpoint the CLI uses returns the same numbers.
    const rest = await api("/api/monitors/uptime");
    const restBody = await rest.json<{ monitors: { id: string; d30: { uptimePct: number } }[] }>();
    expect(restBody.monitors.find((x) => x.id === id)!.d30.uptimePct).toBe(95);

    const refused = await call("delete_monitor", { id });
    expect(refused.isError).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM monitors WHERE id = ?").bind(id).first("n")).toBe(1);

    const deleted = await call("delete_monitor", { id, confirm: true });
    expect(deleted.isError).toBeUndefined();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM monitors WHERE id = ?").bind(id).first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM summaries WHERE monitor_id = ?").bind(id).first("n")).toBe(0);
  });

  it("creates a heartbeat whose ping URL works and is shown only once", async () => {
    const created = await call("create_monitor", {
      type: "heartbeat",
      name: "MCP integration heartbeat",
      config: { intervalSeconds: 3600, graceSeconds: 300 },
    });
    const url = created.structuredContent!.heartbeatUrl as string;
    expect(url).toMatch(new RegExp(`^${ORIGIN}/hb/[A-Za-z0-9_-]+$`));
    const id = (created.structuredContent!.monitor as { id: string }).id;

    const beat = await exports.default.fetch(url, { method: "POST" });
    expect(beat.status).toBe(200);

    const again = await call("get_monitor", { id });
    expect(JSON.stringify(again)).not.toContain(url.split("/hb/")[1]!);

    const rotated = await call("rotate_heartbeat_token", { id, confirm: true });
    const newUrl = rotated.structuredContent!.heartbeatUrl as string;
    expect(newUrl).not.toBe(url);
    expect((await exports.default.fetch(url, { method: "POST" })).status).toBe(404);
    expect((await exports.default.fetch(newUrl, { method: "POST" })).status).toBe(200);

    await call("delete_monitor", { id, confirm: true });
  });

  it("creates and ends a maintenance window and edits a status page", async () => {
    const created = await call("create_maintenance_window", { title: "MCP deploy", durationMinutes: 30 });
    expect(created.isError).toBeUndefined();
    const window = created.structuredContent!.window as { id: string; status: string };
    expect(window.status).toBe("active");

    const active = await call("list_maintenance", { status: "active" });
    expect(active.content[0]!.text).toContain(window.id);

    const ended = await call("end_maintenance_window", { id: window.id });
    expect(ended.structuredContent!.outcome).toBe("ended");
    const again = await call("end_maintenance_window", { id: window.id });
    expect(again.structuredContent!.outcome).toBe("already_ended");

    const future = await call("create_maintenance_window", {
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      durationMinutes: 60,
    });
    const futureId = (future.structuredContent!.window as { id: string }).id;
    expect((await call("end_maintenance_window", { id: futureId })).isError).toBe(true);
    expect((await call("delete_maintenance_window", { id: futureId, confirm: true })).isError).toBeUndefined();

    const pages = await call("list_status_pages");
    const page = (pages.structuredContent!.statusPages as { id: string; isDefault: boolean; name: string }[]).find((p) => p.isDefault)!;
    const renamed = await call("update_status_page", { id: page.id, name: "MCP integration status", description: "Edited over MCP" });
    expect(renamed.isError).toBeUndefined();
    const restPage = await api(`/api/status-pages/${page.id}`).then((r) => r.json<{ statusPage: { name: string; description: string; slug: string } }>());
    expect(restPage.statusPage).toMatchObject({ name: "MCP integration status", description: "Edited over MCP", slug: "default" });

    const badAccent = await call("update_status_page", { id: page.id, accent: "blue" });
    expect(badAccent.isError).toBe(true);
    await call("update_status_page", { id: page.id, name: page.name, description: null });
  });

  it("reports diagnostics, channels and categories without secrets", async () => {
    const created = await api("/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", name: "MCP hook", config: { url: "https://hooks.example.com/secret-path", secret: "hook-secret" } }),
    });
    expect(created.status).toBe(201);
    const channels = await call("list_channels");
    expect(channels.content[0]!.text).toContain("MCP hook");
    expect(JSON.stringify(channels)).not.toContain("secret-path");
    expect(JSON.stringify(channels)).not.toContain("hook-secret");

    const diagnostics = await call("get_diagnostics", { runs: 5 });
    expect(diagnostics.content[0]!.text).toContain("Database ok");

    const keys = await call("get_key_status");
    expect(keys.content[0]!.text).toMatch(/Current key id: [0-9a-f]{8}/);
    expect(JSON.stringify(keys)).not.toContain("hook-secret");

    expect((await call("list_categories")).isError).toBeUndefined();
    expect((await call("list_incidents", { status: "open" })).isError).toBeUndefined();
  });

  it("exposes the same partial updates over REST for the CLI", async () => {
    const created = await api("/api/monitors", {
      method: "POST",
      body: JSON.stringify({
        type: "http",
        name: "REST patch",
        config: { url: "https://example.com", auth: { type: "bearer", token: HTTP_AUTH_TOKEN } },
      }),
    });
    const { monitor } = await created.json<{ monitor: { id: string } }>();

    const patched = await api(`/api/monitors/${monitor.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "REST patched", schedule: { mode: "always" } }),
    });
    expect(patched.status).toBe(200);
    const body = await patched.json<{ monitor: { name: string; config: { url: string; auth: { token: string } } } }>();
    expect(body.monitor).toMatchObject({ name: "REST patched", config: { url: "https://example.com", auth: { token: "" } } });

    const typo = await api(`/api/monitors/${monitor.id}`, { method: "PATCH", body: JSON.stringify({ nmae: "x" }) });
    expect(typo.status).toBe(400);
    const retype = await api(`/api/monitors/${monitor.id}`, { method: "PATCH", body: JSON.stringify({ type: "dns" }) });
    expect(await retype.json()).toEqual({ error: "type_immutable" });
    const missing = await api("/api/monitors/mon_missing", { method: "PATCH", body: "{}" });
    expect(missing.status).toBe(404);

    const window = await api("/api/maintenance", {
      method: "POST",
      body: JSON.stringify({ scope: "global", startsAt: Date.now() - 1000, endsAt: Date.now() + 3_600_000 }),
    }).then((r) => r.json<{ window: { id: string } }>());
    const ended = await api(`/api/maintenance/${window.window.id}/end`, { method: "POST" });
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ outcome: "ended" });

    const pages = await api("/api/status-pages").then((r) => r.json<{ statusPages: { id: string; isDefault: boolean }[] }>());
    const page = pages.statusPages.find((p) => p.isDefault)!;
    const pagePatch = await api(`/api/status-pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ slug: "embed" }) });
    expect(pagePatch.status).toBe(400);

    await api(`/api/monitors/${monitor.id}`, { method: "DELETE" });
  });

  it("serves a 2026-07-28 client too", async () => {
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "integration", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const res = await mcpPost(
      { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "get_status", arguments: {}, _meta: meta } },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "get_status" },
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ result: ToolResult }>();
    expect(body.result.content[0]!.text).toContain("OpenPing:");
  });
});
