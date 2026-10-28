import { describe, expect, it } from "vitest";
import { buildListStats, median, type HourlyStatsRow } from "./list-stats";

function hour(monitor_id: string, ok: number, checks: number, sumLatency: number): HourlyStatsRow {
  return {
    monitor_id,
    checks,
    ok_checks: ok,
    monitored_seconds: checks * 720,
    down_seconds: (checks - ok) * 720,
    sum_latency_ms: sumLatency,
  };
}

describe("median", () => {
  it("takes the middle value, or the mean of the middle two", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe("buildListStats", () => {
  it("computes 7-day uptime, the typical response and the latest incident per monitor", () => {
    const stats = buildListStats(
      ["a", "b", "c"],
      [
        hour("a", 5, 5, 5 * 200), // 200 ms
        hour("a", 5, 5, 5 * 220), // 220 ms
        hour("a", 4, 5, 4 * 9000), // one slow hour: the median ignores it
        hour("b", 5, 5, 0), // a heartbeat: no latency
      ],
      [
        { monitor_id: "a", last_started_at: 1234, open_count: 1 },
        { monitor_id: "b", last_started_at: 99, open_count: 0 },
      ],
    );
    expect(stats.a).toEqual({
      uptime7d: (14 / 15) * 100,
      checks7d: 15,
      typicalResponseMs: 220,
      lastIncidentAt: 1234,
      incidentOpen: true,
    });
    expect(stats.b).toMatchObject({ uptime7d: 100, typicalResponseMs: null, lastIncidentAt: 99, incidentOpen: false });
    // No rows at all: no data, never an incident.
    expect(stats.c).toEqual({
      uptime7d: 100,
      checks7d: 0,
      typicalResponseMs: null,
      lastIncidentAt: null,
      incidentOpen: false,
    });
  });
});
