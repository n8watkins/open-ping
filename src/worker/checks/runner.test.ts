import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HttpCheckResult } from "./http";
import type { MonitorRecord } from "../db/monitors";

vi.mock("./http", () => ({ runHttpCheck: vi.fn() }));
import { runHttpCheck } from "./http";
import { classifyCheck, runMonitorCheck } from "./runner";

const mockedRun = vi.mocked(runHttpCheck);

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
