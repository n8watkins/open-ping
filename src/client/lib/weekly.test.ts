import { describe, expect, it } from "vitest";
import { weeklyLocalTime } from "./weekly";

describe("weeklyLocalTime", () => {
  it("shows the UTC send time in the install's timezone, weekday included", () => {
    expect(weeklyLocalTime(1, 9, "UTC", "en-US")).toBe("Monday 9:00 AM");
    expect(weeklyLocalTime(1, 9, "America/Los_Angeles", "en-US")).toBe("Monday 1:00 AM");
    // Early Monday UTC is still Sunday evening in Los Angeles.
    expect(weeklyLocalTime(1, 2, "America/Los_Angeles", "en-US")).toBe("Sunday 6:00 PM");
    expect(weeklyLocalTime(0, 23, "Asia/Tokyo", "en-US")).toBe("Monday 8:00 AM");
  });

  it("returns nothing for an unknown timezone", () => {
    expect(weeklyLocalTime(1, 9, "Not/AZone", "en-US")).toBe("");
  });
});
