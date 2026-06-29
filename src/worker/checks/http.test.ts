import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runHttpCheck } from "./http";
import type { HttpConfig } from "../../shared/schemas";

/** Build a complete HttpConfig with sensible defaults, overridable per test. */
function makeConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    url: "https://example.com/health",
    method: "GET",
    headers: [],
    auth: { type: "none" },
    timeoutMs: 60000,
    warmupTimeoutMs: 120000,
    followRedirects: true,
    expectedStatus: { min: 200, max: 399 },
    ...overrides,
  };
}

function mockFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const fetchMock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("runHttpCheck", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("treats a 200 within the expected range as ok and captures the body", async () => {
    mockFetch(new Response("hello body", { status: 200 }));

    const result = await runHttpCheck(makeConfig());

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("hello body");
    expect(result.error).toBeUndefined();
    expect(result.degraded).toBeUndefined();
  });

  it("fails a 500 as status_out_of_range", async () => {
    mockFetch(new Response("boom", { status: 500 }));

    const result = await runHttpCheck(makeConfig());

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toBe("status_out_of_range");
  });

  it("classifies an AbortError as a timeout", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    mockFetch(abortErr);

    const result = await runHttpCheck(makeConfig());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
    expect(result.statusCode).toBeUndefined();
  });

  it("classifies a DNS-looking network failure as dns_error", async () => {
    mockFetch(new Error("getaddrinfo ENOTFOUND no-such-host.invalid"));

    const result = await runHttpCheck(makeConfig());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("dns_error");
    expect(result.errorMessage).toContain("ENOTFOUND");
  });

  it("falls back to network_error for unrecognized fetch failures", async () => {
    mockFetch(new Error("connection reset"));

    const result = await runHttpCheck(makeConfig());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("network_error");
  });

  it("fails a slow-but-successful response as response_too_slow", async () => {
    // Deterministic duration: 1500 - 1000 = 500ms.
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1500);
    mockFetch(new Response("ok", { status: 200 }));

    const result = await runHttpCheck(makeConfig({ failResponseMs: 100 }));

    expect(result.durationMs).toBe(500);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("response_too_slow");
  });

  it("marks a slow-but-acceptable response as degraded", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1500);
    mockFetch(new Response("ok", { status: 200 }));

    const result = await runHttpCheck(makeConfig({ degradedResponseMs: 100 }));

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.durationMs).toBe(500);
    expect(result.error).toBeUndefined();
  });

  it("sends a bearer Authorization header", async () => {
    const fetchMock = mockFetch(new Response("ok", { status: 200 }));

    await runHttpCheck(
      makeConfig({ auth: { type: "bearer", token: "secret-token" } }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("sends a basic Authorization header derived from credentials", async () => {
    const fetchMock = mockFetch(new Response("ok", { status: 200 }));

    await runHttpCheck(
      makeConfig({
        auth: { type: "basic", username: "alice", password: "pw" },
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    const expected = `Basic ${btoa("alice:pw")}`;
    expect(headers.get("authorization")).toBe(expected);
  });

  it("does not send a body for GET requests", async () => {
    const fetchMock = mockFetch(new Response("ok", { status: 200 }));

    await runHttpCheck(makeConfig({ method: "GET", body: "should-be-dropped" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it("sends a body for POST requests", async () => {
    const fetchMock = mockFetch(new Response("ok", { status: 200 }));

    await runHttpCheck(makeConfig({ method: "POST", body: "payload" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe("payload");
  });

  it("uses the warmup timeout when opts.warmup is set", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    mockFetch(abortErr);

    const result = await runHttpCheck(
      makeConfig({ warmupTimeoutMs: 5000 }),
      { warmup: true },
    );

    expect(result.error).toBe("timeout");
    expect(result.errorMessage).toContain("5000ms");
  });
});
