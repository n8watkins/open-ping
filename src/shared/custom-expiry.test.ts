import { describe, expect, it } from "vitest";
import { customExpiryError } from "./scopes";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 11, 12, 0, 0);

describe("customExpiryError", () => {
  it("accepts tomorrow through a year ahead", () => {
    expect(customExpiryError(now + DAY, now)).toBeNull();
    expect(customExpiryError(now + 365 * DAY, now)).toBeNull();
    // The end of the last allowed day can be a little over 365 days away.
    expect(customExpiryError(now + 365.9 * DAY, now)).toBeNull();
  });

  it("rejects the past, now and anything beyond a year", () => {
    expect(customExpiryError(now - DAY, now)).toMatch(/future/);
    expect(customExpiryError(now, now)).toMatch(/future/);
    expect(customExpiryError(now + 368 * DAY, now)).toMatch(/1 year/);
    expect(customExpiryError(Number.NaN, now)).toMatch(/valid/);
  });
});
