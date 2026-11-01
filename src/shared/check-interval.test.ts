import { describe, expect, it } from "vitest";

import {
  CHECK_INTERVAL_CHOICES_MINUTES,
  checkedEveryText,
  defaultIntervalSeconds,
  effectiveIntervalSeconds,
  everyLabel,
  intervalLabel,
  INTERVAL_REASONS,
  intervalReasonDetail,
  intervalReasonNote,
  isFastMonitor,
  keptFastMonitorIds,
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

describe("fast monitors over the plan", () => {
  const m = (id: string, intervalSeconds: number, createdAt: number, type = "http") => ({ id, type, intervalSeconds, createdAt });

  it("are polled monitors set under 12 minutes, paused or not", () => {
    expect(isFastMonitor(m("a", 60, 0))).toBe(true);
    expect(isFastMonitor(m("a", 660, 0))).toBe(true);
    expect(isFastMonitor(m("a", 720, 0))).toBe(false);
    expect(isFastMonitor(m("a", 60, 0, "heartbeat"))).toBe(false);
  });

  it("keep all of them while they fit", () => {
    expect(keptFastMonitorIds([m("a", 60, 2), m("b", 300, 1), m("c", 720, 0)], 5)).toEqual(new Set(["a", "b"]));
  });

  it("keep the oldest when more are fast than allowed, ties by id, the same every time", () => {
    const list = [m("new", 60, 30), m("old", 60, 10), m("tie-b", 120, 20), m("tie-a", 300, 20), m("slow", 720, 1)];
    expect(keptFastMonitorIds(list, 2)).toEqual(new Set(["old", "tie-a"]));
    expect(keptFastMonitorIds([...list].reverse(), 2)).toEqual(new Set(["old", "tie-a"]));
    expect(keptFastMonitorIds(list, 0)).toEqual(new Set());
  });

  it("keep active monitors before paused or disabled ones, oldest first within each", () => {
    const list = [
      { ...m("old-paused", 60, 1), paused: true },
      { ...m("old-off", 60, 2), enabled: false },
      m("newer", 60, 3),
      m("newest", 60, 4),
    ];
    expect(keptFastMonitorIds(list, 2)).toEqual(new Set(["newer", "newest"]));
    expect(keptFastMonitorIds(list, 3)).toEqual(new Set(["newer", "newest", "old-paused"]));
  });
});

describe("saying how often a monitor is really checked", () => {
  it("says it plainly when it runs as set", () => {
    expect(checkedEveryText(720, "set")).toBe("Checks every 12 minutes");
    expect(checkedEveryText(60, "set")).toBe("Checks every minute");
    expect(checkedEveryText(3600, "set")).toBe("Checks every hour");
    expect(intervalReasonDetail(720, 720, "set")).toBeNull();
  });

  it("names the reason in brackets when it runs at another speed", () => {
    expect(checkedEveryText(720, "plan_minimum")).toBe("Checked every 12 minutes (your plan's fastest)");
    expect(checkedEveryText(720, "fast_monitor_limit")).toBe("Checked every 12 minutes (over your plan's fast monitors)");
    expect(checkedEveryText(720, "install_schedule")).toBe("Checked every 12 minutes (this install's schedule)");
    for (const reason of INTERVAL_REASONS) expect(intervalReasonNote(reason) === null).toBe(reason === "set");
  });

  it("explains the difference in a sentence that names the setting", () => {
    expect(intervalReasonDetail(60, 720, "plan_minimum")).toBe(
      "Set to every minute, but your plan's fastest is every 12 minutes. It goes back to every minute once your plan allows it.",
    );
    expect(intervalReasonDetail(60, 720, "fast_monitor_limit")).toBe(
      "Set to every minute, but older monitors use all of your plan's fast checks, so it runs every 12 minutes until one of them is slowed down or removed, or your plan allows more.",
    );
    expect(intervalReasonDetail(3600, 720, "install_schedule")).toBe(
      "Set to every hour, but this install checks every monitor on its 12-minute schedule.",
    );
  });
});
