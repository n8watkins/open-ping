import { describe, it, expect } from "vitest";
import { bucketStart, aggregateSummaries, type SummaryTotals } from "./rollups";

// A fixed, non-boundary instant: 2026-03-15T14:37:22.123Z.
const AT = Date.UTC(2026, 2, 15, 14, 37, 22, 123);
const HOUR = Date.UTC(2026, 2, 15, 14); // 2026-03-15T14:00:00Z
const DAY = Date.UTC(2026, 2, 15); //      2026-03-15T00:00:00Z
const MONTH = Date.UTC(2026, 2, 1); //     2026-03-01T00:00:00Z

describe("bucketStart", () => {
  it("floors to the top of the UTC hour", () => {
    expect(bucketStart("hour", AT)).toBe(HOUR);
  });

  it("floors to UTC midnight for day", () => {
    expect(bucketStart("day", AT)).toBe(DAY);
  });

  it("floors to the first of the month at 00:00 UTC", () => {
    expect(bucketStart("month", AT)).toBe(MONTH);
  });

  it("is idempotent on exact boundaries", () => {
    expect(bucketStart("hour", HOUR)).toBe(HOUR);
    expect(bucketStart("day", DAY)).toBe(DAY);
    expect(bucketStart("month", MONTH)).toBe(MONTH);
  });

  it("handles the start-of-year month wrap", () => {
    const jan2 = Date.UTC(2027, 0, 2, 9, 0, 0);
    expect(bucketStart("month", jan2)).toBe(Date.UTC(2027, 0, 1));
    expect(bucketStart("day", jan2)).toBe(Date.UTC(2027, 0, 2));
  });
});

function row(over: Partial<SummaryTotals> = {}): SummaryTotals {
  return {
    checks: 0,
    ok_checks: 0,
    fail_checks: 0,
    retry_recoveries: 0,
    sum_latency_ms: 0,
    min_latency_ms: null,
    max_latency_ms: null,
    monitored_seconds: 0,
    down_seconds: 0,
    ...over,
  };
}

describe("aggregateSummaries", () => {
  it("returns zeroed totals with null min/max for an empty array", () => {
    expect(aggregateSummaries([])).toEqual({
      checks: 0,
      ok_checks: 0,
      fail_checks: 0,
      retry_recoveries: 0,
      sum_latency_ms: 0,
      min_latency_ms: null,
      max_latency_ms: null,
      monitored_seconds: 0,
      down_seconds: 0,
    });
  });

  it("sums all additive columns", () => {
    const out = aggregateSummaries([
      row({
        checks: 5,
        ok_checks: 4,
        fail_checks: 1,
        retry_recoveries: 1,
        sum_latency_ms: 500,
        monitored_seconds: 3600,
        down_seconds: 60,
      }),
      row({
        checks: 3,
        ok_checks: 3,
        fail_checks: 0,
        retry_recoveries: 0,
        sum_latency_ms: 300,
        monitored_seconds: 3600,
        down_seconds: 0,
      }),
    ]);
    expect(out.checks).toBe(8);
    expect(out.ok_checks).toBe(7);
    expect(out.fail_checks).toBe(1);
    expect(out.retry_recoveries).toBe(1);
    expect(out.sum_latency_ms).toBe(800);
    expect(out.monitored_seconds).toBe(7200);
    expect(out.down_seconds).toBe(60);
  });

  it("computes null-aware min/max, ignoring NULL latency rows", () => {
    const out = aggregateSummaries([
      row({ min_latency_ms: null, max_latency_ms: null }), // contributes nothing
      row({ min_latency_ms: 120, max_latency_ms: 400 }),
      row({ min_latency_ms: 80, max_latency_ms: 350 }),
      row({ min_latency_ms: 200, max_latency_ms: 900 }),
    ]);
    expect(out.min_latency_ms).toBe(80);
    expect(out.max_latency_ms).toBe(900);
  });

  it("keeps min/max null when every row is null", () => {
    const out = aggregateSummaries([row(), row(), row()]);
    expect(out.min_latency_ms).toBeNull();
    expect(out.max_latency_ms).toBeNull();
  });

  it("handles a single non-null latency row", () => {
    const out = aggregateSummaries([row({ min_latency_ms: 42, max_latency_ms: 42 })]);
    expect(out.min_latency_ms).toBe(42);
    expect(out.max_latency_ms).toBe(42);
  });
});
