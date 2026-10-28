import { describe, expect, it } from "vitest";
import {
  currentMonth,
  isMonth,
  monthBounds,
  overlapWeight,
  previousMonth,
  reduceReportGroups,
  reportFigures,
  reportFromResults,
  reportToCsv,
  tierRanges,
  type ReportGroupRow,
} from "./monthly";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RETENTION = { sampleHours: 24, hourlyDays: 35, dailyDays: 400 };

function group(monitor: string, lo: number, hi: number, over: Partial<ReportGroupRow> = {}): ReportGroupRow {
  return {
    monitor_id: monitor,
    lo,
    hi,
    checks: 0,
    ok_checks: 0,
    fail_checks: 0,
    sum_latency_ms: 0,
    monitored_seconds: 0,
    down_seconds: 0,
    ...over,
  };
}

describe("months", () => {
  it("accepts YYYY-MM from 2000 on", () => {
    expect(isMonth("2026-10")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-1")).toBe(false);
    expect(isMonth("1999-12")).toBe(false);
  });

  it("bounds a month in the install's timezone across daylight saving changes", () => {
    // Los Angeles springs forward on 8 March 2026: the month is an hour short.
    const march = monthBounds("2026-03", "America/Los_Angeles");
    expect(new Date(march.start).toISOString()).toBe("2026-03-01T08:00:00.000Z");
    expect(new Date(march.end).toISOString()).toBe("2026-04-01T07:00:00.000Z");
    expect((march.end - march.start) / HOUR).toBe(31 * 24 - 1);
    // ...and falls back on 1 November: November is an hour long, October is not.
    const oct = monthBounds("2026-10", "America/Los_Angeles");
    expect((oct.end - oct.start) / HOUR).toBe(31 * 24);
    const nov = monthBounds("2026-11", "America/Los_Angeles");
    expect(new Date(nov.start).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect((nov.end - nov.start) / HOUR).toBe(30 * 24 + 1);
    // Half-hour offsets and UTC.
    expect(new Date(monthBounds("2026-10", "Asia/Kolkata").start).toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(monthBounds("2026-02", "UTC")).toMatchObject({ start: Date.UTC(2026, 1, 1), end: Date.UTC(2026, 2, 1) });
  });

  it("falls back to UTC for an unknown timezone", () => {
    expect(monthBounds("2026-02", "Nowhere/Special").timezone).toBe("UTC");
  });

  it("finds the previous month by the install's calendar, not UTC's", () => {
    // 06:30 UTC on 1 Nov is still 31 Oct in Los Angeles.
    const lateOct = Date.UTC(2026, 10, 1, 6, 30);
    expect(previousMonth(lateOct, "America/Los_Angeles")).toBe("2026-09");
    expect(currentMonth(lateOct, "America/Los_Angeles")).toBe("2026-10");
    expect(previousMonth(lateOct, "UTC")).toBe("2026-10");
    // January rolls back a year.
    expect(previousMonth(Date.UTC(2027, 0, 15), "UTC")).toBe("2026-12");
  });
});

describe("tierRanges", () => {
  it("reads hours after the hourly horizon, days before it, and months only past the daily one", () => {
    const { start, end } = monthBounds("2026-10", "America/Los_Angeles");
    const now = Date.UTC(2026, 10, 20, 12);
    const r = tierRanges(start, end, now, RETENTION);
    // now - 35 days = 16 Oct 12:00 UTC, so hours are complete from 17 Oct.
    expect(r.hour).toEqual({ from: Date.UTC(2026, 9, 17), to: end });
    expect(r.day).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 17) });
    expect(r.month.from).toBeGreaterThanOrEqual(r.month.to);
  });

  it("uses only hourly rows for a recent month", () => {
    const { start, end } = monthBounds("2026-10", "America/Los_Angeles");
    const r = tierRanges(start, end, Date.UTC(2026, 10, 1, 17), RETENTION);
    expect(r.hour).toEqual({ from: Date.UTC(2026, 9, 1, 7), to: end });
    expect(r.day.from).toBeGreaterThanOrEqual(r.day.to);
  });

  it("falls back to monthly rows for a month older than the daily horizon", () => {
    const { start, end } = monthBounds("2024-03", "UTC");
    const r = tierRanges(start, end, Date.UTC(2026, 10, 1), RETENTION);
    expect(r.month).toEqual({ from: Date.UTC(2024, 2, 1), to: end });
    expect(r.day.from).toBeGreaterThanOrEqual(r.day.to);
    expect(r.hour.from).toBeGreaterThanOrEqual(r.hour.to);
  });
});

