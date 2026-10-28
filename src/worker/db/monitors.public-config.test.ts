import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { getMonitor } from "./monitors";

/** A stored monitor row whose `public` JSON is supplied by the test. */
function rowWithPublic(publicJson: string | null) {
  return {
    id: "mon_1",
    type: "heartbeat",
    name: "Backup job",
    enabled: 1,
    paused: 0,
    interval_seconds: 3600,
    grace_seconds: 300,
    config: JSON.stringify({ intervalSeconds: 3600, graceSeconds: 300 }),
    schedule: JSON.stringify({ mode: "always" }),
    assertions: null,
    notify: JSON.stringify({ channels: [] }),
    public: publicJson,
    category_id: null,
    heartbeat_token: null,
    heartbeat_token_hash: null,
    sort_order: 0,
    created_at: 1,
    updated_at: 1,
  };
}

function envReturning(row: unknown): Env {
  return {
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return row;
          },
        };
      },
    },
  } as unknown as Env;
}

describe("stored public config", () => {
  it("drops the removed showScheduledOff setting from monitors saved before it went away", async () => {
    const env = envReturning(
      rowWithPublic(
        JSON.stringify({ visible: true, showUptime: false, showScheduledOff: false }),
      ),
    );
    const monitor = await getMonitor(env, "mon_1");
    expect(monitor?.public).toEqual({ visible: true, showUptime: false });
    expect(monitor?.public).not.toHaveProperty("showScheduledOff");
  });

  it("falls back to the defaults when the column is empty", async () => {
    const monitor = await getMonitor(envReturning(rowWithPublic(null)), "mon_1");
    expect(monitor?.public).toEqual({
      visible: false,
      sortOrder: 0,
      showUptime: true,
      showResponseTime: false,
      showIncidentDetails: true,
    });
  });
});
