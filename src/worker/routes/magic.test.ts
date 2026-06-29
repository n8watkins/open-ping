import { describe, it, expect } from "vitest";
import { isWithinCooldown, isConsumedTokenValid } from "./magic";

describe("isWithinCooldown", () => {
  const now = 1_000_000;

  it("is false when there is no prior token", () => {
    expect(isWithinCooldown(null, now)).toBe(false);
  });

  it("is true within the default 60s window", () => {
    expect(isWithinCooldown(now - 1, now)).toBe(true);
    expect(isWithinCooldown(now - 59_999, now)).toBe(true);
  });

  it("is false exactly at and past the window boundary", () => {
    expect(isWithinCooldown(now - 60_000, now)).toBe(false);
    expect(isWithinCooldown(now - 120_000, now)).toBe(false);
  });

  it("honors a custom cooldown", () => {
    expect(isWithinCooldown(now - 5_000, now, 10_000)).toBe(true);
    expect(isWithinCooldown(now - 15_000, now, 10_000)).toBe(false);
  });
});

describe("isConsumedTokenValid", () => {
  const now = 1_000_000;

  it("is false when no row was returned (already consumed or never existed)", () => {
    expect(isConsumedTokenValid(null, now)).toBe(false);
  });

  it("is true for a returned, unexpired token", () => {
    expect(isConsumedTokenValid({ expires_at: now + 1 }, now)).toBe(true);
    expect(isConsumedTokenValid({ expires_at: now + 60_000 }, now)).toBe(true);
  });

  it("is false at or past expiry (matches the original <= now check)", () => {
    expect(isConsumedTokenValid({ expires_at: now }, now)).toBe(false);
    expect(isConsumedTokenValid({ expires_at: now - 1 }, now)).toBe(false);
  });
});
