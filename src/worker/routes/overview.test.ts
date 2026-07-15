import { describe, expect, it } from "vitest";
import type { MonitorRecord } from "../db/monitors";
import { monitorTarget } from "./overview";

function targetFor(
  type: MonitorRecord["type"],
  config: Record<string, unknown>,
): string | null {
  return monitorTarget({ type, config } as MonitorRecord);
}

describe("monitorTarget", () => {
  it("keeps an HTTP host and path while removing embedded secrets", () => {
    expect(
      targetFor("http", {
        url: "https://user:password@example.com:8443/health?token=secret#debug",
      }),
    ).toBe("https://example.com:8443/health");
  });

  it("formats targets for non-HTTP monitor types", () => {
    expect(targetFor("dns", { hostname: "api.example.com" })).toBe(
      "api.example.com",
    );
    expect(targetFor("tcp", { host: "db.example.com", port: 5432 })).toBe(
      "db.example.com:5432",
    );
    expect(targetFor("domain", { domain: "example.com" })).toBe("example.com");
    expect(targetFor("heartbeat", {})).toBeNull();
  });
});
