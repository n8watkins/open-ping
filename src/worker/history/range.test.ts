import { describe, expect, it } from "vitest";
import {
  aggregateBuckets,
  buildBuckets,
  classifyBucket,
  distributeIntervals,
  downtimeBreakdown,
  latencyStats,
  percentile,
  totalsFromBuckets,
  type StateSeconds,
} from "./range";
import { HOUR_MS, DAY_MS, parseTimeRange, rangeBounds } from "../../shared/time-range";

const zero: StateSeconds = { up: 0, down: 0, suspended: 0, degraded: 0, off: 0, maintenance: 0, paused: 0, cantCheck: 0 };

describe("rangeBounds", () => {
  it("aligns hour ranges to UTC hours and ends with the current hour", () => {
    const now = Date.UTC(2026, 9, 28, 16, 37, 12);
    const b = rangeBounds("24h", now);
    expect(b.starts).toHaveLength(24);
    expect(b.starts.at(-1)).toBe(Date.UTC(2026, 9, 28, 16));
    expect(b.from).toBe(Date.UTC(2026, 9, 27, 17));
    expect(b.to).toBe(Date.UTC(2026, 9, 28, 17));
    expect(rangeBounds("7d", now).starts).toHaveLength(168);
  });

  it("aligns day ranges to UTC midnight", () => {
    const now = Date.UTC(2026, 9, 28, 16, 37);
    const b = rangeBounds("30d", now);
    expect(b.starts).toHaveLength(30);
    expect(b.starts.at(-1)).toBe(Date.UTC(2026, 9, 28));
    expect(b.bucketMs).toBe(DAY_MS);
    expect(rangeBounds("90d", now).starts[0]).toBe(Date.UTC(2026, 9, 28) - 89 * DAY_MS);
  });

  it("falls back to 7d for a missing or unknown range", () => {
    expect(parseTimeRange(undefined)).toBe("7d");
    expect(parseTimeRange("1y")).toBe("7d");
    expect(parseTimeRange("30d")).toBe("30d");
  });
});

describe("percentile and latencyStats", () => {
  it("interpolates between ranks", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48);
  });

  it("keeps one cold start from moving the median", () => {
    const s = latencyStats([200, 210, 220, 230, 240, 250, 260, 270, 280, 43_000], "checks");
    expect(s.median).toBe(245);
    expect(s.avg).toBe(4516);
    expect(s.max).toBe(43_000);
    expect(s.count).toBe(10);
    expect(s.basis).toBe("checks");
  });

  it("reports nulls when there is nothing to measure", () => {
    expect(latencyStats([], "hourly")).toEqual({
      avg: null,
      median: null,
      p95: null,
      min: null,
      max: null,
      basis: "hourly",
      count: 0,
    });
  });
});

describe("distributeIntervals", () => {
  const from = Date.UTC(2026, 9, 28, 0);
  it("splits an interval across the buckets it overlaps and clips to now", () => {
    const now = from + 3 * HOUR_MS;
    const out = distributeIntervals(
      [
        { state: "scheduled_off", startedAt: from - HOUR_MS, endedAt: from + 90 * 60_000 },
        { state: "up", startedAt: from + 90 * 60_000, endedAt: null },
      ],
      from,
      HOUR_MS,
      4,
      now,
    );
    expect(out[0]!.off).toBe(3600);
    expect(out[1]!.off).toBe(1800);
    expect(out[1]!.up).toBe(1800);
    expect(out[2]!.up).toBe(3600);
    // The open interval stops at now, so the future bucket stays empty.
    expect(out[3]!.up).toBe(0);
  });

  it("ignores states it does not track", () => {
    const out = distributeIntervals(
      [{ state: "warming_up", startedAt: from, endedAt: from + HOUR_MS }],
      from,
      HOUR_MS,
      1,
      from + HOUR_MS,
    );
    expect(out[0]).toEqual(zero);
  });
});

