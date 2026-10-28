import { beforeEach, describe, expect, it, vi } from "vitest";

// The tools reach D1 through the db modules. Monitors and settings are mocked
// so each test sets the exact records it needs; everything else runs for real
// against a fake D1 that returns no rows (and a configurable rate-limit count).
vi.mock("../db/monitors", () => ({
  listMonitors: vi.fn(async () => []),
  getMonitor: vi.fn(async () => null),
  createMonitor: vi.fn(),
  updateMonitor: vi.fn(),
  setPaused: vi.fn(async () => null),
  deleteMonitor: vi.fn(async () => {}),
  rotateHeartbeatToken: vi.fn(async () => null),
}));
vi.mock("../db/settings", () => ({
  getSetting: vi.fn(async (_env: unknown, key: string) =>
    key === "timezone" ? "America/Los_Angeles" : null,
  ),
}));

import { mcp, MCP_RATE_LIMIT_PER_MINUTE } from "./handler";
import {
  createMonitor,
  deleteMonitor,
  getMonitor,
  listMonitors,
  setPaused,
  updateMonitor,
  type MonitorRecord,
} from "../db/monitors";
import type { Env } from "../types";

const TOKEN = "unit-test-api-token";
const ORIGIN = "https://openping.test";
const HTTP_SECRETS = ["bearer-secret-value", "header-secret-value", "body-secret-value"];
const HEARTBEAT_SECRETS = ["heartbeat-shared-secret", "raw-heartbeat-token"];

let rateLimitCount = 1;

function fakeEnv(overrides: Partial<Env> = {}): Env {
  const stmt = (sql: string) => {
    const s = {
      bind: () => s,
      first: async () => (sql.includes("rate_limits") ? { count: rateLimitCount } : null),
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 1 } }),
    };
    return s;
  };
  return {
    API_TOKEN: TOKEN,
    DB: { prepare: stmt, batch: async () => [] } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ...overrides,
  };
}

function httpMonitor(): MonitorRecord {
  return {
    id: "mon_http",
    type: "http",
    name: "API",
    enabled: true,
    paused: false,
    intervalSeconds: 720,
    graceSeconds: null,
    config: {
      url: "https://api.example.com/health",
      method: "POST",
      headers: [{ name: "X-Api-Key", value: "header-secret-value" }],
      body: '{"key":"body-secret-value"}',
      auth: { type: "bearer", token: "bearer-secret-value" },
      timeoutMs: 60000,
      warmupTimeoutMs: 120000,
      followRedirects: true,
      expectedStatus: { min: 200, max: 399 },
    },
    schedule: { mode: "always" },
    assertions: [],
    notify: { channels: [] },
    public: { visible: true, sortOrder: 0, showUptime: true, showResponseTime: false, showIncidentDetails: true },
    categoryId: null,
    heartbeatToken: null,
    sortOrder: 0,
    createdAt: 1_761_000_000_000,
    updatedAt: 1_761_000_000_000,
  };
}

function heartbeatMonitor(): MonitorRecord {
  return {
    ...httpMonitor(),
    id: "mon_hb",
    type: "heartbeat",
    name: "Backup job",
    intervalSeconds: 3600,
    graceSeconds: 300,
    config: { intervalSeconds: 3600, graceSeconds: 300, secret: "heartbeat-shared-secret" },
    heartbeatToken: "raw-heartbeat-token",
  };
}

