import { describe, expect, it } from "vitest";
import { hoursLabel, scheduleLabel, scheduleTitle, weekdaysLabel } from "./schedule-label";

describe("scheduleLabel", () => {
  it("labels the common schedules", () => {
    expect(scheduleLabel({ mode: "always" })).toBe("24/7");
    expect(scheduleLabel(undefined)).toBe("24/7");
    expect(
      scheduleLabel({
        mode: "business_hours",
        weekdays: [1, 2, 3, 4, 5],
        start: "08:00",
        end: "17:00",
        timezone: "America/Los_Angeles",
      }),
    ).toBe("Weekdays 8-5");
    expect(
      scheduleLabel({ mode: "custom", timezone: "UTC", days: [], excludedDates: [] }),
    ).toBe("Custom hours");
  });

  it("names weekday sets compactly", () => {
    expect(weekdaysLabel([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(weekdaysLabel([6, 0])).toBe("Weekends");
    expect(weekdaysLabel([1, 2, 3, 4, 5, 6])).toBe("Mon-Sat");
    expect(weekdaysLabel([1, 3, 5])).toBe("Mon, Wed, Fri");
  });

  it("writes hours the way people say them", () => {
    expect(hoursLabel("08:00", "17:00")).toBe("8-5");
    expect(hoursLabel("09:30", "18:15")).toBe("9:30-6:15");
    expect(hoursLabel("20:00", "02:00")).toBe("8 pm-2 am");
    expect(hoursLabel("00:00", "06:00")).toBe("12 am-6 am");
    expect(hoursLabel("12:00", "17:00")).toBe("12 pm-5 pm");
  });

  it("explains the schedule with its timezone", () => {
    expect(
      scheduleTitle({
        mode: "business_hours",
        weekdays: [1, 2, 3, 4, 5],
        start: "08:00",
        end: "17:00",
        timezone: "America/Los_Angeles",
      }),
    ).toContain("America/Los_Angeles");
  });
});
