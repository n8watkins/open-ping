import { describe, it, expect, vi, afterEach } from "vitest";
import { runDnsCheck } from "./dns";
import type { DnsConfig } from "../../shared/schemas";

/** Build a complete DnsConfig with sensible defaults, overridable per test. */
function makeConfig(overrides: Partial<DnsConfig> = {}): DnsConfig {
  return {
    hostname: "example.com",
    recordType: "A",
    timeoutMs: 10000,
    ...overrides,
  };
}

/** Build a DoH JSON Response. */
function dohResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/dns-json" },
  });
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// DoH numeric record types.
const A = 1;
const TXT = 16;

describe("runDnsCheck", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is up on Status:0 with matching answers and populates meta.records", async () => {
    mockFetch(
      dohResponse({
        Status: 0,
        Answer: [
          { name: "example.com", type: A, data: "93.184.216.34" },
          { name: "example.com", type: A, data: "93.184.216.35" },
        ],
      }),
    );
    const r = await runDnsCheck(makeConfig());
    expect(r.ok).toBe(true);
    expect((r.meta as { records: string[] }).records).toEqual([
      "93.184.216.34",
      "93.184.216.35",
    ]);
  });

  it("is down on NXDOMAIN (Status != 0)", async () => {
    mockFetch(dohResponse({ Status: 3 }));
    const r = await runDnsCheck(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("dns_nxdomain");
  });

  it("is down when there are no records of the requested type", async () => {
    // Status 0 but the only answer is a CNAME (type 5), not an A (type 1).
    mockFetch(
      dohResponse({
        Status: 0,
        Answer: [{ name: "example.com", type: 5, data: "other.example.com." }],
      }),
    );
    const r = await runDnsCheck(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("dns_no_records");
  });

  it("passes an expected 'equals' assertion that matches", async () => {
    mockFetch(
      dohResponse({ Status: 0, Answer: [{ name: "x", type: A, data: "1.2.3.4" }] }),
    );
    const r = await runDnsCheck(
      makeConfig({ expected: { mode: "equals", value: "1.2.3.4" } }),
    );
    expect(r.ok).toBe(true);
  });

  it("fails an expected 'equals' assertion that does not match", async () => {
    mockFetch(
      dohResponse({ Status: 0, Answer: [{ name: "x", type: A, data: "1.2.3.4" }] }),
    );
    const r = await runDnsCheck(
      makeConfig({ expected: { mode: "equals", value: "9.9.9.9" } }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("dns_mismatch");
  });

  it("passes an expected 'contains' assertion against a (quote-stripped) TXT record", async () => {
    mockFetch(
      dohResponse({
        Status: 0,
        Answer: [
          { name: "x", type: TXT, data: '"v=spf1 include:_spf.example.com ~all"' },
        ],
      }),
    );
    const r = await runDnsCheck(
      makeConfig({
        recordType: "TXT",
        expected: { mode: "contains", value: "v=spf1" },
      }),
    );
    expect(r.ok).toBe(true);
    expect((r.meta as { records: string[] }).records[0]).toBe(
      "v=spf1 include:_spf.example.com ~all",
    );
  });

  it("is down (dns_timeout) when the query is aborted", async () => {
    // Mock fetch to reject only when the AbortController fires.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
      ),
    );
    const r = await runDnsCheck(makeConfig({ timeoutMs: 20 }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("dns_timeout");
  });
});
