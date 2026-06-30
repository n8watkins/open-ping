import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runHttpCheck, isSuspendedResponse } from "./http";
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

describe("isSuspendedResponse (Render free-tier suspension detector)", () => {
  it("detects a 503 with an x-render-routing: suspend header", () => {
    expect(
      isSuspendedResponse({ statusCode: 503, routingHeader: "suspend" }),
    ).toBe(true);
  });

  it("detects a 503 whose body is titled 'Service Suspended'", () => {
    expect(
      isSuspendedResponse({
        statusCode: 503,
        body: "<html><title>Service Suspended</title></html>",
      }),
    ).toBe(true);
  });

  it("does NOT flag a plain 503 with no suspend signature (stays down)", () => {
    expect(
      isSuspendedResponse({ statusCode: 503, body: "upstream unavailable" }),
    ).toBe(false);
    expect(isSuspendedResponse({ statusCode: 503 })).toBe(false);
  });

  it("does NOT flag the suspend signature on a non-503 status", () => {
    expect(
      isSuspendedResponse({ statusCode: 200, routingHeader: "suspend" }),
    ).toBe(false);
    expect(
      isSuspendedResponse({ statusCode: 200, body: "Service Suspended" }),
    ).toBe(false);
  });

  it("matches the routing header case-insensitively", () => {
    expect(
      isSuspendedResponse({ statusCode: 503, routingHeader: "Suspend" }),
    ).toBe(true);
  });
});

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

  it("flags a Render-suspended 503 (suspend header) as suspended", async () => {
    mockFetch(
      new Response("Service Suspended", {
        status: 503,
        headers: { "x-render-routing": "suspend" },
      }),
    );

    const result = await runHttpCheck(makeConfig());

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.suspended).toBe(true);
  });

  it("does NOT flag a plain 503 as suspended", async () => {
    mockFetch(new Response("temporarily unavailable", { status: 503 }));

    const result = await runHttpCheck(makeConfig());

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.suspended).toBeUndefined();
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

  /** Stub fetch to return each response in order, one per call. */
  function mockFetchSequence(...responses: Response[]): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn();
    for (const r of responses) fetchMock.mockResolvedValueOnce(r);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function redirectTo(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }

  it("follows a redirect to a safe URL and reads the final body", async () => {
    const fetchMock = mockFetchSequence(
      redirectTo("https://other.example.com/next"),
      new Response("final body", { status: 200 }),
    );

    const result = await runHttpCheck(makeConfig());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.redirected).toBe(true);
    expect(result.body).toBe("final body");
    expect(result.finalUrl).toContain("other.example.com");
  });

  it("blocks a redirect whose target is an SSRF-rejected address", async () => {
    const fetchMock = mockFetchSequence(
      redirectTo("http://169.254.169.254/latest/meta-data"),
      new Response("should never be fetched", { status: 200 }),
    );

    const result = await runHttpCheck(makeConfig());

    // The blocked target is never fetched — re-validation happens before the hop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("blocked_url");
  });

  it("gives up after too many redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirectTo("https://example.com/loop"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runHttpCheck(makeConfig());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("too_many_redirects");
  });

  it("does not follow redirects when followRedirects is false", async () => {
    const fetchMock = mockFetchSequence(redirectTo("https://other.example.com/next"));

    const result = await runHttpCheck(makeConfig({ followRedirects: false }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 302 is within the default expected 200-399 range, so the hop itself is "ok".
    expect(result.statusCode).toBe(302);
    expect(result.redirected).toBe(false);
  });

  it("drops the request body on a cross-origin 307 redirect", async () => {
    // 307/308 preserve the method and body, so a secret in the body would be
    // re-sent to the server-chosen cross-origin target unless we drop it.
    const fetchMock = mockFetchSequence(
      redirectTo("https://other.example.com/next", 307),
      new Response("final body", { status: 200 }),
    );

    await runHttpCheck(makeConfig({ method: "POST", body: "secret-payload" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstInit.body).toBe("secret-payload");
    expect(secondInit.method).toBe("POST"); // 307 keeps the method...
    expect(secondInit.body).toBeUndefined(); // ...but the body must not cross origins
  });

  it("preserves the request body on a same-origin 307 redirect", async () => {
    const fetchMock = mockFetchSequence(
      redirectTo("https://example.com/next", 307),
      new Response("final body", { status: 200 }),
    );

    await runHttpCheck(makeConfig({ method: "POST", body: "payload" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(secondInit.method).toBe("POST");
    expect(secondInit.body).toBe("payload");
  });
});
