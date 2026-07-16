import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { generateMasterKey } from "../lib/crypto";
import { getChannel } from "./channels";

function channelRow(config: string) {
  return {
    id: "ch_legacy",
    type: "webhook",
    name: "Legacy webhook",
    enabled: 1,
    config,
    events: null,
    last_success_at: null,
    last_failure_at: null,
    last_error: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("notification channel secret storage", () => {
  it("does not overwrite a concurrent edit during plaintext upgrade", async () => {
    const legacyConfig = '{ "url": "https://old.example.test/hook", "secret": "old" }';
    const concurrentConfig = JSON.stringify({
      url: "v1:concurrent:url",
      secret: "v1:concurrent:secret",
    });
    let storedConfig = legacyConfig;
    let upgradeSql = "";
    let upgradeValues: unknown[] = [];
    const env = {
      MASTER_KEY: generateMasterKey(),
      DB: {
        prepare(sql: string) {
          if (sql.startsWith("SELECT")) {
            return {
              bind() {
                return this;
              },
              async first() {
                return channelRow(storedConfig);
              },
            };
          }
          upgradeSql = sql;
          return {
            bind(...values: unknown[]) {
              upgradeValues = values;
              storedConfig = concurrentConfig;
              return this;
            },
            async run() {
              const [replacement, , id, expectedConfig] = upgradeValues;
              if (id === "ch_legacy" && expectedConfig === storedConfig) {
                storedConfig = replacement as string;
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      },
    } as unknown as Env;

    const channel = await getChannel(env, "ch_legacy");

    expect(channel?.config).toEqual({
      url: "https://old.example.test/hook",
      secret: "old",
    });
    expect(upgradeSql).toContain("WHERE id = ? AND config = ?");
    expect(upgradeValues[3]).toBe(legacyConfig);
    expect(storedConfig).toBe(concurrentConfig);
  });
});
