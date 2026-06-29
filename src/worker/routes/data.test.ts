import { describe, it, expect } from "vitest";
import { redactMonitorForExport, validateImport } from "./data";
import type { MonitorRecord } from "../db/monitors";
import type { HttpConfig, HeartbeatConfig } from "../../shared/schemas";

/**
 * Unit tests for the PURE export/import helpers (no D1 binding required):
 * `redactMonitorForExport` must strip every secret, and `validateImport` must
 * collect errors without throwing.
 */

/** Build a minimal MonitorRecord with the given config (cast — fixtures stay small). */
function makeMonitor(
  type: "http" | "heartbeat",
  config: Record<string, unknown>,
  overrides: Partial<MonitorRecord> = {},
): MonitorRecord {
  return {
    id: "mon_1",
    type,
    name: "Example",
    enabled: true,
    paused: false,
    intervalSeconds: 720,
    graceSeconds: null,
    config: config as HttpConfig | HeartbeatConfig,
    schedule: { mode: "always" },
    assertions: [],
    notify: { channels: [] },
    public: {
      visible: false,
      sortOrder: 0,
      showUptime: true,
      showResponseTime: false,
      showIncidentDetails: true,
      showScheduledOff: false,
    },
    heartbeatToken: "hb-token-SECRET",
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("redactMonitorForExport", () => {
  it("strips HTTP secrets (bearer token, body, header values) but keeps url", () => {
    const monitor = makeMonitor("http", {
      url: "https://example.com/health",
      method: "GET",
      headers: [{ name: "Authorization", value: "Bearer super-secret" }],
      body: '{"password":"hunter2"}',
      auth: { type: "bearer", token: "TOKEN-SECRET" },
      timeoutMs: 60000,
    });

    const result = redactMonitorForExport(monitor);
    const cfg = result.config;

    // url/method preserved
    expect(cfg.url).toBe("https://example.com/health");
    expect(cfg.method).toBe("GET");

    // body removed entirely
    expect(cfg.body).toBeUndefined();

    // header names kept, values blanked
    const headers = cfg.headers as Array<Record<string, unknown>>;
    expect(headers[0]!.name).toBe("Authorization");
    expect(headers[0]!.value).toBe("");

    // bearer token dropped
    const auth = cfg.auth as Record<string, unknown>;
    expect(auth.type).toBe("bearer");
    expect(auth.token).toBe("");

    // ingestion token never exported
    expect("heartbeatToken" in result).toBe(false);
  });

  it("redacts HTTP basic-auth password but keeps the username", () => {
    const monitor = makeMonitor("http", {
      url: "https://example.com",
      auth: { type: "basic", username: "admin", password: "hunter2" },
    });

    const auth = redactMonitorForExport(monitor).config.auth as Record<
      string,
      unknown
    >;
    expect(auth.username).toBe("admin");
    expect(auth.password).toBe("");
  });

  it("strips the heartbeat secret and drops the heartbeat token", () => {
    const monitor = makeMonitor(
      "heartbeat",
      { intervalSeconds: 3600, graceSeconds: 300, secret: "HB-SECRET" },
      { heartbeatToken: "ingest-token-SECRET" },
    );

    const result = redactMonitorForExport(monitor);
    const cfg = result.config;

    expect(cfg.secret).toBeUndefined();
    expect(cfg.intervalSeconds).toBe(3600);
    expect(cfg.graceSeconds).toBe(300);
    expect("heartbeatToken" in result).toBe(false);
  });

  it("never leaks the original secret values anywhere in the export JSON", () => {
    const monitor = makeMonitor("http", {
      url: "https://example.com",
      headers: [{ name: "X-Api-Key", value: "header-secret" }],
      body: "body-secret",
      auth: { type: "bearer", token: "bearer-secret" },
    });
    const serialized = JSON.stringify(redactMonitorForExport(monitor));
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("body-secret");
    expect(serialized).not.toContain("bearer-secret");
    expect(serialized).not.toContain("hb-token-SECRET");
  });
});

describe("validateImport", () => {
  const validHttpMonitor = {
    type: "http",
    name: "Valid Monitor",
    config: { url: "https://example.com" },
  };

  it("accepts a well-formed payload and reports counts", () => {
    const result = validateImport({
      version: 1,
      monitors: [validHttpMonitor],
      maintenance: [{ scope: "global" }],
      incidents: [{ id: "inc_1" }, { id: "inc_2" }],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.counts).toEqual({ monitors: 1, maintenance: 1, incidents: 2 });
  });

  it("rejects a non-object backup without throwing", () => {
    const result = validateImport("not an object");
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("flags an unsupported version", () => {
    const result = validateImport({
      version: 2,
      monitors: [],
      maintenance: [],
      incidents: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("flags missing arrays", () => {
    const result = validateImport({ version: 1 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("monitors"))).toBe(true);
    expect(result.errors.some((e) => e.includes("maintenance"))).toBe(true);
    expect(result.errors.some((e) => e.includes("incidents"))).toBe(true);
  });

  it("collects an error for a monitor that fails the schema (and excludes it from counts)", () => {
    const result = validateImport({
      version: 1,
      monitors: [
        validHttpMonitor,
        { type: "http", name: "Broken" }, // missing config.url
      ],
      maintenance: [],
      incidents: [],
    });
    expect(result.ok).toBe(false);
    expect(result.counts.monitors).toBe(1);
    expect(result.errors.some((e) => e.includes("index 1"))).toBe(true);
  });
});
