import { describe, it, expect } from "vitest";
import { backoffMs, computeRetry } from "./outbox";

// Mirrors the constants in outbox.ts (BASE=30s, CAP=1h).
const BASE = 30_000;
const CAP = 3_600_000;
const NOW = 1_000_000_000_000; // fixed reference "now"

describe("backoffMs (pure)", () => {
  it("returns BASE at attempt 0", () => {
    expect(backoffMs(0)).toBe(BASE);
  });

  it("doubles each attempt while below the cap", () => {
    expect(backoffMs(1)).toBe(BASE * 2); // 60s
    expect(backoffMs(2)).toBe(BASE * 4); // 120s
    expect(backoffMs(3)).toBe(BASE * 8); // 240s
    expect(backoffMs(6)).toBe(BASE * 64); // 1,920,000ms, still < CAP
  });

  it("is non-decreasing as attempts grow", () => {
    for (let a = 0; a < 30; a++) {
      expect(backoffMs(a + 1)).toBeGreaterThanOrEqual(backoffMs(a));
    }
  });

  it("caps at CAP once the exponential exceeds it", () => {
    // BASE * 2^7 = 3,840,000 > CAP, so attempt 7 onward is clamped.
    expect(backoffMs(7)).toBe(CAP);
    expect(backoffMs(100)).toBe(CAP);
  });

  it("never exceeds CAP for any attempt", () => {
    for (let a = 0; a < 64; a++) {
      expect(backoffMs(a)).toBeLessThanOrEqual(CAP);
    }
  });
});

describe("computeRetry (pure)", () => {
  it("schedules a retry below max with a backoff-based nextAttemptAt", () => {
    expect(computeRetry(1, 5, NOW)).toEqual({
      status: "failed",
      nextAttemptAt: NOW + backoffMs(1),
    });
    expect(computeRetry(3, 5, NOW)).toEqual({
      status: "failed",
      nextAttemptAt: NOW + backoffMs(3),
    });
  });

  it("marks dead exactly at max attempts (nextAttemptAt = now)", () => {
    expect(computeRetry(5, 5, NOW)).toEqual({ status: "dead", nextAttemptAt: NOW });
  });

  it("marks dead above max attempts", () => {
    expect(computeRetry(6, 5, NOW)).toEqual({ status: "dead", nextAttemptAt: NOW });
    expect(computeRetry(99, 5, NOW)).toEqual({ status: "dead", nextAttemptAt: NOW });
  });

  it("treats maxAttempts of 1 as a single try then dead", () => {
    expect(computeRetry(1, 1, NOW)).toEqual({ status: "dead", nextAttemptAt: NOW });
  });
});
