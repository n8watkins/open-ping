import { describe, it, expect } from "vitest";
import { decideIntervalAction, mergeLatency } from "./intervals";

describe("decideIntervalAction", () => {
  it("opens when there is no current interval", () => {
    expect(decideIntervalAction(null, "up")).toBe("open");
  });

  it("extends when the incoming state matches the open interval", () => {
    expect(decideIntervalAction({ state: "up" }, "up")).toBe("extend");
    expect(decideIntervalAction({ state: "down" }, "down")).toBe("extend");
  });

  it("splits when the incoming state differs from the open interval", () => {
    expect(decideIntervalAction({ state: "up" }, "down")).toBe("split");
    expect(decideIntervalAction({ state: "maintenance" }, "up")).toBe("split");
    expect(decideIntervalAction({ state: "up" }, "scheduled_off")).toBe("split");
  });
});

describe("mergeLatency", () => {
  const zero = {
    checks: 0,
    okChecks: 0,
    sumLatencyMs: 0,
    minLatencyMs: null,
    maxLatencyMs: null,
  };

  it("seeds min/max/sum from the first measured sample", () => {
    expect(mergeLatency(zero, { latencyMs: 120, ok: true })).toEqual({
      checks: 1,
      okChecks: 1,
      sumLatencyMs: 120,
      minLatencyMs: 120,
      maxLatencyMs: 120,
    });
  });

  it("accumulates sum and tracks running min/max across samples", () => {
    let agg = mergeLatency(zero, { latencyMs: 100, ok: true });
    agg = mergeLatency(agg, { latencyMs: 50, ok: true }); // new min
    agg = mergeLatency(agg, { latencyMs: 300, ok: false }); // new max, failure
    expect(agg).toEqual({
      checks: 3,
      okChecks: 2,
      sumLatencyMs: 450,
      minLatencyMs: 50,
      maxLatencyMs: 300,
    });
  });

  it("advances only check counters when no latency is supplied", () => {
    const agg = mergeLatency(
      { checks: 2, okChecks: 2, sumLatencyMs: 240, minLatencyMs: 100, maxLatencyMs: 140 },
      { ok: false },
    );
    expect(agg).toEqual({
      checks: 3,
      okChecks: 2,
      sumLatencyMs: 240,
      minLatencyMs: 100,
      maxLatencyMs: 140,
    });
  });

  it("ignores non-finite latency values", () => {
    expect(mergeLatency(zero, { latencyMs: NaN, ok: true })).toEqual({
      checks: 1,
      okChecks: 1,
      sumLatencyMs: 0,
      minLatencyMs: null,
      maxLatencyMs: null,
    });
    expect(mergeLatency(zero, { latencyMs: Infinity, ok: true })).toEqual({
      checks: 1,
      okChecks: 1,
      sumLatencyMs: 0,
      minLatencyMs: null,
      maxLatencyMs: null,
    });
  });

  it("counts a sample without ok as a non-ok check", () => {
    const agg = mergeLatency(zero, { latencyMs: 10 });
    expect(agg.checks).toBe(1);
    expect(agg.okChecks).toBe(0);
  });

  it("treats zero latency as a real measurement (not skipped)", () => {
    expect(mergeLatency(zero, { latencyMs: 0, ok: true })).toEqual({
      checks: 1,
      okChecks: 1,
      sumLatencyMs: 0,
      minLatencyMs: 0,
      maxLatencyMs: 0,
    });
  });
});