function post(body: unknown, headers: Record<string, string> = {}, env = fakeEnv()) {
  return mcp.request(
    `${ORIGIN}/`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

interface ToolCallResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  const res = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    { "mcp-protocol-version": "2025-06-18" },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: ToolCallResult; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result!;
}

beforeEach(() => {
  rateLimitCount = 1;
  vi.clearAllMocks();
});

describe("/mcp authentication", () => {
  it("does not exist when API_TOKEN is not configured", async () => {
    const res = await post(initialize, {}, fakeEnv({ API_TOKEN: undefined }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("mcp_disabled");
    expect(body.message).toContain("API_TOKEN");
  });

  it("rejects a request with no token", async () => {
    const res = await post(initialize, { authorization: "" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="OpenPing"');
  });

  it("rejects a wrong token", async () => {
    const res = await post(initialize, { authorization: "Bearer not-the-token" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("does not accept a session cookie in place of the token", async () => {
    const res = await post(initialize, { authorization: "", cookie: "op_session=anything" });
    expect(res.status).toBe(401);
  });

  it("accepts the right token and initializes", async () => {
    const res = await post(initialize);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as { result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(body.result.serverInfo.name).toBe("openping");
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("also serves 2026-07-28 clients (per-request envelope, no initialize)", async () => {
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const res = await post(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_categories", arguments: {}, _meta: meta } },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "list_categories" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    expect(body.result.content[0]!.text).toBe("No categories.");
  });

  it("refuses a cross-origin browser request even with the right token", async () => {
    const res = await post(initialize, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await post(initialize, { origin: ORIGIN })).status).toBe(200);
  });

  it("is POST only (stateless: no SSE stream to open)", async () => {
    const res = await mcp.request(`${ORIGIN}/`, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }, fakeEnv());
    expect(res.status).toBe(405);
  });

  it("rate-limits authenticated requests", async () => {
    rateLimitCount = MCP_RATE_LIMIT_PER_MINUTE + 1;
    const res = await post(initialize);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("tools/list", () => {
  it("lists every tool with honest annotations", async () => {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" });
    const body = (await res.json()) as {
      result: {
        tools: {
          name: string;
          annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
          inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
        }[];
      };
    };
    const tools = new Map(body.result.tools.map((t) => [t.name, t]));
    expect([...tools.keys()].sort()).toEqual(
      [
        "get_status", "list_monitors", "get_monitor", "list_incidents", "get_uptime", "get_diagnostics", "get_key_status",
        "list_channels", "list_status_pages", "list_categories", "list_maintenance",
        "create_monitor", "update_monitor", "pause_monitor", "resume_monitor",
        "create_maintenance_window", "end_maintenance_window", "update_status_page",
        "delete_monitor", "delete_maintenance_window", "rotate_heartbeat_token",
        "post_incident_update", "get_monthly_report",
      ].sort(),
    );
    for (const t of tools.values()) {
      // Every client accepts a plain object schema at the top level.
      expect(t.inputSchema.type).toBe("object");
      const readOnly = t.name.startsWith("get_") || t.name.startsWith("list_");
      expect(t.annotations.readOnlyHint).toBe(readOnly);
    }
    for (const name of ["delete_monitor", "delete_maintenance_window", "rotate_heartbeat_token"]) {
      expect(tools.get(name)!.annotations.destructiveHint).toBe(true);
      expect(tools.get(name)!.inputSchema.properties).toHaveProperty("confirm");
    }
    for (const name of ["create_monitor", "update_monitor", "pause_monitor", "update_status_page"]) {
      expect(tools.get(name)!.annotations.destructiveHint).toBe(false);
    }
  });
});

describe("read tools", () => {
  it("get_status summarizes state with ISO times in the install timezone", async () => {
    vi.mocked(listMonitors).mockResolvedValue([httpMonitor()]);
    const r = await callTool("get_status");
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("Times in America/Los_Angeles");
    expect(r.content[0]!.text).toContain("API [mon_http]");
    expect(r.structuredContent).toMatchObject({ timezone: "America/Los_Angeles", overall: "no_data" });
  });

  it("get_monitor never returns credentials, header values, bodies or tokens", async () => {
    vi.mocked(getMonitor).mockResolvedValueOnce(httpMonitor());
    const http = await callTool("get_monitor", { id: "mon_http" });
    const httpJson = JSON.stringify(http);
    for (const secret of HTTP_SECRETS) expect(httpJson).not.toContain(secret);
    const config = (http.structuredContent!.monitor as { config: Record<string, unknown> }).config;
    expect(config.headers).toEqual([{ name: "X-Api-Key", value: "" }]);
    expect(config.bodySet).toBe(true);
    expect(config.auth).toEqual({ type: "bearer", token: "" });
    expect((http.structuredContent!.monitor as { createdAt: string }).createdAt).toMatch(/-0[78]:00$/);

    vi.mocked(getMonitor).mockResolvedValueOnce(heartbeatMonitor());
    const hb = JSON.stringify(await callTool("get_monitor", { id: "mon_hb" }));
    for (const secret of HEARTBEAT_SECRETS) expect(hb).not.toContain(secret);
  });

  it("list_monitors redacts too and reports an unknown id as a tool error", async () => {
    vi.mocked(listMonitors).mockResolvedValue([httpMonitor(), heartbeatMonitor()]);
    const r = await callTool("list_monitors");
    expect(r.content[0]!.text).toContain("2 monitor(s)");
    const json = JSON.stringify(r);
    for (const secret of [...HTTP_SECRETS, ...HEARTBEAT_SECRETS]) expect(json).not.toContain(secret);

    const missing = await callTool("get_monitor", { id: "mon_missing" });
    expect(missing.isError).toBe(true);
  });
});

describe("write tools", () => {
  it("create_monitor validates exactly like the API", async () => {
    const bad = await callTool("create_monitor", { type: "http", name: "Bad", config: { url: "javascript:alert(1)" } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("config.url");
    expect(createMonitor).not.toHaveBeenCalled();
  });

  it("create_monitor returns a heartbeat ping URL once, and no secret", async () => {
    vi.mocked(createMonitor).mockResolvedValue(heartbeatMonitor());
    const r = await callTool("create_monitor", {
      type: "heartbeat",
      name: "Backup job",
      config: { intervalSeconds: 3600, graceSeconds: 300, secret: "heartbeat-shared-secret" },
    });
    expect(r.isError).toBeUndefined();
    expect(createMonitor).toHaveBeenCalledOnce();
    expect(r.structuredContent!.heartbeatUrl).toBe(`${ORIGIN}/hb/raw-heartbeat-token`);
    expect(JSON.stringify(r)).not.toContain("heartbeat-shared-secret");
  });

  it("update_monitor merges a partial change and keeps stored secrets", async () => {
    vi.mocked(getMonitor).mockResolvedValue(httpMonitor());
    vi.mocked(updateMonitor).mockImplementation(async (_env, _id, input) => ({ ...httpMonitor(), ...input } as MonitorRecord));
    const r = await callTool("update_monitor", { id: "mon_http", name: "API v2", config: { url: "https://api.example.com/v2" } });
    expect(r.isError).toBeUndefined();
    const input = vi.mocked(updateMonitor).mock.calls[0]![2] as { name: string; config: Record<string, unknown> };
    expect(input.name).toBe("API v2");
    expect(input.config.url).toBe("https://api.example.com/v2");
    expect(input.config.auth).toEqual({ type: "bearer", token: "bearer-secret-value" });
    expect(input.config.headers).toEqual([{ name: "X-Api-Key", value: "header-secret-value" }]);
    for (const secret of HTTP_SECRETS) expect(JSON.stringify(r)).not.toContain(secret);
  });

  it("pause_monitor pauses", async () => {
    vi.mocked(setPaused).mockResolvedValue({ ...httpMonitor(), paused: true });
    const r = await callTool("pause_monitor", { id: "mon_http" });
    expect(setPaused).toHaveBeenCalledWith(expect.anything(), "mon_http", true);
    expect(r.content[0]!.text).toContain("Paused");
  });
});

describe("destructive tools", () => {
  it("delete_monitor does nothing without confirm: true", async () => {
    vi.mocked(getMonitor).mockResolvedValue(httpMonitor());
    for (const args of [{ id: "mon_http" }, { id: "mon_http", confirm: false }]) {
      const r = await callTool("delete_monitor", args);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("confirm: true");
    }
    expect(deleteMonitor).not.toHaveBeenCalled();

    const r = await callTool("delete_monitor", { id: "mon_http", confirm: true });
    expect(r.isError).toBeUndefined();
    expect(deleteMonitor).toHaveBeenCalledWith(expect.anything(), "mon_http");
  });
});
