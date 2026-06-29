import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import type { Schedule } from "../../shared/schemas";
import {
  isActiveAt,
  isExcludedDate,
  nextActivePeriod,
  nextCheckAt,
  activeHoursPerMonth,
} from "./schedule";

const NY = "America/New_York";

/** Build a Date instant from a wall-clock time in a given zone. */
function at(
  zone: string,
  parts: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
  },
): Date {
  return DateTime.fromObject(
    { hour: 0, minute: 0, ...parts },
    { zone },
  ).toJSDate();
}

/** Local hour of an instant when viewed in `zone`. */
function localHour(d: Date, zone: string): number {
  return DateTime.fromJSDate(d, { zone }).hour;
}

const businessNY: Schedule = {
  mode: "business_hours",
  weekdays: [1, 2, 3, 4, 5], // Mon–Fri
  start: "08:00",
  end: "17:00",
  timezone: NY,
};

describe("isActiveAt — always", () => {
  it("is always active", () => {
    const s: Schedule = { mode: "always" };
    expect(isActiveAt(s, new Date("2024-01-01T00:00:00Z"))).toBe(true);
    expect(isActiveAt(s, new Date("2024-07-15T13:37:00Z"))).toBe(true);
  });
});

describe("isActiveAt — business_hours Mon–Fri 08:00–17:00 NY", () => {
  it("active Wednesday 10:00 local", () => {
    // 2024-06-26 is a Wednesday.
    expect(
      isActiveAt(businessNY, at(NY, { year: 2024, month: 6, day: 26, hour: 10 })),
    ).toBe(true);
  });

  it("inactive Wednesday 18:00 local (after close)", () => {
    expect(
      isActiveAt(businessNY, at(NY, { year: 2024, month: 6, day: 26, hour: 18 })),
    ).toBe(false);
  });

  it("inactive Saturday 10:00 local (not a weekday)", () => {
    // 2024-06-29 is a Saturday.
    expect(
      isActiveAt(businessNY, at(NY, { year: 2024, month: 6, day: 29, hour: 10 })),
    ).toBe(false);
  });

  it("is inclusive of start and exclusive of end", () => {
    expect(
      isActiveAt(businessNY, at(NY, { year: 2024, month: 6, day: 26, hour: 8 })),
    ).toBe(true);
    expect(
      isActiveAt(businessNY, at(NY, { year: 2024, month: 6, day: 26, hour: 17 })),
    ).toBe(false);
  });
});

describe("isActiveAt — overnight custom period 22:00–06:00 NY", () => {
  // Monday (weekday 1) window 22:00–06:00 spilling into Tuesday morning.
  const overnight: Schedule = {
    mode: "custom",
    timezone: NY,
    days: [{ weekday: 1, periods: [{ start: "22:00", end: "06:00" }] }],
    excludedDates: [],
  };

  it("active at 23:00 on the opening Monday", () => {
    // 2024-06-24 is a Monday.
    expect(
      isActiveAt(overnight, at(NY, { year: 2024, month: 6, day: 24, hour: 23 })),
    ).toBe(true);
  });

  it("active at 02:00 the next (Tuesday) morning", () => {
    expect(
      isActiveAt(overnight, at(NY, { year: 2024, month: 6, day: 25, hour: 2 })),
    ).toBe(true);
  });

  it("inactive at 12:00 midday", () => {
    expect(
      isActiveAt(overnight, at(NY, { year: 2024, month: 6, day: 24, hour: 12 })),
    ).toBe(false);
    expect(
      isActiveAt(overnight, at(NY, { year: 2024, month: 6, day: 25, hour: 12 })),
    ).toBe(false);
  });
});

describe("excludedDates", () => {
  const s: Schedule = {
    mode: "custom",
    timezone: NY,
    days: [{ weekday: 3, periods: [{ start: "09:00", end: "17:00" }] }],
    excludedDates: ["2024-06-26"], // a Wednesday that would normally be active
  };

  it("makes a normally-active day inactive", () => {
    const instant = at(NY, { year: 2024, month: 6, day: 26, hour: 12 });
    expect(isExcludedDate(s, instant)).toBe(true);
    expect(isActiveAt(s, instant)).toBe(false);
  });

  it("leaves other matching Wednesdays active", () => {
    // 2024-07-03 is a Wednesday, not excluded.
    const instant = at(NY, { year: 2024, month: 7, day: 3, hour: 12 });
    expect(isExcludedDate(s, instant)).toBe(false);
    expect(isActiveAt(s, instant)).toBe(true);
  });
});

