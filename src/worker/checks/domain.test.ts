import { describe, it, expect, vi, afterEach } from "vitest";
import { runDomainCheck } from "./domain";
import type { DomainConfig } from "../../shared/schemas";

/** Build a complete DomainConfig with sensible defaults, overridable per test. */
function makeConfig(overrides: Partial<DomainConfig> = {}): DomainConfig {
  return { domain: "example.com", warnDays: 30, timeoutMs: 15000, ...overrides };
}

/** ISO timestamp `days` from now (negative = in the past). */
function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** Build an RDAP JSON Response. */
function rdapResponse(
  events: Array<{ eventAction: string; eventDate: string }>,
  status = 200,
): Response {
  return new Response(JSON.stringify({ events }), { status });
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("runDomainCheck", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is up for a far-off expiry and reports meta fields", async () => {
    mockFetch(
      rdapResponse([{ eventAction: "expiration", eventDate: isoInDays(200) }]),
    );
    const r = await runDomainCheck(makeConfig({ warnDays: 30 }));
    expect(r.ok).toBe(true);
    expect(r.degraded).toBeFalsy();
    const meta = r.meta as { expiresAt: string; daysUntil: number };
    expect(meta.daysUntil).toBeGreaterThan(30);
    expect(typeof meta.expiresAt).toBe("string");
  });

  it("is degraded when the expiry is within warnDays", async () => {
    mockFetch(
      rdapResponse([{ eventAction: "expiration", eventDate: isoInDays(10) }]),
    );
    const r = await runDomainCheck(makeConfig({ warnDays: 30 }));
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect((r.meta as { daysUntil: number }).daysUntil).toBeLessThanOrEqual(30);
  });

  it("is down (domain_expired) for a past expiry", async () => {
    mockFetch(
      rdapResponse([{ eventAction: "expiration", eventDate: isoInDays(-5) }]),
    );
    const r = await runDomainCheck(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("domain_expired");
  });

  it("is down (rdap_no_expiry) when there is no expiration event", async () => {
    mockFetch(
      rdapResponse([{ eventAction: "registration", eventDate: isoInDays(-1000) }]),
    );
    const r = await runDomainCheck(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("rdap_no_expiry");
  });

  it("is down (rdap_error) on a non-2xx response", async () => {
    mockFetch(rdapResponse([], 404));
    const r = await runDomainCheck(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("rdap_error");
  });
});
