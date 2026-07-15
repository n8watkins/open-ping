import { describe, expect, it } from "vitest";
import type { MonitorRecord } from "../db/monitors";
import { presentCreatedMonitor, redactMonitor } from "./monitors";

function heartbeatMonitor(): MonitorRecord {
  return {
    id: "mon_heartbeat",
    type: "heartbeat",
    name: "Backup job",
    enabled: true,
    paused: false,
    intervalSeconds: 3600,
    graceSeconds: 300,
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
      showScheduledOff: false,
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
