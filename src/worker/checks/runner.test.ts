import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HttpCheckResult } from "./http";
import type { MonitorRecord } from "../db/monitors";

vi.mock("./http", () => ({ runHttpCheck: vi.fn() }));
vi.mock("./dns", () => ({ runDnsCheck: vi.fn() }));
vi.mock("./tcp", () => ({ runTcpCheck: vi.fn() }));
vi.mock("./domain", () => ({ runDomainCheck: vi.fn() }));
import { runHttpCheck } from "./http";
import { runDnsCheck } from "./dns";
import { runTcpCheck } from "./tcp";
import { runDomainCheck } from "./domain";
import { classifyCheck, runMonitorCheck } from "./runner";

const mockedRun = vi.mocked(runHttpCheck);
const mockedDns = vi.mocked(runDnsCheck);
const mockedTcp = vi.mocked(runTcpCheck);
const mockedDomain = vi.mocked(runDomainCheck);

function result(over: Partial<HttpCheckResult> = {}): HttpCheckResult {
  return { ok: true, durationMs: 100, statusCode: 200, ...over };
}

describe("classifyCheck", () => {
  it("first-attempt success -> up", () => {
    const o = classifyCheck({ result: result(), ok: true, succeededAttempt: 1, maxAttempts: 2, warmup: false });
    expect(o.state).toBe("up");
    expect(o.attempts).toBe(1);
    expect(o.retryRecovered).toBe(false);
  });

  it("success after retry -> retryRecovered", () => {
    const o = classifyCheck({ result: result(), ok: true, succeededAttempt: 2, maxAttempts: 2, warmup: false });
    expect(o.state).toBe("up");
    expect(o.retryRecovered).toBe(true);
    expect(o.attempts).toBe(2);
  });

  it("slow success -> degraded", () => {
    const o = classifyCheck({ result: result({ degraded: true }), ok: true, succeededAttempt: 1, maxAttempts: 2, warmup: false });
    expect(o.state).toBe("degraded");
  });

  it("all attempts fail -> down with error code", () => {
    const o = classifyCheck({
      result: result({ ok: false, error: "timeout" }),
      ok: false,
      succeededAttempt: -1,
      maxAttempts: 2,
      warmup: false,
    });
    expect(o.state).toBe("down");
    expect(o.attempts).toBe(2);
    expect(o.error).toBe("timeout");
  });

  it("assertion failure -> down with assertion_failed", () => {
    const o = classifyCheck({
      result: result(),
      ok: false,
      succeededAttempt: -1,
      maxAttempts: 2,
      warmup: false,
      assertionFailures: ["expected to contain 'ok'"],
    });
    expect(o.state).toBe("down");
    expect(o.error).toBe("assertion_failed");
    expect(o.assertionFailures).toEqual(["expected to contain 'ok'"]);
  });

  it("a Render-suspended response -> suspended with reason 'suspended'", () => {
    const o = classifyCheck({
      result: result({ ok: false, statusCode: 503, error: "status_out_of_range", suspended: true }),
      ok: false,
      succeededAttempt: -1,
      maxAttempts: 2,
      warmup: false,
    });
    expect(o.state).toBe("suspended");
    expect(o.error).toBe("suspended");
    expect(o.ok).toBe(false);
  });

  it("a suspended response during warm-up is still suspended (definitive, no grace)", () => {
    const o = classifyCheck({
      result: result({ ok: false, statusCode: 503, suspended: true }),
      ok: false,
      succeededAttempt: -1,
      maxAttempts: 2,
      warmup: true,
    });
    expect(o.state).toBe("suspended");
  });

  it("a failed WARM-UP cycle is warming_up, not down (one grace cycle)", () => {
    const o = classifyCheck({
      result: result({ ok: false, error: "timeout" }),
      ok: false,
      succeededAttempt: -1,
      maxAttempts: 2,
      warmup: true,
    });
    expect(o.state).toBe("warming_up");
    // It is still not "ok", so it won't be counted as a success either.
    expect(o.ok).toBe(false);
  });

  it("a non-warm-up failure is still down", () => {
    const o = classifyCheck({
      result: result({ ok: false, error: "timeout" }),
      ok: false,
      succeededAttempt: -1,
      maxAttempts: 2,
      warmup: false,
    });
    expect(o.state).toBe("down");
  });
});

