import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANT_CHECK_MESSAGES,
  CERT_REFRESH_MS,
  CERT_REFRESH_SOON_MS,
  CERT_RETRY_MS,
  CERT_STALE_LIMIT_MS,
  certificateDetail,
  certWarningFor,
  evaluateCertRead,
  isCloudflareIPv4,
  issuerLabel,
  parseCertCache,
  planCertCheck,
  runCertCheck,
  tlsReader,
  type CertCache,
  type CertRead,
} from "./cert";
import type { CertificateInfo, TlsReadResult } from "./tls";
import { certConfigSchema, type CertConfig } from "../../shared/schemas";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

const config = (over: Partial<CertConfig> = {}): CertConfig =>
  certConfigSchema.parse({ host: "example.test", ...over });

const certInfo = (over: Partial<CertificateInfo> = {}): CertificateInfo => ({
  subject: "example.test",
  issuerOrg: "Let's Encrypt",
  issuerName: "R11",
  validFrom: NOW - 30 * DAY,
  validTo: NOW + 60 * DAY,
  sans: ["example.test", "www.example.test"],
  sanCount: 2,
  serial: "0abc",
  ...over,
});
const certRead = (over: Partial<CertificateInfo> = {}): CertRead => ({ kind: "cert", cert: certInfo(over), chainLength: 2 });
const cacheOf = (read: CertRead, over: Partial<CertCache> = {}): CertCache => ({
  host: "example.test",
  port: 443,
  checkedAt: NOW - HOUR * 2,
  read,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("certConfigSchema", () => {
  it("defaults port 443, thresholds 30/14/7 and a 10 s timeout", () => {
    expect(config()).toEqual({ host: "example.test", port: 443, warnDays: [30, 14, 7], timeoutMs: 10000 });
  });
  it("stores thresholds largest first without repeats", () => {
    expect(config({ warnDays: [7, 30, 7, 1] }).warnDays).toEqual([30, 7, 1]);
  });
  it("refuses bad hosts, port 25 and too many or out-of-range thresholds", () => {
    for (const bad of [
      { host: "https://example.test" },
      { host: "example.test/path" },
      { host: "localhost" },
      { host: "127.0.0.1" },
      { host: "10.1" },
      { host: "0x7f.0.0.1" },
      { host: "0177.0.0.1" },
      { host: "0251.0376.0251.0376" },
      { host: "192.168.1.1." },
      { host: "example.test", port: 25 },
      { host: "example.test", warnDays: [] },
      { host: "example.test", warnDays: [1, 2, 3, 4, 5, 6] },
      { host: "example.test", warnDays: [0] },
      { host: "example.test", warnDays: [400] },
    ]) {
      expect(certConfigSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("planCertCheck", () => {
  const c = config();
  it("reads when there is no usable cache", () => {
    expect(planCertCheck(c, null, NOW)).toEqual({ read: true, fallback: null });
    expect(planCertCheck(c, cacheOf(certRead(), { host: "other.test" }), NOW)).toEqual({ read: true, fallback: null });
    expect(planCertCheck(c, cacheOf(certRead(), { port: 8443 }), NOW)).toEqual({ read: true, fallback: null });
    const stale = cacheOf(certRead(), { checkedAt: NOW - CERT_STALE_LIMIT_MS });
    expect(planCertCheck(c, stale, NOW)).toEqual({ read: true, fallback: null });
  });

  it("judges a fresh read from the cache, once a day outside the warning window", () => {
    const fresh = cacheOf(certRead(), { checkedAt: NOW - CERT_REFRESH_MS + 1 });
    expect(planCertCheck(c, fresh, NOW)).toEqual({ read: false, cache: fresh });
    const old = cacheOf(certRead(), { checkedAt: NOW - CERT_REFRESH_MS });
    expect(planCertCheck(c, old, NOW)).toEqual({ read: true, fallback: old });
  });

  it("reads hourly within the warning window and for an expired certificate", () => {
    const soon = cacheOf(certRead({ validTo: NOW + 20 * DAY }), { checkedAt: NOW - CERT_REFRESH_SOON_MS });
    expect(planCertCheck(c, soon, NOW).read).toBe(true);
    expect(planCertCheck(c, { ...soon, checkedAt: NOW - CERT_REFRESH_SOON_MS + 1 }, NOW).read).toBe(false);
    const expired = cacheOf(certRead({ validTo: NOW - DAY }), { checkedAt: NOW - CERT_REFRESH_SOON_MS });
    expect(planCertCheck(c, expired, NOW).read).toBe(true);
  });

  it("reads at once when the cached expiry passes, then holds off after a failure", () => {
    const passing = cacheOf(certRead({ validTo: NOW - 1000 }), { checkedAt: NOW - 10 * 60_000 });
    expect(planCertCheck(c, passing, NOW).read).toBe(true);
    const failedSince = { ...passing, lastError: { code: "cert_timeout", at: NOW - 500 }, retryAt: NOW + HOUR };
    expect(planCertCheck(c, failedSince, NOW).read).toBe(false);
  });

  it("holds off until retryAt after a failed read", () => {
    const held = cacheOf(certRead(), { checkedAt: NOW - 2 * CERT_REFRESH_MS, retryAt: NOW + 1 });
    expect(planCertCheck(c, held, NOW).read).toBe(false);
    expect(planCertCheck(c, held, NOW + 1).read).toBe(true);
  });

  it("re-reads a can't-check answer once a day, and always on a manual test", () => {
    const cant = cacheOf({ kind: "cant_check", reason: "cloudflare", detail: "" }, { checkedAt: NOW - CERT_REFRESH_MS + 1 });
    expect(planCertCheck(c, cant, NOW).read).toBe(false);
    expect(planCertCheck(c, cant, NOW, true)).toEqual({ read: true, fallback: cant });
  });

  it("matches the cache key case-insensitively and without a trailing dot", () => {
    const fresh = cacheOf(certRead());
    expect(planCertCheck(config({ host: "Example.TEST." }), fresh, NOW).read).toBe(false);
  });
});

describe("certWarningFor", () => {
  const days = [30, 14, 7];
  const at = (d: number) => NOW + d * DAY + HOUR; // a little more than d days left
  it("crosses the smallest threshold at or above the days left", () => {
    expect(certWarningFor(days, "example.test", at(31), NOW, undefined)).toBeNull();
    expect(certWarningFor(days, "example.test", at(30), NOW, undefined)).toMatchObject({ threshold: 30, daysUntil: 30 });
    expect(certWarningFor(days, "example.test", at(20), NOW, undefined)).toMatchObject({ threshold: 30, daysUntil: 20 });
    expect(certWarningFor(days, "example.test", at(14), NOW, undefined)).toMatchObject({ threshold: 14 });
    expect(certWarningFor(days, "example.test", at(3), NOW, undefined)).toMatchObject({ threshold: 7, daysUntil: 3 });
  });
  it("alerts each threshold once per certificate", () => {
    const validTo = at(20);
    expect(certWarningFor(days, "x", validTo, NOW, { validTo, days: 30 })).toBeNull();
    expect(certWarningFor(days, "x", at(13), NOW, { validTo: at(13), days: 30 })).toMatchObject({ threshold: 14 });
    expect(certWarningFor(days, "x", at(13), NOW, { validTo: at(13), days: 14 })).toBeNull();
    expect(certWarningFor(days, "x", at(13), NOW, { validTo: at(13), days: 7 })).toBeNull();
    // A renewed certificate starts over.
    expect(certWarningFor(days, "x", at(25), NOW, { validTo: at(3), days: 7 })).toMatchObject({ threshold: 30 });
  });
  it("is silent once expired: the down alert covers that", () => {
    expect(certWarningFor(days, "x", NOW, NOW, undefined)).toBeNull();
    expect(certWarningFor(days, "x", NOW - DAY, NOW, undefined)).toBeNull();
  });
});

describe("evaluateCertRead", () => {
  const c = config();
  it("is up outside the window, degraded inside it, down once expired or not valid yet", () => {
    expect(evaluateCertRead(c, certRead({ validTo: NOW + 60 * DAY }), NOW, undefined)).toMatchObject({
      ok: true,
      meta: { daysUntil: 60, issuer: "Let's Encrypt (R11)", coversHost: true },
    });
    const soon = evaluateCertRead(c, certRead({ validTo: NOW + 10 * DAY }), NOW, undefined);
    expect(soon).toMatchObject({ ok: true, degraded: true, certWarning: { threshold: 14, daysUntil: 10 } });
    expect(evaluateCertRead(c, certRead({ validTo: NOW - 1 }), NOW, undefined)).toMatchObject({
      ok: false,
      error: "cert_expired",
      recheck: "skip",
    });
    expect(evaluateCertRead(c, certRead({ validFrom: NOW + DAY }), NOW, undefined)).toMatchObject({
      ok: false,
      error: "cert_not_yet_valid",
    });
  });
  it("flags a certificate that doesn't name the host", () => {
    const r = evaluateCertRead(c, certRead({ sans: ["other.test"] }), NOW, undefined);
    expect(r.meta.coversHost).toBe(false);
    expect(r.ok).toBe(true);
  });
  it("is can't-check, never down, with the plain-words reason", () => {
    const r = evaluateCertRead(c, { kind: "cant_check", reason: "tls13_only", detail: "alert 70" }, NOW, undefined);
    expect(r).toMatchObject({ ok: true, cantCheck: true, meta: { cantCheck: { reason: "tls13_only", detail: "alert 70" } } });
    expect(r.meta.cantCheck?.message).toBe(CANT_CHECK_MESSAGES.tls13_only);
  });
});

describe("isCloudflareIPv4", () => {
  it("knows Cloudflare's ranges", () => {
    for (const ip of ["104.16.0.1", "104.23.255.255", "172.67.10.10", "188.114.97.3", "162.159.1.1"]) {
      expect(isCloudflareIPv4(ip), ip).toBe(true);
    }
    for (const ip of ["104.15.255.255", "8.8.8.8", "140.82.112.3", "not an ip", "1.2.3"]) {
      expect(isCloudflareIPv4(ip), ip).toBe(false);
    }
  });
});

describe("issuerLabel", () => {
  it("joins organization and name", () => {
    expect(issuerLabel({ issuerOrg: "Let's Encrypt", issuerName: "R11" })).toBe("Let's Encrypt (R11)");
    expect(issuerLabel({ issuerOrg: "Same", issuerName: "Same" })).toBe("Same");
    expect(issuerLabel({ issuerOrg: null, issuerName: "R11" })).toBe("R11");
    expect(issuerLabel({ issuerOrg: null, issuerName: null })).toBeUndefined();
  });
});

describe("parseCertCache", () => {
  it("round-trips a cache and ignores anything unreadable", () => {
    const cache = cacheOf(certRead(), {
      retryAt: NOW,
      lastError: { code: "cert_timeout", message: "slow", at: NOW },
      warned: { validTo: NOW + DAY, days: 7 },
    });
    expect(parseCertCache(JSON.stringify(cache))).toEqual(cache);
    const cant = cacheOf({ kind: "cant_check", reason: "cloudflare", detail: "x" });
    expect(parseCertCache(JSON.stringify(cant))).toEqual(cant);
    for (const bad of [null, "", "nope", "[]", JSON.stringify({ host: "x" }), JSON.stringify({ ...cache, read: { kind: "x" } })]) {
      expect(parseCertCache(bad)).toBeNull();
    }
    expect(parseCertCache(JSON.stringify({ ...cant, read: { kind: "cant_check", reason: "made_up" } }))).toBeNull();
  });
});

// --- runCertCheck with a fake TLS reader --------------------------------------

function fakeReader(...results: TlsReadResult[]) {
  let i = 0;
  return vi.spyOn(tlsReader, "read").mockImplementation(async () => results[Math.min(i++, results.length - 1)]!);
}
const ok = (over: Partial<CertificateInfo> = {}): TlsReadResult => ({ ok: true, cert: certInfo(over), chainLength: 2, durationMs: 40 });
const fail = (kind: "connect_failed" | "timeout" | "closed" | "malformed" | "alert", message: string, alert?: number): TlsReadResult => ({
  ok: false,
  kind,
  message,
  durationMs: 12,
  ...(alert !== undefined ? { alert } : {}),
});
function fakeDns(ips: string[] | "error") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    expect(url).toMatch(/^https:\/\/cloudflare-dns\.com\/dns-query\?name=example\.test&type=A$/);
    if (ips === "error") return new Response("no", { status: 502 });
    return Response.json({ Status: 0, Answer: ips.map((data) => ({ type: 1, data })) });
  });
}

describe("runCertCheck", () => {
  const c = config();

  it("reads the certificate and caches it", async () => {
    const read = fakeReader(ok());
    const r = await runCertCheck(c, { now: NOW });
    expect(read).toHaveBeenCalledWith("example.test", 443, 10000);
    expect(r).toMatchObject({
      ok: true,
      fetches: 1,
      durationMs: 40,
      meta: { source: "tls", checkedAt: NOW, daysUntil: 60, host: "example.test", port: 443 },
      certCache: { host: "example.test", port: 443, checkedAt: NOW, read: { kind: "cert" } },
    });
  });

  it("judges a fresh cache with no connection", async () => {
    const read = fakeReader(ok());
    const r = await runCertCheck(c, { now: NOW, cache: cacheOf(certRead()) });
    expect(read).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, fetches: 0, meta: { source: "cache" } });
    expect(r.durationMs).toBeUndefined();
    expect(r.certCache).toBeUndefined();
  });

  it("keeps the warned marker for the same certificate and drops it for a new one", async () => {
    const validTo = NOW + 10 * DAY;
    const old = cacheOf(certRead({ validTo }), { checkedAt: NOW - 2 * HOUR, warned: { validTo, days: 14 } });
    fakeReader(ok({ validTo }));
    const same = await runCertCheck(c, { now: NOW, cache: old });
    expect(same.certCache?.warned).toEqual({ validTo, days: 14 });
    expect(same.certWarning).toBeUndefined();
    vi.restoreAllMocks();
    fakeReader(ok({ validTo: NOW + 90 * DAY }));
    const renewed = await runCertCheck(c, { now: NOW, cache: old });
    expect(renewed.certCache?.warned).toBeUndefined();
    expect(renewed).toMatchObject({ ok: true });
    expect(renewed.degraded).toBeUndefined();
  });

  it("says can't check for a host behind Cloudflare, from the runtime's message alone", async () => {
    fakeReader(fail("connect_failed", "proxy request failed, cannot connect to the specified address"));
    const dns = fakeDns([]);
    const r = await runCertCheck(c, { now: NOW });
    expect(dns).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      ok: true,
      cantCheck: true,
      fetches: 1,
      meta: { cantCheck: { reason: "cloudflare" } },
      certCache: { read: { kind: "cant_check", reason: "cloudflare" } },
    });
  });

  it("asks DNS when a connection fails without saying why, and finds Cloudflare", async () => {
    fakeReader(fail("connect_failed", "Network connection lost."));
    fakeDns(["104.21.32.1"]);
    const r = await runCertCheck(c, { now: NOW });
    expect(r).toMatchObject({ ok: true, cantCheck: true, fetches: 2, meta: { cantCheck: { reason: "cloudflare" } } });
  });

  it("fails a refused connection to a host that isn't on Cloudflare", async () => {
    fakeReader(fail("connect_failed", "Connection refused"));
    fakeDns(["192.0.2.10"]);
    const r = await runCertCheck(c, { now: NOW });
    expect(r).toMatchObject({ ok: false, error: "cert_connect_failed", fetches: 2 });
    expect(r.errorMessage).toContain("Connection refused");
    vi.restoreAllMocks();
    fakeReader(fail("connect_failed", "Connection refused"));
    fakeDns("error");
    expect(await runCertCheck(c, { now: NOW })).toMatchObject({ ok: false, error: "cert_connect_failed" });
  });

  it("fails a read refused with handshake_failure or unrecognized_name: the server is misconfigured", async () => {
    fakeReader(fail("alert", "alert 40", 40), fail("alert", "alert 112", 112));
    expect(await runCertCheck(c, { now: NOW })).toMatchObject({ ok: false, error: "cert_handshake_failed", fetches: 1 });
    const r = await runCertCheck(c, { now: NOW });
    expect(r).toMatchObject({ ok: false, error: "cert_handshake_failed" });
    expect(r.cantCheck).toBeUndefined();
  });

  it("says can't check for a TLS 1.3-only server and one that refuses the hello otherwise", async () => {
    fakeReader(fail("alert", "alert 70", 70), fail("alert", "alert 80", 80));
    expect(await runCertCheck(c, { now: NOW })).toMatchObject({ ok: true, cantCheck: true, meta: { cantCheck: { reason: "tls13_only" } } });
    expect(await runCertCheck(c, { now: NOW })).toMatchObject({ ok: true, cantCheck: true, meta: { cantCheck: { reason: "refused" } } });
  });

  it("fails a timeout, an early close or an unreadable answer when there's no cache", async () => {
    fakeReader(fail("timeout", "slow"), fail("closed", "closed"), fail("malformed", "not tls"));
    expect(await runCertCheck(c, { now: NOW })).toMatchObject({ ok: false, error: "cert_timeout", fetches: 1 });
    expect(await runCertCheck(c, { now: NOW })).toMatchObject({ ok: false, error: "cert_closed" });
    expect(await runCertCheck(c, { now: NOW })).toMatchObject({ ok: false, error: "cert_unreadable" });
  });

  it("judges a failed refresh from a recent read and holds off for an hour", async () => {
    fakeReader(fail("timeout", "slow"));
    const old = cacheOf(certRead(), { checkedAt: NOW - CERT_REFRESH_MS - HOUR });
    const r = await runCertCheck(c, { now: NOW, cache: old });
    expect(r).toMatchObject({
      ok: true,
      fetches: 1,
      recheck: "skip",
      meta: { source: "cache", checkedAt: old.checkedAt, lookupError: { code: "cert_timeout", at: NOW } },
      certCache: { checkedAt: old.checkedAt, retryAt: NOW + CERT_RETRY_MS, lastError: { code: "cert_timeout" } },
    });
  });

  it("refuses internal hosts and IPs in any form without dialing, even past the schema", async () => {
    const read = fakeReader(ok());
    for (const host of ["127.0.0.1", "127.1", "0x7f.0.0.1", "0177.0.0.1", "10.1", "0251.0376.0251.0376", "8.8.8.8", "metadata.google.internal", "printer.local"]) {
      const r = await runCertCheck({ ...c, host }, { now: NOW });
      expect(r, host).toMatchObject({ ok: false, error: "blocked_host", fetches: 0 });
    }
    expect(read).not.toHaveBeenCalled();
  });
});

describe("certificateDetail", () => {
  it("shows the cached read for this host and port only", () => {
    const c = config();
    expect(certificateDetail(c, null, NOW)).toBeNull();
    expect(certificateDetail(c, cacheOf(certRead(), { port: 8443 }), NOW)).toBeNull();
    expect(certificateDetail(c, cacheOf(certRead()), NOW)).toMatchObject({
      host: "example.test",
      certificate: { issuer: "Let's Encrypt (R11)", daysUntil: 60, sans: ["example.test", "www.example.test"], coversHost: true },
    });
    expect(
      certificateDetail(c, cacheOf({ kind: "cant_check", reason: "cloudflare", detail: "d" }), NOW),
    ).toMatchObject({ cantCheck: { reason: "cloudflare", message: CANT_CHECK_MESSAGES.cloudflare } });
  });
});
