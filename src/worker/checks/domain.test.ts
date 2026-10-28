import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DOMAIN_MAX_RETRY_AFTER_MS,
  DOMAIN_REFRESH_MS,
  DOMAIN_REFRESH_SOON_MS,
  DOMAIN_RETRY_MS,
  DOMAIN_STALE_LIMIT_MS,
  evaluateExpiry,
  parseDomainCache,
  parseRetryAfter,
  planDomainCheck,
  runDomainCheck,
  type DomainCache,
  type DomainMeta,
} from "./domain";
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
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ events }), { status, headers });
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

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 28, 12);

/** A cached read of example.com: expiring `days` after NOW, read `ageMs` before it. */
function cacheOf(days: number, ageMs: number, over: Partial<DomainCache> = {}): DomainCache {
  return { domain: "example.com", expiresAt: NOW + days * DAY, checkedAt: NOW - ageMs, ...over };
}

describe("planDomainCheck", () => {
  const cfg = makeConfig({ warnDays: 30 });

  it("looks up when there is no cached read", () => {
    expect(planDomainCheck(cfg, null, NOW)).toEqual({ lookup: true, fallback: null });
  });

  it("judges a read younger than the refresh age from the cache", () => {
    const cache = cacheOf(200, DOMAIN_REFRESH_MS - 1);
    expect(planDomainCheck(cfg, cache, NOW)).toEqual({ lookup: false, cache });
  });

  it("refreshes an older read, keeping it as the fallback", () => {
    const cache = cacheOf(200, DOMAIN_REFRESH_MS);
    expect(planDomainCheck(cfg, cache, NOW)).toEqual({ lookup: true, fallback: cache });
  });

  it("refreshes hourly while the domain is within warnDays", () => {
    expect(planDomainCheck(cfg, cacheOf(20, DOMAIN_REFRESH_SOON_MS - 1), NOW).lookup).toBe(false);
    expect(planDomainCheck(cfg, cacheOf(20, DOMAIN_REFRESH_SOON_MS), NOW).lookup).toBe(true);
  });

  it("refreshes at once when the cached date passes, even while holding off after a failure", () => {
    // Read 10 minutes ago, expired 1 minute ago; a refresh failed before that.
    const cache = cacheOf(-60_000 / DAY, 10 * 60_000, {
      retryAt: NOW + HOUR,
      lastError: { code: "rdap_error", at: NOW - 5 * 60_000 },
    });
    expect(planDomainCheck(cfg, cache, NOW)).toEqual({ lookup: true, fallback: cache });
    // A refresh since the date passed failed too: hold off as usual.
    const tried = { ...cache, lastError: { code: "rdap_error", at: NOW - 30_000 } };
    expect(planDomainCheck(cfg, tried, NOW)).toEqual({ lookup: false, cache: tried });
  });

  it("holds off a refresh until retryAt, judging the cache meanwhile", () => {
    const cache = cacheOf(200, DOMAIN_REFRESH_MS + HOUR, { retryAt: NOW + 1 });
    expect(planDomainCheck(cfg, cache, NOW)).toEqual({ lookup: false, cache });
    expect(planDomainCheck(cfg, cache, NOW + 1).lookup).toBe(true);
  });

  it("ignores a read for another domain (the config changed)", () => {
    const cache = cacheOf(200, 1, { domain: "other.com" });
    expect(planDomainCheck(cfg, cache, NOW)).toEqual({ lookup: true, fallback: null });
  });

  it("matches the domain case-insensitively", () => {
    const cache = cacheOf(200, 1);
    expect(planDomainCheck(makeConfig({ domain: "Example.COM" }), cache, NOW).lookup).toBe(false);
  });

  it("drops a read older than the stale limit, even while holding off", () => {
    const cache = cacheOf(200, DOMAIN_STALE_LIMIT_MS, { retryAt: NOW + HOUR });
    expect(planDomainCheck(cfg, cache, NOW)).toEqual({ lookup: true, fallback: null });
  });

  it("always looks up when forced, with the cache as fallback", () => {
    const cache = cacheOf(200, 1);
    expect(planDomainCheck(cfg, cache, NOW, true)).toEqual({ lookup: true, fallback: cache });
  });
});

describe("evaluateExpiry", () => {
  const cfg = makeConfig({ warnDays: 30 });
  it("is up, degraded or down by days left", () => {
    expect(evaluateExpiry(cfg, NOW + 31 * DAY, NOW)).toMatchObject({ ok: true, meta: { daysUntil: 31 } });
    expect(evaluateExpiry(cfg, NOW + 30 * DAY, NOW)).toMatchObject({ ok: true, degraded: true });
    expect(evaluateExpiry(cfg, NOW, NOW)).toMatchObject({ ok: false, error: "domain_expired" });
  });
});

describe("parseDomainCache", () => {
  it("round-trips a stored read", () => {
    const cache = cacheOf(200, 1, { retryAt: NOW, lastError: { code: "rdap_error", message: "x", at: NOW } });
    expect(parseDomainCache(JSON.stringify(cache))).toEqual(cache);
  });
  it("treats missing, unreadable or malformed values as no cache", () => {
    expect(parseDomainCache(null)).toBeNull();
    expect(parseDomainCache("not json")).toBeNull();
    expect(parseDomainCache(JSON.stringify({ domain: "example.com", expiresAt: "soon", checkedAt: 1 }))).toBeNull();
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
  });
});