describe("report maths", () => {
  const { start, end } = monthBounds("2026-10", "America/Los_Angeles");

  it("weights a bucket that straddles the month's edge by its overlap", () => {
    expect(overlapWeight(start, end, start, end)).toBe(1);
    // The UTC day of 1 Oct starts 7 hours before the Los Angeles month.
    expect(overlapWeight(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2), start, end)).toBeCloseTo(17 / 24);
    expect(overlapWeight(end, end + DAY, start, end)).toBe(0);
  });

  it("sums contained groups whole and prorates edge buckets", () => {
    const rows = [
      // Everything wholly inside the month, from hourly and daily rows.
      group("mon_a", start + HOUR, end - HOUR, { checks: 100, ok_checks: 98, fail_checks: 2, sum_latency_ms: 9800, monitored_seconds: 72_000, down_seconds: 1440 }),
      // The UTC day the month starts in, 17 of its 24 hours inside.
      group("mon_a", Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2), { checks: 24, ok_checks: 24, sum_latency_ms: 2400, monitored_seconds: 17_280 }),
    ];
    const totals = reduceReportGroups(rows, start, end).get("mon_a")!;
    expect(totals.checks).toBeCloseTo(100 + 17);
    expect(totals.okChecks).toBeCloseTo(98 + 17);
    expect(totals.downSeconds).toBe(1440);
  });

  it("counts off-hours as neither uptime nor downtime", () => {
    // A business-hours monitor: only its checked hours have rollups. 100
    // checks, 5 down, each covering a 12-minute interval; the nights and
    // weekends have no rows at all.
    const totals = reduceReportGroups(
      [group("biz", start, end, { checks: 100, ok_checks: 95, fail_checks: 5, sum_latency_ms: 95 * 200, monitored_seconds: 100 * 720, down_seconds: 5 * 720 })],
      start,
      end,
    ).get("biz")!;
    const f = reportFigures(totals, 1);
    expect(f).toEqual({
      uptimePct: 95,
      checks: 100,
      failedChecks: 5,
      downtimeMinutes: 60,
      monitoredMinutes: 1200,
      incidents: 1,
      avgResponseMs: 200,
    });
  });

  it("reports no uptime figure for a monitor that was never checked", () => {
    const f = reportFigures(
      { checks: 0, okChecks: 0, failChecks: 0, sumLatencyMs: 0, monitoredSeconds: 0, downSeconds: 0 },
      0,
    );
    expect(f.uptimePct).toBeNull();
    expect(f.avgResponseMs).toBeNull();
    expect(f.downtimeMinutes).toBe(0);
  });

  it("builds per-monitor rows, totals and a CSV from query results", () => {
    const bounds = monthBounds("2026-10", "America/Los_Angeles");
    const results = [
      { results: [{ id: "mon_a", name: "=API, \"main\"", type: "http" }, { id: "mon_b", name: "New", type: "dns" }] },
      { results: [group("mon_a", start, end, { checks: 1000, ok_checks: 990, fail_checks: 10, sum_latency_ms: 990 * 150, monitored_seconds: 720_000, down_seconds: 7200 })] },
      { results: [{ monitor_id: "mon_a", n: 3 }] },
    ] as unknown as D1Result[];
    const report = reportFromResults(bounds, Date.UTC(2026, 10, 2), results);
    expect(report.partial).toBe(false);
    expect(report.monitors[0]).toMatchObject({ id: "mon_a", uptimePct: 99, downtimeMinutes: 120, incidents: 3, avgResponseMs: 150 });
    expect(report.monitors[1]).toMatchObject({ id: "mon_b", uptimePct: null, checks: 0, incidents: 0 });
    expect(report.totals).toMatchObject({ uptimePct: 99, incidents: 3, checks: 1000 });

    const csv = reportToCsv(report);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "month,timezone,monitor_id,monitor,type,uptime_pct,checks,failed_checks,downtime_minutes,monitored_minutes,incidents,avg_response_ms",
    );
    // Formula-looking names are neutralized and quoted.
    expect(lines[1]).toBe(`2026-10,America/Los_Angeles,mon_a,"'=API, ""main""",http,99,1000,10,120,12000,3,150`);
    expect(lines[2]).toBe("2026-10,America/Los_Angeles,mon_b,New,dns,,0,0,0,0,0,");
    expect(lines[3]).toMatch(/^2026-10,America\/Los_Angeles,,All monitors,,99,1000,/);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("marks the running month as partial", () => {
    const bounds = monthBounds("2026-10", "UTC");
    const report = reportFromResults(bounds, Date.UTC(2026, 9, 15), [] as unknown as D1Result[]);
    expect(report.partial).toBe(true);
    expect(report.monitors).toEqual([]);
  });
});
