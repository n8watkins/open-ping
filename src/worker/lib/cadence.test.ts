import { describe, expect, it } from "vitest";

import {
  alignNextCheck,
  checkIntervalSeconds,
  CRON_CADENCE,
  dueSlackMs,
  effectiveIntervals,
  isUpkeepRun,
  nextDueAt,
  planCadence,
  platformCadence,
  runBaseTime,
  upkeepSlot,
} from "./cadence";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 26, 6, 0, 0);

describe("check intervals by cadence", () => {
  it("checks every polled monitor every 12 minutes on the cron, whatever is stored", () => {
    expect(checkIntervalSeconds({ type: "http", intervalSeconds: 60 }, CRON_CADENCE)).toBe(720);
    expect(checkIntervalSeconds({ type: "dns", intervalSeconds: 3600 }, CRON_CADENCE)).toBe(720);
  });

  it("uses a monitor's own interval on the platform, never under the plan's shortest", () => {
    expect(checkIntervalSeconds({ type: "http", intervalSeconds: 60 }, platformCadence(1))).toBe(60);
    expect(checkIntervalSeconds({ type: "http", intervalSeconds: 60 }, platformCadence(12))).toBe(720);
    expect(checkIntervalSeconds({ type: "tcp", intervalSeconds: 3600 }, platformCadence(12))).toBe(3600);
  });

  it("checks a fast monitor over the plan's allowance every 12 minutes, at the slowest of that and its own", () => {
    const kept = new Set(["kept"]);
    const capped = platformCadence(1, 1);
    expect(capped.fastMonitors).toBe(1);
    expect(platformCadence(1).fastMonitors).toBeNull();
    expect(checkIntervalSeconds({ id: "kept", type: "http", intervalSeconds: 60 }, capped, kept)).toBe(60);
    expect(checkIntervalSeconds({ id: "over", type: "http", intervalSeconds: 60 }, capped, kept)).toBe(720);
    expect(checkIntervalSeconds({ id: "slow", type: "http", intervalSeconds: 3600 }, capped, kept)).toBe(3600);
    expect(checkIntervalSeconds({ id: "over", type: "heartbeat", intervalSeconds: 60 }, capped, kept)).toBe(60);
    expect(checkIntervalSeconds({ id: "over", type: "http", intervalSeconds: 60 }, CRON_CADENCE, kept)).toBe(720);
  });

  it("never changes a heartbeat's interval", () => {
    expect(checkIntervalSeconds({ type: "heartbeat", intervalSeconds: 60 }, CRON_CADENCE)).toBe(60);
    expect(checkIntervalSeconds({ type: "heartbeat", intervalSeconds: 60 }, platformCadence(12))).toBe(60);
  });
});

describe("effective intervals, and why", () => {
  const m = (id: string, intervalSeconds: number, createdAt: number, extra: { type?: string; paused?: boolean; enabled?: boolean } = {}) => ({
    id,
    type: extra.type ?? "http",
    intervalSeconds,
    createdAt,
    paused: extra.paused,
    enabled: extra.enabled,
  });
  const plain = (map: ReturnType<typeof effectiveIntervals>) => Object.fromEntries([...map].map(([id, e]) => [id, `${e.seconds} ${e.reason}`]));

  it("says when an install of your own's cron checks at another speed than is stored", () => {
    expect(plain(effectiveIntervals([m("set", 720, 1), m("fast", 60, 2), m("hourly", 3600, 3), m("hb", 60, 4, { type: "heartbeat" })], CRON_CADENCE))).toEqual({
      set: "720 set",
      fast: "720 install_schedule",
      hourly: "720 install_schedule",
      hb: "60 set",
    });
  });

  it("says when the plan's shortest interval slows a monitor down", () => {
    const hosted = planCadence({ monitors: 20, minIntervalMinutes: 12, fastMonitors: 0 });
    expect(plain(effectiveIntervals([m("fast", 60, 1), m("five", 300, 2), m("hourly", 3600, 3)], hosted))).toEqual({
      fast: "720 plan_minimum",
      five: "720 plan_minimum",
      hourly: "3600 set",
    });
    const fivePlan = platformCadence(5, 10);
    expect(plain(effectiveIntervals([m("fast", 60, 1)], fivePlan))).toEqual({ fast: "300 plan_minimum" });
  });

  it("says when a fast monitor is over the plan's allowance: active ones, then the oldest, keep their speed", () => {
    const capped = planCadence({ monitors: 20, minIntervalMinutes: 1, fastMonitors: 1 });
    expect(plain(effectiveIntervals([m("older", 60, 1), m("newer", 120, 2)], capped))).toEqual({
      older: "60 set",
      newer: "720 fast_monitor_limit",
    });
  });

  it("gives a paused or disabled fast monitor the speed it would run at once resumed, without moving the others", () => {
    const capped = platformCadence(1, 1);
    // The older one is paused: the newer one has the fast place now, and the
    // older one would take it back when resumed.
    expect(plain(effectiveIntervals([m("older", 60, 1, { paused: true }), m("newer", 60, 2)], capped))).toEqual({
      older: "60 set",
      newer: "60 set",
    });
    // A paused newer one would still be over the allowance when resumed.
    expect(plain(effectiveIntervals([m("older", 60, 1), m("newer", 60, 2, { enabled: false })], capped))).toEqual({
      older: "60 set",
      newer: "720 fast_monitor_limit",
    });
  });

  it("matches checkIntervalSeconds for every active monitor, which is what the scheduler runs", () => {
    const capped = platformCadence(1, 2);
    const list = [m("a", 60, 4), m("b", 60, 3), m("c", 60, 2), m("d", 60, 1), m("e", 3600, 5)];
    const effective = effectiveIntervals(list, capped);
    const kept = new Set(["d", "c"]);
    for (const x of list) expect(effective.get(x.id)!.seconds).toBe(checkIntervalSeconds(x, capped, kept));
  });
});