describe("runDomainCheck with a cached read", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const cfg = makeConfig({ warnDays: 30 });

  it("makes no request while the read is fresh, and says so in meta", async () => {
    const fetchMock = mockFetch(rdapResponse([]));
    const cache = cacheOf(200, HOUR);
    const r = await runDomainCheck(cfg, { cache, now: NOW });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, fetches: 0 });
    expect(r.durationMs).toBeUndefined();
    expect(r.domainCache).toBeUndefined();
    expect(r.meta).toEqual({
      expiresAt: new Date(cache.expiresAt).toISOString(),
      daysUntil: 200,
      checkedAt: cache.checkedAt,
      source: "cache",
    });
  });

  it("stores a fresh read on a successful lookup", async () => {
    mockFetch(rdapResponse([{ eventAction: "expiration", eventDate: new Date(NOW + 300 * DAY).toISOString() }]));
    const pace = vi.fn().mockResolvedValue(undefined);
    const r = await runDomainCheck(makeConfig({ domain: "Example.com" }), {
      cache: cacheOf(200, DOMAIN_REFRESH_MS),
      now: NOW,
      pace,
    });
    expect(pace).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
    expect(r.domainCache).toEqual({ domain: "example.com", expiresAt: NOW + 300 * DAY, checkedAt: NOW });
    expect(r.meta).toMatchObject({ daysUntil: 300, checkedAt: NOW, source: "rdap" });
  });

  it.each([
    ["a 429", () => mockFetch(rdapResponse([], 429)), "rdap_rate_limited"],
    ["a 503", () => mockFetch(rdapResponse([], 503)), "rdap_error"],
    ["no expiration event", () => mockFetch(rdapResponse([])), "rdap_no_expiry"],
    ["a network error", () => vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom"))), "rdap_error"],
  ])("judges the cached read when a refresh fails with %s", async (_label, stub, code) => {
    stub();
    const cache = cacheOf(200, DOMAIN_REFRESH_MS + HOUR);
    const r = await runDomainCheck(cfg, { cache, now: NOW });
    expect(r).toMatchObject({ ok: true, recheck: "skip" });
    expect(r.error).toBeUndefined();
    const meta = r.meta as DomainMeta;
    expect(meta).toMatchObject({ daysUntil: 200, checkedAt: cache.checkedAt, source: "cache" });
    expect(meta.lookupError).toMatchObject({ code, at: NOW });
    expect(r.domainCache).toEqual({ ...cache, retryAt: NOW + DOMAIN_RETRY_MS, lastError: meta.lookupError });
  });

  it("holds off for a longer Retry-After, capped at a day", async () => {
    mockFetch(rdapResponse([], 429, { "retry-after": "7200" }));
    const cache = cacheOf(200, DOMAIN_REFRESH_MS);
    const r = await runDomainCheck(cfg, { cache, now: NOW });
    expect(r.domainCache?.retryAt).toBe(NOW + 7_200_000);

    mockFetch(rdapResponse([], 429, { "retry-after": String(7 * 24 * 3600) }));
    const capped = await runDomainCheck(cfg, { cache, now: NOW });
    expect(capped.domainCache?.retryAt).toBe(NOW + DOMAIN_MAX_RETRY_AFTER_MS);
  });

  it("is still down when the cached date has passed and the refresh fails", async () => {
    mockFetch(rdapResponse([], 503));
    const cache = cacheOf(-1, 2 * DAY);
    const r = await runDomainCheck(cfg, { cache, now: NOW });
    expect(r).toMatchObject({ ok: false, error: "domain_expired", recheck: "skip" });
  });

  it("without a usable read, a failure counts, and a 429 defers its re-check", async () => {
    mockFetch(rdapResponse([], 503));
    expect(await runDomainCheck(cfg, { cache: null, now: NOW })).toMatchObject({ ok: false, error: "rdap_error" });
    mockFetch(rdapResponse([], 429));
    const limited = await runDomainCheck(cfg, { cache: cacheOf(200, DOMAIN_STALE_LIMIT_MS), now: NOW });
    expect(limited).toMatchObject({ ok: false, error: "rdap_rate_limited", recheck: "defer" });
    expect(limited.domainCache).toBeUndefined();
  });

  it("asks RDAP when forced, even with a fresh read", async () => {
    const fetchMock = mockFetch(
      rdapResponse([{ eventAction: "expiration", eventDate: new Date(NOW + 300 * DAY).toISOString() }]),
    );
    const r = await runDomainCheck(cfg, { cache: cacheOf(200, 1), now: NOW, force: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(r.meta).toMatchObject({ source: "rdap", daysUntil: 300 });
  });

  it("an expiry read from RDAP is not re-checked", async () => {
    mockFetch(rdapResponse([{ eventAction: "expiration", eventDate: new Date(NOW - DAY).toISOString() }]));
    const r = await runDomainCheck(cfg, { now: NOW });
    expect(r).toMatchObject({ ok: false, error: "domain_expired", recheck: "skip" });
    expect(r.domainCache).toMatchObject({ expiresAt: NOW - DAY, checkedAt: NOW });
  });
});
