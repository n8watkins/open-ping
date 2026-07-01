import { describe, it, expect } from "vitest";
import {
  decideRateLimit,
  rateLimitKey,
  windowIndexFor,
  RATE_LIMIT_WINDOW_MS,
} from "./rate-limit";
import { assertSafeUrl } from "../lib/ssrf";

// Pure pieces of the rate limiter (window math + allow/deny decision) plus the
// SSRF rejection the "Is it down?" endpoint relies on. No D1 — matching the
// repo's node test env, which mirrors db/categories.test.ts.

const W = RATE_LIMIT_WINDOW_MS;

describe("windowIndexFor / rateLimitKey", () => {
  it("buckets timestamps within the same window to one index", () => {
    const base = 1_000 * W; // exact window boundary
    expect(windowIndexFor(base, W)).toBe(1_000);
    expect(windowIndexFor(base + W - 1, W)).toBe(1_000); // still the same window
    expect(windowIndexFor(base + W, W)).toBe(1_001); // next window
  });

  it("embeds the window index in the storage key so each window is a fresh row", () => {
    const base = 1_000 * W;
    expect(rateLimitKey("iid:ip:1.2.3.4", base, W)).toBe("iid:ip:1.2.3.4:1000");
    // A hit one window later produces a DIFFERENT key -> counter resets.
    expect(rateLimitKey("iid:ip:1.2.3.4", base + W, W)).toBe("iid:ip:1.2.3.4:1001");
  });
});

describe("decideRateLimit", () => {
  const now = 1_000 * W; // start of a window

  it("allows hits up to and including the limit, then blocks", () => {
    expect(decideRateLimit(1, 15, now, W).allowed).toBe(true);
    expect(decideRateLimit(15, 15, now, W).allowed).toBe(true);
    const over = decideRateLimit(16, 15, now, W);
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("reports remaining hits within the window", () => {
    expect(decideRateLimit(1, 15, now, W).remaining).toBe(14);
    expect(decideRateLimit(15, 15, now, W).remaining).toBe(0);
  });

  it("computes a Retry-After that counts down to the window rollover", () => {
    // Full window remaining at the window start -> ~60s.
    expect(decideRateLimit(16, 15, now, W).retryAfterSeconds).toBe(60);
    // Near the end of the window -> at least 1s (never 0).
    expect(decideRateLimit(16, 15, now + W - 500, W).retryAfterSeconds).toBe(1);
  });
});

describe("SSRF guard used by the Is-it-down endpoint", () => {
  it("blocks loopback, private, metadata, and credentialed targets", () => {
    for (const url of [
      "http://localhost",
      "http://127.0.0.1",
      "http://10.0.0.1",
      "http://192.168.1.1",
      "http://169.254.169.254",
      "http://[::1]",
      "https://user:pass@example.com",
      "ftp://example.com",
    ]) {
      expect(assertSafeUrl(url).ok, url).toBe(false);
    }
  });

  it("allows ordinary public http(s) URLs", () => {
    for (const url of ["https://example.com", "http://93.184.216.34", "https://api.github.com/"]) {
      expect(assertSafeUrl(url).ok, url).toBe(true);
    }
  });
});