describe("due slack", () => {
  it("is 6 minutes on the cron, as it always was", () => {
    expect(dueSlackMs(720, CRON_CADENCE)).toBe(6 * MINUTE);
  });

  it("is 30 seconds on the platform's minute ticks", () => {
    expect(dueSlackMs(60, platformCadence(1))).toBe(30_000);
    expect(dueSlackMs(720, platformCadence(1))).toBe(30_000);
  });
});

describe("run base time", () => {
  it("is now on the cron", () => {
    expect(runBaseTime(T0 + 5_000, T0, CRON_CADENCE)).toBe(T0 + 5_000);
  });

  it("is the platform's tick when the call is at most a tick late", () => {
    expect(runBaseTime(T0 + 5_000, T0, platformCadence(1))).toBe(T0);
    expect(runBaseTime(T0 + MINUTE, T0, platformCadence(1))).toBe(T0);
  });

  it("is now for a call much later than its tick (a retry), or from the future", () => {
    expect(runBaseTime(T0 + 3 * MINUTE, T0, platformCadence(1))).toBe(T0 + 3 * MINUTE);
    expect(runBaseTime(T0, T0 + 5_000, platformCadence(1))).toBe(T0);
    expect(runBaseTime(T0, Number.NaN, platformCadence(1))).toBe(T0);
  });
});

describe("aligning the next check", () => {
  it("keeps a 1-minute monitor on the minute", () => {
    expect(alignNextCheck(T0, 60)).toBe(T0 + MINUTE);
  });

  it("moves a 12-minute monitor to the nearest 12-minute mark", () => {
    expect(alignNextCheck(T0 + 5 * MINUTE, 720)).toBe(T0 + 12 * MINUTE);
    expect(alignNextCheck(T0 + 7 * MINUTE, 720)).toBe(T0 + 24 * MINUTE);
    expect(alignNextCheck(T0 + 12 * MINUTE, 720)).toBe(T0 + 24 * MINUTE);
  });

  it("uses 12-minute marks for an hour and 6-minute marks for half an hour", () => {
    expect(alignNextCheck(T0 + 3 * MINUTE, 3600) % (12 * MINUTE)).toBe(0);
    expect(alignNextCheck(T0 + 2 * MINUTE, 1800)).toBe(T0 + 30 * MINUTE);
    expect(alignNextCheck(T0 + 4 * MINUTE, 1800)).toBe(T0 + 36 * MINUTE);
  });

  it("keeps at least half an interval between checks", () => {
    for (const interval of [60, 120, 300, 720, 1800, 3600]) {
      for (let offset = 0; offset < 12 * MINUTE; offset += 17_000) {
        expect(alignNextCheck(T0 + offset, interval) - (T0 + offset)).toBeGreaterThanOrEqual(interval * 500);
      }
    }
  });
});

describe("upkeep runs", () => {
  it("is every run on the cron", () => {
    expect(isUpkeepRun(T0, T0 - MINUTE, CRON_CADENCE)).toBe(true);
  });

  it("is the first run of each 12-minute slot on the platform", () => {
    const fast = platformCadence(1);
    expect(isUpkeepRun(T0, null, fast)).toBe(true);
    expect(isUpkeepRun(T0 + MINUTE, T0, fast)).toBe(false);
    expect(isUpkeepRun(T0 + 11 * MINUTE, T0, fast)).toBe(false);
    expect(isUpkeepRun(T0 + 12 * MINUTE, T0, fast)).toBe(true);
    expect(upkeepSlot(T0 + 13 * MINUTE)).toBe(T0 + 12 * MINUTE);
  });
});

describe("next due", () => {
  it("is the earliest wake", () => {
    expect(nextDueAt(T0, [T0 + 5 * MINUTE, T0 + MINUTE - 30_000, Number.NaN])).toBe(T0 + 30_000);
  });

  it("may be in the past, for a backlog", () => {
    expect(nextDueAt(T0, [T0 - 5_000])).toBe(T0 - 5_000);
  });

  it("is never more than 12 minutes after the run started", () => {
    expect(nextDueAt(T0, [])).toBe(T0 + 12 * MINUTE);
    expect(nextDueAt(T0, [T0 + 60 * MINUTE])).toBe(T0 + 12 * MINUTE);
  });
});
