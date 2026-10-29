import { describe, expect, it } from "vitest";

import {
  CHECK_INTERVAL_CHOICES_MINUTES,
  defaultIntervalSeconds,
  effectiveIntervalSeconds,
  everyLabel,
  intervalLabel,
  planMinimumSeconds,
} from "./check-interval";
import { PLAN_LIMITS } from "./hosted-contract";
import { checkIntervalSecondsSchema } from "./schemas";

describe("check intervals", () => {
  it("defaults a new monitor to 12 minutes, or the plan's shortest when that is longer", () => {
    expect(defaultIntervalSeconds(PLAN_LIMITS.hosted_fast.minIntervalMinutes)).toBe(720);
    expect(defaultIntervalSeconds(PLAN_LIMITS.hosted.minIntervalMinutes)).toBe(720);
    expect(defaultIntervalSeconds(15)).toBe(900);
  });

  it("never checks faster than the plan allows", () => {
    expect(effectiveIntervalSeconds(60, 1)).toBe(60);
    expect(effectiveIntervalSeconds(60, 12)).toBe(720);
    expect(effectiveIntervalSeconds(3600, 12)).toBe(3600);
    expect(effectiveIntervalSeconds(Number.NaN, 1)).toBe(720);
  });

  it("rounds a plan's minimum up to whole minutes", () => {
    expect(planMinimumSeconds(0.5)).toBe(60);
    expect(planMinimumSeconds(Number.POSITIVE_INFINITY)).toBe(720);
  });

  it("offers only valid intervals", () => {
    for (const minutes of CHECK_INTERVAL_CHOICES_MINUTES) {
      expect(checkIntervalSecondsSchema.safeParse(minutes * 60).success).toBe(true);
    }
    expect(checkIntervalSecondsSchema.safeParse(90).success).toBe(false);
    expect(checkIntervalSecondsSchema.safeParse(30).success).toBe(false);
    expect(checkIntervalSecondsSchema.safeParse(86_460).success).toBe(false);
  });

  it("labels intervals plainly", () => {
    expect(intervalLabel(1)).toBe("1 minute");
    expect(intervalLabel(12)).toBe("12 minutes");
    expect(intervalLabel(60)).toBe("1 hour");
    expect(intervalLabel(120)).toBe("2 hours");
    expect(intervalLabel(90)).toBe("90 minutes");
    expect(everyLabel(1)).toBe("every minute");
    expect(everyLabel(12)).toBe("every 12 minutes");
    expect(everyLabel(60)).toBe("every hour");
  });
});
