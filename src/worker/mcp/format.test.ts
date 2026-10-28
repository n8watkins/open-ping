import { describe, expect, it } from "vitest";
import { duration, iso, pct, withIsoTimes } from "./format";
import { overallState, parseTime, weekdayText } from "./tools";

describe("iso", () => {
  it("renders epoch ms in the given zone with its offset", () => {
    expect(iso(Date.UTC(2026, 9, 28, 15, 0, 0), "America/Los_Angeles")).toBe("2026-10-28T08:00:00-07:00");
    expect(iso(Date.UTC(2026, 9, 28, 15, 0, 0), "UTC")).toBe("2026-10-28T15:00:00Z");
  });

  it("falls back to UTC for an invalid zone and passes null through", () => {
    expect(iso(Date.UTC(2026, 0, 1), "Not/AZone")).toBe("2026-01-01T00:00:00Z");
    expect(iso(null, "UTC")).toBeNull();
  });
});

describe("withIsoTimes", () => {
  it("converts timestamp keys deeply and leaves durations and counts alone", () => {
    const ms = Date.UTC(2026, 9, 28, 15, 0, 0);
    const out = withIsoTimes(
      {
        startedAt: ms,
        durationMs: 812,
        intervalSeconds: 720,
        runs: [{ finishedAt: ms, d1Queries: 3 }],
        nested: { stateSince: ms, at: ms, lastCheckedAt: null },
      },
      "UTC",
    );
    expect(out).toEqual({
      startedAt: "2026-10-28T15:00:00Z",
      durationMs: 812,
      intervalSeconds: 720,
      runs: [{ finishedAt: "2026-10-28T15:00:00Z", d1Queries: 3 }],
      nested: { stateSince: "2026-10-28T15:00:00Z", at: "2026-10-28T15:00:00Z", lastCheckedAt: null },
    });
  });
});

describe("small formatters", () => {
  it("formats durations and percentages compactly", () => {
    expect(duration(45)).toBe("45s");
    expect(duration(720)).toBe("12m");
    expect(duration(3 * 3600 + 300)).toBe("3h 5m");
    expect(duration(2 * 86400 + 4 * 3600)).toBe("2d 4h");
    expect(duration(null)).toBe("-");
    expect(pct(99.9512)).toBe("99.95%");
    expect(pct(100)).toBe("100%");
  });

  it("derives the overall state worst first", () => {
    expect(overallState({ total: 0 })).toBe("no_monitors");
    expect(overallState({ total: 3, up: 2, suspended: 1 })).toBe("down");
    expect(overallState({ total: 3, up: 2, degraded: 1 })).toBe("degraded");
    expect(overallState({ total: 2, up: 1, scheduled_off: 1 })).toBe("operational");
    expect(overallState({ total: 2, scheduled_off: 1, paused: 1 })).toBe("all_off");
    expect(overallState({ total: 2, scheduled_off: 1, warming_up: 1 })).toBe("no_data");
  });

  it("names weekdays and collapses runs", () => {
    expect(weekdayText([1, 2, 3, 4, 5])).toBe("Mon-Fri");
    expect(weekdayText([0, 6])).toBe("Sun,Sat");
    expect(weekdayText([5, 1, 2])).toBe("Mon,Tue,Fri");
    expect(weekdayText([0, 1, 2, 3, 4, 5, 6])).toBe("Sun-Sat");
  });

  it("parses ISO times and now", () => {
    expect(parseTime("now", 42)).toBe(42);
    expect(parseTime("2026-10-28T08:00:00-07:00", 0)).toBe(Date.UTC(2026, 9, 28, 15));
    expect(parseTime("tomorrow", 0)).toBeNaN();
  });
});
