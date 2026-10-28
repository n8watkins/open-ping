import { describe, expect, it } from "vitest";
import { PULL_MAX, PULL_SLOP, PULL_THRESHOLD, decidePull, pullDistance, shouldRefresh } from "./pull-to-refresh";

describe("pullDistance", () => {
  it("doesn't move for an upward or no drag", () => {
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(-40)).toBe(0);
  });

  it("resists: the indicator moves less than the finger, and never past the cap", () => {
    expect(pullDistance(50)).toBeLessThan(50);
    expect(pullDistance(50)).toBeGreaterThan(0);
    expect(pullDistance(10_000)).toBeLessThanOrEqual(PULL_MAX);
  });

  it("grows with the finger", () => {
    expect(pullDistance(120)).toBeGreaterThan(pullDistance(60));
  });

  it("needs a deliberate pull, about 130 px, to reach the threshold", () => {
    expect(shouldRefresh(pullDistance(100))).toBe(false);
    expect(shouldRefresh(pullDistance(140))).toBe(true);
  });
});

describe("decidePull", () => {
  it("waits until the finger has moved past the slop", () => {
    expect(decidePull(2, PULL_SLOP - 1)).toBe("undecided");
  });

  it("is a pull for a mostly downward drag", () => {
    expect(decidePull(3, 20)).toBe("pull");
  });

  it("leaves an upward drag to the page's own scroll", () => {
    expect(decidePull(0, -20)).toBe("ignore");
  });

  it("leaves a sideways swipe to charts and wide tables", () => {
    expect(decidePull(30, 12)).toBe("ignore");
  });
});

describe("shouldRefresh", () => {
  it("refreshes from the threshold on", () => {
    expect(shouldRefresh(PULL_THRESHOLD - 0.1)).toBe(false);
    expect(shouldRefresh(PULL_THRESHOLD)).toBe(true);
  });
});
