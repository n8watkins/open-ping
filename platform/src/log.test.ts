import { afterEach, describe, expect, it } from "vitest";

import { captureLogs, errorText, log, logLine, type LogLine } from "./log";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("the platform's log lines", () => {
  it("are one flat object with the event and level first, so Workers Logs indexes every field", () => {
    expect(logLine("info", "schedule.batch", { runs: 3, errors: 0, tenant: "abc", ok: true })).toEqual({
      event: "schedule.batch",
      level: "info",
      runs: 3,
      errors: 0,
      tenant: "abc",
      ok: true,
    });
  });

  it("never write a field that looks like a secret, whatever a call site passes", () => {
    const line = logLine("error", "billing.checkout_failed", {
      apiKey: "sk_live_123",
      api_key: "re_123",
      token: "abc",
      leaseToken: "def",
      STRIPE_WEBHOOK_SECRET: "whsec_1",
      password: "p",
      cookie: "__Host-s=1",
      authorization: "Bearer x",
      MASTER_KEY: "k",
      key: "x",
      signingKey: "y",
      jwt: "z",
      privateKey: "q",
      emailKey: "payment_failed:in_1",
      account: "acc_1",
    });
    for (const name of ["apiKey", "api_key", "token", "leaseToken", "STRIPE_WEBHOOK_SECRET", "password", "cookie", "authorization", "MASTER_KEY", "key", "signingKey", "jwt", "privateKey"]) {
      expect(line[name]).toBe("[redacted]");
    }
    // Ids and the billing email's key are not secrets.
    expect(line.emailKey).toBe("payment_failed:in_1");
    expect(line.account).toBe("acc_1");
  });

  it("turn errors into their message, cut long text, flatten objects and keep lists short", () => {
    const line = logLine("error", "provision.step_failed", {
      error: new Error("D1 said\nno"),
      long: "x".repeat(1000),
      nested: { token: "secret-inside", n: 1 },
      list: Array.from({ length: 80 }, (_, i) => i),
      skipped: undefined,
      none: null,
    });
    expect(line.error).toBe("D1 said no");
    expect((line.long as string).length).toBe(300);
    expect(typeof line.nested).toBe("string");
    expect(line.list).toHaveLength(50);
    expect("skipped" in line).toBe(false);
    expect(line.none).toBeNull();
    expect(errorText("plain")).toBe("plain");
  });

  it("can't have their event or level overwritten, and keep an event name in the one format", () => {
    expect(logLine("warn", "mail.send_failed", { event: "x", level: "info" })).toEqual({ event: "mail.send_failed", level: "warn" });
    expect(logLine("info", "Not An Event").event).toBe("invalid.not_an_event");
  });

  it("go to the console method of their level", () => {
    const lines: LogLine[] = [];
    restore = captureLogs((l) => lines.push(l));
    log.info("cron.tick");
    log.warn("health.degraded", { problems: ["a"] });
    log.error("dispatch.tenant_threw", { tenant: "t" });
    expect(lines.map((l) => [l.event, l.level])).toEqual([
      ["cron.tick", "info"],
      ["health.degraded", "warn"],
      ["dispatch.tenant_threw", "error"],
    ]);
  });
});