describe("classifyBucket", () => {
  it("shows a certificate that can't be read as Can't check, not No data, and below anything real", () => {
    expect(classifyBucket(0, 0, { ...zero, cantCheck: 3600 })).toBe("cant_check");
    expect(classifyBucket(1, 1, { ...zero, cantCheck: 1800, up: 1800 })).toBe("up");
    expect(classifyBucket(1, 0, { ...zero, cantCheck: 1800, down: 1800 })).toBe("down");
  });

  it("never shows off-hours as downtime", () => {
    expect(classifyBucket(0, 0, { ...zero, off: 3600 })).toBe("scheduled_off");
  });

  it("prefers real checks over off-hours in a partly scheduled bucket", () => {
    expect(classifyBucket(3, 3, { ...zero, off: 1800, up: 1800 })).toBe("up");
  });

  it("ranks outages first and names the bigger of down and suspended", () => {
    expect(classifyBucket(5, 0, { ...zero, suspended: 3000, down: 600 })).toBe("suspended");
    expect(classifyBucket(5, 2, { ...zero, down: 1200 })).toBe("down");
  });

  it("marks failed but unconfirmed checks as degraded", () => {
    expect(classifyBucket(5, 4, { ...zero, up: 3600 })).toBe("degraded");
  });

  it("tells maintenance, paused and a gap apart", () => {
    expect(classifyBucket(0, 0, { ...zero, maintenance: 60 })).toBe("maintenance");
    expect(classifyBucket(0, 0, { ...zero, paused: 60 })).toBe("paused");
    expect(classifyBucket(0, 0, zero)).toBe("nodata");
  });
});

describe("buildBuckets, aggregateBuckets and totals", () => {
  const starts = [0, HOUR_MS];
  const a = buildBuckets(
    starts,
    [
      {
        monitor_id: "a",
        bucket_start: 0,
        checks: 4,
        ok_checks: 4,
        sum_latency_ms: 1000,
        min_latency_ms: 200,
        max_latency_ms: 300,
      },
    ],
    [zero, { ...zero, off: 3600 }],
  );
  const b = buildBuckets(
    starts,
    [
      {
        monitor_id: "b",
        bucket_start: 0,
        checks: 4,
        ok_checks: 2,
        sum_latency_ms: 1000,
        min_latency_ms: 400,
        max_latency_ms: 600,
      },
    ],
    [{ ...zero, down: 1800 }, { ...zero, off: 3600 }],
  );

  it("derives uptime and the OK-check average per bucket", () => {
    expect(a[0]).toMatchObject({ state: "up", uptime: 100, avgMs: 250, checks: 4 });
    expect(a[1]).toMatchObject({ state: "scheduled_off", uptime: null, avgMs: null, offSeconds: 3600 });
    expect(b[0]).toMatchObject({ state: "down", uptime: 50, avgMs: 500, downSeconds: 1800 });
  });

  it("reports no latency for checks that carried none (heartbeats)", () => {
    const [hb] = buildBuckets(
      [0],
      [
        {
          monitor_id: "h",
          bucket_start: 0,
          checks: 2,
          ok_checks: 2,
          sum_latency_ms: 0,
          min_latency_ms: null,
          max_latency_ms: null,
        },
      ],
      [zero],
    );
    expect(hb!.avgMs).toBeNull();
  });

  it("takes the most serious monitor state and counts monitors per state", () => {
    const agg = aggregateBuckets(starts, [a, b]);
    expect(agg[0]).toMatchObject({
      state: "down",
      monitors: { up: 1, down: 1 },
      checks: 8,
      okChecks: 6,
      uptime: 75,
      // Weighted by OK checks: (250 * 4 + 500 * 2) / 6.
      avgMs: 333,
      minMs: 200,
      maxMs: 600,
    });
    expect(agg[1]).toMatchObject({ state: "scheduled_off", monitors: { scheduled_off: 2 } });
  });

  it("sums a range, keeping off-hours out of downtime", () => {
    const t = totalsFromBuckets(b, 0, latencyStats([], "hourly"));
    expect(t).toMatchObject({
      uptimePct: 50,
      checks: 4,
      downtimeSeconds: 1800,
      suspendedSeconds: 0,
      offSeconds: 3600,
    });
    expect(totalsFromBuckets([], 0, latencyStats([], "hourly")).uptimePct).toBeNull();
  });
});

describe("downtimeBreakdown", () => {
  it("separates suspended time from outages within the window", () => {
    const now = 10 * HOUR_MS;
    const out = downtimeBreakdown(
      [
        { state: "suspended", startedAt: 0, endedAt: 2 * HOUR_MS },
        { state: "suspended", startedAt: 5 * HOUR_MS, endedAt: 6 * HOUR_MS },
        { state: "down", startedAt: 8 * HOUR_MS, endedAt: null },
        { state: "up", startedAt: 6 * HOUR_MS, endedAt: 8 * HOUR_MS },
      ],
      HOUR_MS,
      now,
    );
    expect(out).toEqual({
      downtimeSeconds: 3600 + 3600 + 7200,
      suspendedSeconds: 7200,
      suspensions: 2,
    });
  });
});
