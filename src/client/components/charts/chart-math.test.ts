import { describe, expect, it } from "vitest";
import {
  mergeBuckets,
  niceCeil,
  niceTicks,
  offHourBands,
  outlierThreshold,
  worstState,
  type StripBucket,
} from "./chart-math";

const b = (t: number, state: StripBucket["state"], checks = 0, okChecks = 0, avgMs: number | null = null): StripBucket => ({
  t,
  state,
  checks,
  okChecks,
  uptime: checks ? (okChecks / checks) * 100 : null,
  avgMs,
});

describe("outlierThreshold", () => {
  it("flags a cold start and nothing else", () => {
    const values = [230, 250, 240, 260, 255, 245, 43_000];
    const t = outlierThreshold(values);
    expect(values.filter((v) => v > t)).toEqual([43_000]);
  });

  it("does not judge tiny samples", () => {
    expect(outlierThreshold([100, 90_000])).toBe(Infinity);
  });
});

describe("niceCeil and niceTicks", () => {
  it("rounds an axis maximum up to 1, 2, 2.5 or 5 times a power of ten", () => {
    expect(niceCeil(380)).toBe(500);
    expect(niceCeil(1100)).toBe(2000);
    expect(niceCeil(2100)).toBe(2500);
    expect(niceCeil(0)).toBe(1);
  });

  it("only produces round tick labels", () => {
    expect(niceTicks(1000)).toEqual([0, 250, 500, 750, 1000]);
    expect(niceTicks(5000)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(niceTicks(2500)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
  });
});

describe("mergeBuckets", () => {
  it("keeps the worst state and weights the average by OK checks", () => {
    const merged = mergeBuckets(
      [b(0, "up", 4, 4, 100), b(1, "scheduled_off"), b(2, "down", 2, 0), b(3, "up", 2, 2, 400)],
      2,
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ t: 0, state: "up", checks: 4, avgMs: 100, span: 2 });
    expect(merged[1]).toMatchObject({ t: 2, state: "down", checks: 4, okChecks: 2, uptime: 50, avgMs: 400 });
  });

  it("aligns groups to the end so the current bucket closes the last group", () => {
    const merged = mergeBuckets([b(0, "up"), b(1, "up"), b(2, "up"), b(3, "up"), b(4, "down")], 2);
    expect(merged.map((m) => [m.t, m.span])).toEqual([
      [0, 1],
      [1, 2],
      [3, 2],
    ]);
    expect(merged.at(-1)!.state).toBe("down");
  });

  it("is a no-op at k = 1", () => {
    expect(mergeBuckets([b(0, "up")], 1)).toEqual([{ ...b(0, "up"), span: 1 }]);
  });
});

describe("worstState and offHourBands", () => {
  it("ranks an outage over everything and off-hours below real checks", () => {
    expect(worstState(["up", "scheduled_off"])).toBe("up");
    expect(worstState(["scheduled_off", "nodata"])).toBe("scheduled_off");
    expect(worstState(["up", "suspended", "down"])).toBe("down");
  });

  it("joins neighbouring off-hours buckets into one band", () => {
    expect(
      offHourBands([b(0, "scheduled_off"), b(10, "scheduled_off"), b(20, "up"), b(30, "scheduled_off")], 10),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 40 },
    ]);
  });
});
