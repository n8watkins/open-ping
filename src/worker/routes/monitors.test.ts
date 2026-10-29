import { describe, expect, it } from "vitest";
import type { MonitorRecord } from "../db/monitors";
import {
  mergeMonitorPatch,
  monitorPatchSchema,
  presentCreatedMonitor,
  redactMonitor,
} from "./monitors";

function heartbeatMonitor(): MonitorRecord {
  return {
    id: "mon_heartbeat",
    type: "heartbeat",
    name: "Backup job",
    enabled: true,
    paused: false,
    intervalSeconds: 3600,
    graceSeconds: 300,
    confirmFailures: "retry",
    config: {
      intervalSeconds: 3600,
      graceSeconds: 300,
      secret: "secondary-secret",
    },
    schedule: { mode: "always" },
    assertions: [],
    notify: { channels: [] },
    public: {
      visible: false,
      sortOrder: 0,
      showUptime: true,
      showResponseTime: false,
      showIncidentDetails: true,
    },
    categoryId: null,
    heartbeatToken: "raw-ingestion-token",
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("heartbeat token presentation", () => {
  it("removes ingestion and config secrets from normal monitor responses", () => {
    const presented = redactMonitor(heartbeatMonitor());

    expect(presented.heartbeatToken).toBeNull();
    expect("secret" in presented.config && presented.config.secret).toBe("");
  });

  it("includes the raw ingestion token in the creation response only", () => {
    const presented = presentCreatedMonitor(heartbeatMonitor());

    expect(presented.heartbeatToken).toBe("raw-ingestion-token");
    expect("secret" in presented.config && presented.config.secret).toBe("");
  });
});

describe("mergeMonitorPatch", () => {
  it("merges config and public key by key and replaces other fields", () => {
    const merged = mergeMonitorPatch(heartbeatMonitor(), {
      name: "Nightly backup",
      config: { graceSeconds: 600 },
      public: { visible: true },
    });
    expect(merged).toMatchObject({
      type: "heartbeat",
      name: "Nightly backup",
      enabled: true,
      schedule: { mode: "always" },
      config: { intervalSeconds: 3600, graceSeconds: 600, secret: "secondary-secret" },
      public: { visible: true, showUptime: true },
    });
    expect(merged).not.toHaveProperty("assertions");
  });

  it("removes a config key set to null and can clear the category", () => {
    const monitor = { ...heartbeatMonitor(), categoryId: "cat_1" };
    const merged = mergeMonitorPatch(monitor, { config: { secret: null }, categoryId: null });
    expect(merged.config).toEqual({ intervalSeconds: 3600, graceSeconds: 300 });
    expect(merged.categoryId).toBeNull();
  });

  it("keeps a polled monitor's interval unless the patch changes it, and never gives a heartbeat one", () => {
    const http: MonitorRecord = {
      ...heartbeatMonitor(),
      id: "mon_http",
      type: "http",
      intervalSeconds: 60,
      graceSeconds: null,
      config: { url: "https://example.com/" } as MonitorRecord["config"],
    };
    expect(mergeMonitorPatch(http, { name: "Renamed" }).intervalSeconds).toBe(60);
    expect(mergeMonitorPatch(http, { intervalSeconds: 300 }).intervalSeconds).toBe(300);
    expect(mergeMonitorPatch(heartbeatMonitor(), { intervalSeconds: 60 })).not.toHaveProperty("intervalSeconds");
  });

  it("rejects unknown fields in a patch", () => {
    expect(monitorPatchSchema.safeParse({ nmae: "typo" }).success).toBe(false);
    expect(monitorPatchSchema.safeParse({ name: "ok" }).success).toBe(true);
  });
});
