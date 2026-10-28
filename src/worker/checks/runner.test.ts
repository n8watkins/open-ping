import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HttpCheckResult } from "./http";
import type { MonitorRecord } from "../db/monitors";

vi.mock("./http", () => ({ runHttpCheck: vi.fn(), MAX_REDIRECTS: 5 }));
vi.mock("./dns", () => ({ runDnsCheck: vi.fn() }));
vi.mock("./tcp", () => ({ runTcpCheck: vi.fn() }));
vi.mock("./domain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./domain")>()),
  runDomainCheck: vi.fn(),
}));
import { runHttpCheck } from "./http";
import { runDnsCheck } from "./dns";
import { runTcpCheck } from "./tcp";
import { runDomainCheck } from "./domain";
import { classifyCheck, CONFIRM_DELAY_MS, probeFetchLimit, runMonitorCheck } from "./runner";

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

describe("runMonitorCheck confirmation before alerting", () => {
  beforeEach(() => mockedRun.mockReset());

  const monitor = {
    id: "mon_1",
    type: "http",
    config: { url: "https://x.test" },
    assertions: [],
    intervalSeconds: 720,
    schedule: { mode: "always" },
  } as unknown as MonitorRecord;

  it("a passing first check makes no re-check", async () => {
    mockedRun.mockResolvedValue(result());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const o = await runMonitorCheck(monitor, { sleep, now: 1 });
    expect(o.state).toBe("up");
    expect(o.confirmation).toBeUndefined();
    expect(mockedRun).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fail then fail: confirmed down, the re-check bypasses the cache after the pause", async () => {
    mockedRun
      .mockResolvedValueOnce(result({ ok: false, statusCode: 502, error: "status_out_of_range" }))
      .mockResolvedValueOnce(result({ ok: false, statusCode: 503, error: "status_out_of_range" }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const o = await runMonitorCheck(monitor, { sleep, now: 1 });
    expect(o.state).toBe("down");
    expect(o.confirmation).toBe("confirmed");
    expect(o.attempts).toBe(2);
    // The outcome reports the second (deciding) check.
    expect(o.statusCode).toBe(503);
    expect(sleep).toHaveBeenCalledWith(CONFIRM_DELAY_MS);
    expect(mockedRun.mock.calls[0]?.[1]).not.toHaveProperty("noStore");
    expect(mockedRun.mock.calls[1]?.[1]).toMatchObject({ noStore: true });
  });

  it("fail then pass: cleared, up, flagged as a blip", async () => {
    mockedRun
      .mockResolvedValueOnce(result({ ok: false, error: "network_error" }))
      .mockResolvedValueOnce(result({ ok: true, durationMs: 80 }));
    const o = await runMonitorCheck(monitor, { sleep: async () => {}, now: 1 });
    expect(o.ok).toBe(true);
    expect(o.state).toBe("up");
    expect(o.confirmation).toBe("cleared");
    expect(o.retryRecovered).toBe(true);
    expect(o.durationMs).toBe(80);
  });

  it("an assertion failure is re-checked too", async () => {
    const withAssertion = {
      ...monitor,
      assertions: [{ kind: "contains", value: "ok", caseSensitive: false }],
    } as unknown as MonitorRecord;
    mockedRun
      .mockResolvedValueOnce(result({ body: "maintenance" }))
      .mockResolvedValueOnce(result({ body: "all ok" }));
    const o = await runMonitorCheck(withAssertion, { sleep: async () => {}, now: 1 });
    expect(o.confirmation).toBe("cleared");
    expect(o.state).toBe("up");
  });

  it("confirm off: one check, and a failure is down at once", async () => {
    mockedRun.mockResolvedValue(result({ ok: false, error: "timeout" }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const o = await runMonitorCheck(monitor, { confirm: false, sleep, now: 1 });
    expect(o.state).toBe("down");
    expect(o.confirmation).toBeUndefined();
    expect(o.attempts).toBe(1);
    expect(mockedRun).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("no budget for the re-check: deferred, without waiting or re-checking", async () => {
    mockedRun.mockResolvedValue(result({ ok: false, error: "timeout" }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const allowConfirm = vi.fn(() => false);
    const o = await runMonitorCheck(monitor, { allowConfirm, sleep, now: 1 });
    expect(o.confirmation).toBe("deferred");
    expect(allowConfirm).toHaveBeenCalledOnce();
    expect(mockedRun).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("asks for budget only when a re-check is needed", async () => {
    mockedRun.mockResolvedValue(result());
    const allowConfirm = vi.fn(() => true);
    await runMonitorCheck(monitor, { allowConfirm, now: 1 });
    expect(allowConfirm).not.toHaveBeenCalled();
  });

  it("reports every fetch the cycle made, redirect hops included", async () => {
    mockedRun
      .mockResolvedValueOnce(result({ ok: false, error: "timeout", fetches: 4 }))
      .mockResolvedValueOnce(result({ ok: false, error: "timeout", fetches: 6 }));
    const o = await runMonitorCheck(monitor, { sleep: async () => {}, now: 1 });
    expect(o.fetches).toBe(10);
  });

  it("charges a probe that didn't count its fetches its worst case", async () => {
    const redirecting = { ...monitor, config: { url: "https://x.test", followRedirects: true } } as MonitorRecord;
    mockedRun.mockResolvedValue(result());
    const o = await runMonitorCheck(redirecting, { now: 1 });
    expect(o.fetches).toBe(probeFetchLimit(redirecting));
  });
});

describe("probeFetchLimit", () => {
  it("holds room for every redirect an HTTP check may follow", () => {
    const http = (followRedirects: boolean) =>
      ({ type: "http", config: { url: "https://x.test", followRedirects } }) as unknown as MonitorRecord;
    expect(probeFetchLimit(http(true))).toBe(6);
    expect(probeFetchLimit(http(false))).toBe(1);
  });

  it("counts the RDAP redirect for a domain check, and one fetch for dns and tcp", () => {
    const of = (type: string) => ({ type, config: {} }) as unknown as MonitorRecord;
    expect(probeFetchLimit(of("domain"))).toBe(2);
    expect(probeFetchLimit(of("dns"))).toBe(1);
    expect(probeFetchLimit(of("tcp"))).toBe(1);
  });

  it("reserves nothing for a domain cycle judged from a fresh cached read", () => {
    const now = Date.UTC(2026, 9, 28);
    const domain = { type: "domain", config: { domain: "x.test", warnDays: 30 } } as unknown as MonitorRecord;
    const cache = { domain: "x.test", expiresAt: now + 200 * 86_400_000, checkedAt: now - 60_000 };
    expect(probeFetchLimit(domain, { cache, now })).toBe(0);
    expect(probeFetchLimit(domain, { cache: { ...cache, checkedAt: now - 7 * 3_600_000 }, now })).toBe(2);
    expect(probeFetchLimit(domain, { cache: null, now })).toBe(2);
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

  it("passes the domain cache, plan time, force and pacing through, and returns the new read", async () => {
    const cache = { domain: "x.test", expiresAt: 5_000, checkedAt: 1_000 };
    const fresh = { domain: "x.test", expiresAt: 9_000, checkedAt: 3_000 };
    mockedDomain.mockResolvedValue({ ok: true, durationMs: 5, domainCache: fresh });
    const paceLookup = vi.fn().mockResolvedValue(undefined);
    const o = await runMonitorCheck(monitorOf("domain", { domain: "x.test" }), {
      domainCache: cache,
      plannedAt: 2_500,
      refreshDomain: true,
      paceLookup,
      now: 3_000,
    });
    expect(mockedDomain).toHaveBeenCalledWith(
      { domain: "x.test" },
      { cache, now: 2_500, force: true, pace: paceLookup },
    );
    expect(o.domainCache).toEqual(fresh);
  });

  it("does not re-check a domain result that can't change (recheck: skip)", async () => {
    mockedDomain.mockResolvedValue({ ok: false, error: "domain_expired", recheck: "skip" });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const o = await runMonitorCheck(monitorOf("domain", { domain: "x.test" }), { sleep, now: 1 });
    expect(o).toMatchObject({ state: "down", error: "domain_expired", attempts: 1 });
    expect(o.confirmation).toBeUndefined();
    expect(mockedDomain).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("defers the confirmation of a rate-limited lookup without a second request or a budget ask", async () => {
    mockedDomain.mockResolvedValue({ ok: false, error: "rdap_rate_limited", recheck: "defer" });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const allowConfirm = vi.fn(() => true);
    const o = await runMonitorCheck(monitorOf("domain", { domain: "x.test" }), { sleep, allowConfirm, now: 1 });
    expect(o.confirmation).toBe("deferred");
    expect(mockedDomain).toHaveBeenCalledOnce();
    expect(allowConfirm).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("a rate-limited lookup with confirmation off simply fails", async () => {
    mockedDomain.mockResolvedValue({ ok: false, error: "rdap_rate_limited", recheck: "defer" });
    const o = await runMonitorCheck(monitorOf("domain", { domain: "x.test" }), { confirm: false, now: 1 });
    expect(o).toMatchObject({ state: "down", error: "rdap_rate_limited" });
    expect(o.confirmation).toBeUndefined();
  });

  it("throws for a heartbeat monitor (push-driven, never routed here)", async () => {
    await expect(
      runMonitorCheck(monitorOf("heartbeat", {}), { now: 4000 }),
    ).rejects.toThrow();
  });
});

describe("runMonitorCheck re-check from another region", () => {
  beforeEach(() => mockedRun.mockReset());

  const monitor = {
    id: "mon_1",
    type: "http",
    config: { url: "https://x.test" },
    assertions: [],
    intervalSeconds: 720,
    schedule: { mode: "always" },
  } as unknown as MonitorRecord;
  const failed = (statusCode = 502) =>
    ({ result: result({ ok: false, statusCode, error: "status_out_of_range" }), ok: false }) as const;

  it("a remote failure confirms the incident and records where it ran", async () => {
    mockedRun.mockResolvedValueOnce(result({ ok: false, error: "timeout", fetches: 1 }));
    const remoteRecheck = vi.fn().mockResolvedValue({ attempt: failed(503), colo: "FRA", fetches: 3 });
    const o = await runMonitorCheck(monitor, { remoteRecheck, sleep: async () => {}, now: 1 });
    expect(o.state).toBe("down");
    expect(o.confirmation).toBe("confirmed");
    expect(o.confirmedFrom).toBe("FRA");
    expect(o.statusCode).toBe(503);
    expect(o.attempts).toBe(2);
    // The first probe here, the remote one charged what it reported.
    expect(o.fetches).toBe(4);
    expect(mockedRun).toHaveBeenCalledOnce();
    expect(remoteRecheck).toHaveBeenCalledWith(monitor, { warmup: false });
  });

  it("a remote pass clears it: a blip where the first check ran", async () => {
    mockedRun.mockResolvedValueOnce(result({ ok: false, error: "network_error" }));
    const remoteRecheck = vi.fn().mockResolvedValue({
      attempt: { result: result({ durationMs: 90 }), ok: true },
      colo: "IAD",
      fetches: 2,
    });
    const o = await runMonitorCheck(monitor, { remoteRecheck, sleep: async () => {}, now: 1 });
    expect(o.state).toBe("up");
    expect(o.confirmation).toBe("cleared");
    expect(o.retryRecovered).toBe(true);
    expect(o.confirmedFrom).toBe("IAD");
  });

  it("a remote re-check without a known location records none", async () => {
    mockedRun.mockResolvedValueOnce(result({ ok: false, error: "timeout" }));
    const remoteRecheck = vi.fn().mockResolvedValue({ attempt: failed(), fetches: 2 });
    const o = await runMonitorCheck(monitor, { remoteRecheck, sleep: async () => {}, now: 1 });
    expect(o.confirmation).toBe("confirmed");
    expect(o).not.toHaveProperty("confirmedFrom");
  });

  it("a remote re-check that couldn't run falls back to a re-check here", async () => {
    mockedRun
      .mockResolvedValueOnce(result({ ok: false, error: "timeout", fetches: 1 }))
      .mockResolvedValueOnce(result({ ok: false, statusCode: 500, error: "status_out_of_range", fetches: 1 }));
    const remoteRecheck = vi.fn().mockResolvedValue({ attempt: null, fetches: 4 });
    const allowConfirm = vi.fn(() => true);
    const o = await runMonitorCheck(monitor, { remoteRecheck, allowConfirm, sleep: async () => {}, now: 1 });
    expect(o.confirmation).toBe("confirmed");
    expect(o).not.toHaveProperty("confirmedFrom");
    expect(o.statusCode).toBe(500);
    expect(mockedRun).toHaveBeenCalledTimes(2);
    expect(mockedRun.mock.calls[1]?.[1]).toMatchObject({ noStore: true });
    // Once for the remote re-check, once more for the one here.
    expect(allowConfirm).toHaveBeenCalledTimes(2);
    expect(o.fetches).toBe(6);
  });

  it("no room left for the fallback: deferred, charged for the failed hop", async () => {
    mockedRun.mockResolvedValueOnce(result({ ok: false, error: "timeout", fetches: 1 }));
    const remoteRecheck = vi.fn().mockResolvedValue({ attempt: null, fetches: 4 });
    const allowConfirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const o = await runMonitorCheck(monitor, { remoteRecheck, allowConfirm, sleep: async () => {}, now: 1 });
    expect(o.confirmation).toBe("deferred");
    expect(mockedRun).toHaveBeenCalledOnce();
    expect(o.fetches).toBe(5);
  });

  it("no budget for any re-check: deferred before the hop", async () => {
    mockedRun.mockResolvedValueOnce(result({ ok: false, error: "timeout" }));
    const remoteRecheck = vi.fn();
    const o = await runMonitorCheck(monitor, { remoteRecheck, allowConfirm: () => false, sleep: async () => {}, now: 1 });
    expect(o.confirmation).toBe("deferred");
    expect(remoteRecheck).not.toHaveBeenCalled();
  });

  it("a passing first check never leaves", async () => {
    mockedRun.mockResolvedValueOnce(result());
    const remoteRecheck = vi.fn();
    const o = await runMonitorCheck(monitor, { remoteRecheck, now: 1 });
    expect(o.state).toBe("up");
    expect(remoteRecheck).not.toHaveBeenCalled();
  });
});