describe("excludedDates × overnight windows (opening-day rule)", () => {
  // Monday (weekday 1) overnight window 22:00–06:00 spilling into Tuesday.
  // 2024-06-24 is a Monday; the window spills into Tuesday 2024-06-25. The
  // exclusion rule must anchor the whole window to its OPENING day (Monday) so
  // isActiveAt and nextActivePeriod never disagree — disagreement is what let
  // setScheduledOff write a next_check_at in the past.
  const overnightMon = (excludedDates: string[]): Schedule => ({
    mode: "custom",
    timezone: NY,
    days: [{ weekday: 1, periods: [{ start: "22:00", end: "06:00" }] }],
    excludedDates,
  });
  const monEvening = at(NY, { year: 2024, month: 6, day: 24, hour: 23 });
  const tueMorning = at(NY, { year: 2024, month: 6, day: 25, hour: 2 });

  it("excluding the OPENING day suppresses the whole overnight window", () => {
    const s = overnightMon(["2024-06-24"]);
    expect(isActiveAt(s, monEvening)).toBe(false); // evening portion
    expect(isActiveAt(s, tueMorning)).toBe(false); // morning spillover, same window
  });

  it("excluding only the SPILLOVER day leaves the window active", () => {
    // The divergence the fix closes: the old rule keyed the morning portion off
    // Tuesday's own (excluded) date and wrongly went inactive, while
    // nextActivePeriod kept the window (keyed to Monday). Now both agree.
    const s = overnightMon(["2024-06-25"]);
    expect(isActiveAt(s, monEvening)).toBe(true);
    expect(isActiveAt(s, tueMorning)).toBe(true);
  });

  it("isActiveAt agrees with nextActivePeriod on the morning spillover", () => {
    // The period nextActivePeriod returns must actually contain an instant that
    // isActiveAt reports as active, with no exclusion and with only the
    // spillover day excluded (window still anchored to the open Monday).
    for (const s of [overnightMon([]), overnightMon(["2024-06-25"])]) {
      expect(isActiveAt(s, tueMorning)).toBe(true);
      const period = nextActivePeriod(s, tueMorning);
      expect(period).not.toBeNull();
      expect(period!.start.getTime()).toBeLessThanOrEqual(tueMorning.getTime());
      expect(period!.end.getTime()).toBeGreaterThan(tueMorning.getTime());
    }
  });

  it("excluding the opening day makes nextActivePeriod skip to a future window", () => {
    // With Monday excluded, isActiveAt(tueMorning) is false; the next active
    // window must therefore start strictly AFTER the instant (never the past
    // start of the excluded, already-open window) — the basis for the
    // setScheduledOff next_check_at clamp.
    const s = overnightMon(["2024-06-24"]);
    const period = nextActivePeriod(s, tueMorning);
    expect(period).not.toBeNull();
    expect(period!.start.getTime()).toBeGreaterThan(tueMorning.getTime());
  });
});