describe("runMonitorCheck", () => {
  beforeEach(() => mockedRun.mockReset());

  const monitor = {
    id: "mon_1",
    type: "http",
    config: { url: "https://x.test" },
    assertions: [],
    intervalSeconds: 720,
    schedule: { mode: "always" },
  } as unknown as MonitorRecord;

  it("retries once then succeeds", async () => {
    mockedRun
      .mockResolvedValueOnce(result({ ok: false, error: "network_error" }))
      .mockResolvedValueOnce(result({ ok: true }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const o = await runMonitorCheck(monitor, { sleep, now: 1000 });
    expect(o.ok).toBe(true);
    expect(o.state).toBe("up");
    expect(o.retryRecovered).toBe(true);
    expect(o.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(o.at).toBe(1000);
  });

  it("does not retry a blocked_url (permanent failure)", async () => {
    mockedRun.mockResolvedValue(result({ ok: false, error: "blocked_url" }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const o = await runMonitorCheck(monitor, { sleep, now: 3000 });
    expect(o.ok).toBe(false);
    expect(o.error).toBe("blocked_url");
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails after exhausting attempts", async () => {
    mockedRun.mockResolvedValue(result({ ok: false, error: "timeout" }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const o = await runMonitorCheck(monitor, { sleep, now: 2000 });
    expect(o.ok).toBe(false);
    expect(o.state).toBe("down");
    expect(o.error).toBe("timeout");
    expect(mockedRun).toHaveBeenCalledTimes(2);
  });
});

describe("runMonitorCheck dispatch by type", () => {
  beforeEach(() => {
    mockedRun.mockReset();
    mockedDns.mockReset();
    mockedTcp.mockReset();
    mockedDomain.mockReset();
  });

  const monitorOf = (type: string, config: unknown): MonitorRecord =>
    ({
      id: "mon_x",
      type,
      config,
      assertions: [],
      intervalSeconds: 720,
      schedule: { mode: "always" },
    }) as unknown as MonitorRecord;

  it("dispatches DNS checks and threads meta into the outcome", async () => {
    mockedDns.mockResolvedValue({
      ok: true,
      durationMs: 12,
      meta: { records: ["1.2.3.4"] },
    });
    const o = await runMonitorCheck(
      monitorOf("dns", { hostname: "x.test", recordType: "A" }),
      { now: 1000 },
    );
    expect(mockedDns).toHaveBeenCalledOnce();
    expect(mockedRun).not.toHaveBeenCalled();
    expect(o.state).toBe("up");
    expect(o.meta).toEqual({ records: ["1.2.3.4"] });
  });

  it("dispatches TCP checks and does not retry a blocked_host", async () => {
    mockedTcp.mockResolvedValue({ ok: false, durationMs: 0, error: "blocked_host" });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const o = await runMonitorCheck(monitorOf("tcp", { host: "x.test", port: 80 }), {
      sleep,
      now: 2000,
    });
    expect(o.ok).toBe(false);
    expect(o.error).toBe("blocked_host");
    expect(mockedTcp).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("dispatches domain checks and threads a degraded result", async () => {
    mockedDomain.mockResolvedValue({
      ok: true,
      durationMs: 5,
      degraded: true,
      meta: { daysUntil: 10 },
    });
    const o = await runMonitorCheck(monitorOf("domain", { domain: "x.test" }), {
      now: 3000,
    });
    expect(mockedDomain).toHaveBeenCalledOnce();
    expect(o.state).toBe("degraded");
    expect(o.meta).toEqual({ daysUntil: 10 });
  });

  it("throws for a heartbeat monitor (push-driven, never routed here)", async () => {
    await expect(
      runMonitorCheck(monitorOf("heartbeat", {}), { now: 4000 }),
    ).rejects.toThrow();
  });
});
