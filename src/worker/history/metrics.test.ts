import { describe, it, expect } from "vitest";
import {
  computeUptimeFromRows,
  computeIncidentMetricsFromRows,
} from "./metrics";

describe("computeUptimeFromRows", () => {
  it("returns 100% with zero counters for an empty set (no checks ⇒ up)", () => {
    expect(computeUptimeFromRows([])).toEqual({
      uptimePct: 100,
      checks: 0,
      okChecks: 0,
      monitoredSeconds: 0,
      downSeconds: 0,
    });
  });

  it("sums counters and derives uptime % across mixed rows", () => {
    const res = computeUptimeFromRows([
      { checks: 60, ok_checks: 60, monitored_seconds: 3600, down_seconds: 0 },
      { checks: 60, ok_checks: 30, monitored_seconds: 3600, down_seconds: 1800 },
      { checks: 80, ok_checks: 70, monitored_seconds: 4800, down_seconds: 600 },
    ]);
    expect(res.checks).toBe(200);
    expect(res.okChecks).toBe(160);
    expect(res.monitoredSeconds).toBe(12000);
    expect(res.downSeconds).toBe(2400);
    expect(res.uptimePct).toBeCloseTo(80, 10);
  });

  it("reports 100% when all checks are ok", () => {
    const res = computeUptimeFromRows([
      { checks: 10, ok_checks: 10, monitored_seconds: 600, down_seconds: 0 },
    ]);
    expect(res.uptimePct).toBe(100);
  });
});

describe("computeIncidentMetricsFromRows", () => {
  const NOW = 1_000_000_000_000;

  it("returns empty metrics when there are no incidents", () => {
    expect(computeIncidentMetricsFromRows([], NOW)).toEqual({
      totalIncidents: 0,
      totalDowntimeSeconds: 0,
      mtbfSeconds: null,
      mttrSeconds: null,
      longestSeconds: null,
      mostRecentAt: null,
    });
  });

  it("handles a single resolved incident (MTBF null, MTTR set)", () => {
    const res = computeIncidentMetricsFromRows(
      [{ startedAt: 1000, resolvedAt: 1000 + 300_000, durationSeconds: 300 }],
      NOW,
    );
    expect(res.totalIncidents).toBe(1);
    expect(res.totalDowntimeSeconds).toBe(300);
    expect(res.mtbfSeconds).toBeNull(); // needs ≥ 2 incidents
    expect(res.mttrSeconds).toBe(300);
    expect(res.longestSeconds).toBe(300);
    expect(res.mostRecentAt).toBe(1000);
  });

  it("computes MTBF/MTTR/longest/most-recent across many incidents", () => {
    // Starts at t=0, 100s, 400s (gaps: 100s, 300s ⇒ mean 200s).
    // Durations: 60s, 120s, 30s.
    const res = computeIncidentMetricsFromRows(
      [
        { startedAt: 0, resolvedAt: 60_000, durationSeconds: 60 },
        { startedAt: 100_000, resolvedAt: 220_000, durationSeconds: 120 },
        { startedAt: 400_000, resolvedAt: 430_000, durationSeconds: 30 },
      ],
      NOW,
    );
    expect(res.totalIncidents).toBe(3);
    expect(res.totalDowntimeSeconds).toBe(210);
    expect(res.mtbfSeconds).toBe(200); // (100_000 + 300_000) / 2 / 1000
    expect(res.mttrSeconds).toBe(70); // (60 + 120 + 30) / 3
    expect(res.longestSeconds).toBe(120);
    expect(res.mostRecentAt).toBe(400_000);
  });

  it("sorts by start time when computing MTBF (input order independent)", () => {
    const res = computeIncidentMetricsFromRows(
      [
        { startedAt: 400_000, resolvedAt: 430_000, durationSeconds: 30 },
        { startedAt: 0, resolvedAt: 60_000, durationSeconds: 60 },
        { startedAt: 100_000, resolvedAt: 220_000, durationSeconds: 120 },
      ],
      NOW,
    );
    expect(res.mtbfSeconds).toBe(200);
    expect(res.mostRecentAt).toBe(400_000);
  });

  it("uses `now` for an open incident's downtime and longest", () => {
    const openStart = NOW - 500_000; // 500s ago
    const res = computeIncidentMetricsFromRows(
      [
        { startedAt: NOW - 1_000_000, resolvedAt: NOW - 940_000, durationSeconds: 60 },
        { startedAt: openStart, resolvedAt: null, durationSeconds: null },
      ],
      NOW,
    );
    expect(res.totalIncidents).toBe(2);
    // resolved 60s + open 500s
    expect(res.totalDowntimeSeconds).toBe(560);
    expect(res.longestSeconds).toBe(500); // open incident is longest
    expect(res.mttrSeconds).toBe(60); // only the resolved one counts
    expect(res.mostRecentAt).toBe(openStart);
  });

  it("derives duration from resolvedAt when durationSeconds is missing", () => {
    const res = computeIncidentMetricsFromRows(
      [{ startedAt: 1000, resolvedAt: 1000 + 90_000, durationSeconds: null }],
      NOW,
    );
    expect(res.totalDowntimeSeconds).toBe(90);
    expect(res.mttrSeconds).toBe(90);
    expect(res.longestSeconds).toBe(90);
  });
});
