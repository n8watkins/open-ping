import { describe, expect, it } from "vitest";
import {
  computeIncidentOverview,
  computeOverallUptime,
  groupRecentChecks,
  normalizeSampleState,
} from "./overview-analytics";

describe("normalizeSampleState", () => {
  it("keeps valid monitor states", () => {
    expect(normalizeSampleState("degraded", 1)).toBe("degraded");
    expect(normalizeSampleState("maintenance", 0)).toBe("maintenance");
  });

  it("falls back to the persisted ok flag for invalid states", () => {
    expect(normalizeSampleState("corrupt", 1)).toBe("up");
    expect(normalizeSampleState(null, 0)).toBe("down");
  });
});

describe("groupRecentChecks", () => {
  it("groups, sorts, validates, and limits bulk sample rows", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      monitor_id: "monitor-a",
      at: 30 - index,
      ok: index === 0 ? 0 : 1,
      state: index === 0 ? "bad-state" : "up",
    }));
    rows.push({ monitor_id: "monitor-b", at: 10, ok: 0, state: "down" });

    const grouped = groupRecentChecks(rows);

    expect(grouped.get("monitor-a")).toHaveLength(28);
    expect(grouped.get("monitor-a")?.[0]?.at).toBe(3);
    expect(grouped.get("monitor-a")?.at(-1)).toEqual({ at: 30, state: "down" });
    expect(grouped.get("monitor-b")).toEqual([{ at: 10, state: "down" }]);
  });
});

describe("computeOverallUptime", () => {
  it("weights uptime by checks instead of averaging monitor percentages", () => {
    expect(
      computeOverallUptime([
        { monitor_id: "busy", checks: 100, ok_checks: 90 },
        { monitor_id: "quiet", checks: 1, ok_checks: 0 },
      ]),
    ).toBeCloseTo((90 / 101) * 100);
  });

  it("treats a window without checks as fully up", () => {
    expect(computeOverallUptime([])).toBe(100);
  });

  it("bounds corrupt counters to a valid percentage", () => {
    expect(
      computeOverallUptime([
        { monitor_id: "bad", checks: 5, ok_checks: 12 },
        { monitor_id: "negative", checks: -2, ok_checks: -1 },
      ]),
    ).toBe(100);
  });
});

describe("computeIncidentOverview", () => {
  const now = 2_000_000;

  it("counts recent incidents and computes mean gaps between starts", () => {
    expect(
      computeIncidentOverview({
        recentIncidentStarts: [1_900_000, 1_600_000, 1_800_000],
        openIncidents: 0,
        latestResolvedAt: 1_950_000,
        earliestMonitorCreatedAt: 1_000_000,
        now,
      }),
    ).toEqual({
      incidents24h: 3,
      mtbfSeconds24h: 150,
      withoutIncidentSeconds: 50,
    });
  });

  it("reports zero incident-free time while any incident is open", () => {
    expect(
      computeIncidentOverview({
        recentIncidentStarts: [1_900_000],
        openIncidents: 1,
        latestResolvedAt: 1_950_000,
        earliestMonitorCreatedAt: 1_000_000,
        now,
      }),
    ).toEqual({
      incidents24h: 1,
      mtbfSeconds24h: null,
      withoutIncidentSeconds: 0,
    });
  });

  it("uses monitor creation when there has never been an incident", () => {
    expect(
      computeIncidentOverview({
        recentIncidentStarts: [],
        openIncidents: 0,
        latestResolvedAt: null,
        earliestMonitorCreatedAt: 1_000_000,
        now,
      }),
    ).toEqual({
      incidents24h: 0,
      mtbfSeconds24h: null,
      withoutIncidentSeconds: 1000,
    });
  });

  it("returns null incident-free time when there are no monitors", () => {
    expect(
      computeIncidentOverview({
        recentIncidentStarts: [],
        openIncidents: 0,
        latestResolvedAt: null,
        earliestMonitorCreatedAt: null,
        now,
      }).withoutIncidentSeconds,
    ).toBeNull();
  });
});
