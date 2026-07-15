import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { sha256hex } from "../lib/ids";
import {
  getMonitorByHeartbeatToken,
  rotateHeartbeatToken,
} from "./monitors";

function heartbeatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "mon_heartbeat",
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
    public: JSON.stringify({ visible: false }),
    category_id: null,
    heartbeat_token: null,
    heartbeat_token_hash: null,
    sort_order: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("heartbeat ingestion token storage", () => {
  it("looks up new tokens by SHA-256 hash", async () => {
    const raw = "raw-ingestion-token";
    const expectedHash = await sha256hex(raw);
    const binds: unknown[][] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          expect(sql).toContain("heartbeat_token_hash = ?");
          return {
            bind(...values: unknown[]) {
              binds.push(values);
              return this;
            },
            async first() {
              return heartbeatRow({ heartbeat_token_hash: expectedHash });
            },
          };
        },
      },
    } as unknown as Env;

    const monitor = await getMonitorByHeartbeatToken(env, raw);

    expect(monitor?.id).toBe("mon_heartbeat");
    expect(monitor?.heartbeatToken).toBeNull();
    expect(binds).toEqual([[expectedHash]]);
  });

  it("accepts a legacy plaintext token and replaces it with its hash", async () => {
    const raw = "legacy-plaintext-token";
    const expectedHash = await sha256hex(raw);
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const legacyRow = heartbeatRow({ heartbeat_token: raw });
    const env = {
      DB: {
        prepare(sql: string) {
          const statement = { sql, values: [] as unknown[] };
          statements.push(statement);
          return {
            bind(...values: unknown[]) {
              statement.values = values;
              return this;
            },
            async first() {
              if (sql.includes("heartbeat_token_hash = ?")) return null;
              return legacyRow;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;

    const monitor = await getMonitorByHeartbeatToken(env, raw);

    expect(monitor?.id).toBe("mon_heartbeat");
    expect(monitor?.heartbeatToken).toBeNull();
    expect(statements[0]?.values).toEqual([expectedHash]);
    expect(statements[1]?.values).toEqual([raw]);
    expect(statements[2]?.sql).toContain("heartbeat_token = NULL");
    expect(statements[2]?.values[0]).toBe(expectedHash);
    expect(statements[2]?.values.slice(2)).toEqual(["mon_heartbeat", raw]);
  });

  it("stores only the replacement token hash during rotation", async () => {
    let values: unknown[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          expect(sql).toContain("heartbeat_token = NULL");
          return {
            bind(...bound: unknown[]) {
              values = bound;
              return this;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;

    const raw = await rotateHeartbeatToken(env, "mon_heartbeat");

    expect(raw).toBeTruthy();
    expect(values[0]).toBe(await sha256hex(raw!));
    expect(values).not.toContain(raw);
    expect(values[2]).toBe("mon_heartbeat");
  });
});