describe("DST correctness — America/New_York spring-forward 2024-03-10", () => {
  // Include Sunday so the DST-transition day itself is a scheduled day.
  const everyDayNY: Schedule = {
    mode: "business_hours",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    start: "08:00",
    end: "17:00",
    timezone: NY,
  };

  it("is active at 10:00 local on the spring-forward day", () => {
    expect(
      isActiveAt(everyDayNY, at(NY, { year: 2024, month: 3, day: 10, hour: 10 })),
    ).toBe(true);
  });

  it("is inactive at 18:00 local on the spring-forward day", () => {
    expect(
      isActiveAt(everyDayNY, at(NY, { year: 2024, month: 3, day: 10, hour: 18 })),
    ).toBe(false);
  });

  it("nextActivePeriod skips the weekend across DST to Monday 08:00 local", () => {
    // Friday 2024-03-08 18:00 local: after close. Sat/Sun are not weekdays, so
    // the next active window is Monday 2024-03-11 08:00 local — and the DST
    // transition (Sun 2024-03-10) sits in between.
    const inactiveFridayEvening = at(NY, {
      year: 2024,
      month: 3,
      day: 8,
      hour: 18,
    });
    const next = nextActivePeriod(businessNY, inactiveFridayEvening);
    expect(next).not.toBeNull();
    const start = DateTime.fromJSDate(next!.start, { zone: NY });
    const end = DateTime.fromJSDate(next!.end, { zone: NY });
    expect(start.toFormat("yyyy-MM-dd")).toBe("2024-03-11"); // Monday
    expect(start.hour).toBe(8);
    expect(start.minute).toBe(0);
    expect(end.hour).toBe(17);
    // EDT (UTC-4) is in effect after the transition: 08:00 local = 12:00 UTC.
    expect(next!.start.toISOString()).toBe("2024-03-11T12:00:00.000Z");
  });

  it("nextCheckAt on the inactive Friday evening wakes at the next window start", () => {
    const inactiveFridayEvening = at(NY, {
      year: 2024,
      month: 3,
      day: 8,
      hour: 18,
    });
    const check = nextCheckAt(businessNY, inactiveFridayEvening, 300);
    expect(localHour(check, NY)).toBe(8);
    expect(isActiveAt(businessNY, check)).toBe(true);
    expect(check.toISOString()).toBe("2024-03-11T12:00:00.000Z");
  });
});

describe("nextActivePeriod when currently active", () => {
  it("returns the window currently containing the instant", () => {
    // Wednesday 2024-06-26 10:00 local, mid-window.
    const instant = at(NY, { year: 2024, month: 6, day: 26, hour: 10 });
    const period = nextActivePeriod(businessNY, instant);
    expect(period).not.toBeNull();
    expect(period!.start.getTime()).toBeLessThanOrEqual(instant.getTime());
    expect(period!.end.getTime()).toBeGreaterThan(instant.getTime());
    expect(localHour(period!.start, NY)).toBe(8);
    expect(localHour(period!.end, NY)).toBe(17);
  });

  it("returns null for always", () => {
    expect(nextActivePeriod({ mode: "always" }, new Date())).toBeNull();
  });
});

describe("nextCheckAt", () => {
  it("adds the interval when active", () => {
    const instant = at(NY, { year: 2024, month: 6, day: 26, hour: 10 });
    const check = nextCheckAt(businessNY, instant, 600);
    expect(check.getTime()).toBe(instant.getTime() + 600_000);
  });

  it("adds the interval for always", () => {
    const instant = new Date("2024-06-26T10:00:00Z");
    const check = nextCheckAt({ mode: "always" }, instant, 600);
    expect(check.getTime()).toBe(instant.getTime() + 600_000);
  });

  it("when inactive returns the next window start (active there)", () => {
    // Saturday 2024-06-29 10:00 local — inactive. Next: Monday 07-01 08:00.
    const instant = at(NY, { year: 2024, month: 6, day: 29, hour: 10 });
    const check = nextCheckAt(businessNY, instant, 600);
    expect(check.getTime()).toBeGreaterThan(instant.getTime());
    expect(localHour(check, NY)).toBe(8);
    expect(isActiveAt(businessNY, check)).toBe(true);
    expect(
      DateTime.fromJSDate(check, { zone: NY }).toFormat("yyyy-MM-dd"),
    ).toBe("2024-07-01");
  });
});

describe("activeHoursPerMonth", () => {
  it("always is 720", () => {
    expect(activeHoursPerMonth({ mode: "always" })).toBe(720);
  });

  it("business_hours Mon–Fri 08:00–17:00 ≈ 5/7*30*9 hours", () => {
    expect(activeHoursPerMonth(businessNY)).toBeCloseTo((5 / 7) * 30 * 9, 5);
  });

  it("custom sums period hours across the week (overnight aware)", () => {
    const s: Schedule = {
      mode: "custom",
      timezone: NY,
      days: [
        { weekday: 1, periods: [{ start: "22:00", end: "06:00" }] }, // 8h overnight
        { weekday: 3, periods: [{ start: "09:00", end: "17:00" }] }, // 8h
      ],
      excludedDates: [],
    };
    expect(activeHoursPerMonth(s)).toBeCloseTo((16 * 30) / 7, 5);
  });
});
