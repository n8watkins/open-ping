import { describe, it, expect } from "vitest";
import { isFlapping } from "./incidents";

const HOUR = 60 * 60 * 1000;
const NOW = 1_000_000_000_000; // fixed reference "now"

describe("isFlapping (pure)", () => {
  it("is false below the threshold", () => {
    const starts = [NOW - 10 * 60 * 1000, NOW - 20 * 60 * 1000]; // 2 in window
    expect(isFlapping(starts, NOW)).toBe(false);
  });

  it("is true at the threshold", () => {
    const starts = [
      NOW - 5 * 60 * 1000,
      NOW - 15 * 60 * 1000,
      NOW - 25 * 60 * 1000,
    ]; // exactly 3 in window
    expect(isFlapping(starts, NOW)).toBe(true);
  });

  it("is true above the threshold", () => {
    const starts = [NOW, NOW - 1000, NOW - 2000, NOW - 3000]; // 4 in window
    expect(isFlapping(starts, NOW)).toBe(true);
  });

  it("ignores starts outside the window (older than windowMs)", () => {
    const starts = [
      NOW - 2 * HOUR, // outside
      NOW - 90 * 60 * 1000, // outside (1.5h ago)
      NOW - 10 * 60 * 1000, // inside
    ];
    expect(isFlapping(starts, NOW)).toBe(false);
  });

  it("treats the lower window edge as exclusive and upper as inclusive", () => {
    // Exactly windowMs ago is excluded; exactly `now` is included.
    const atLowerEdge = [NOW - HOUR, NOW - HOUR, NOW - HOUR]; // all excluded
    expect(isFlapping(atLowerEdge, NOW)).toBe(false);

    const justInside = [NOW - HOUR + 1, NOW - HOUR + 1, NOW]; // all included
    expect(isFlapping(justInside, NOW)).toBe(true);
  });

  it("excludes future timestamps beyond now", () => {
    const starts = [NOW + 1, NOW + 2, NOW + 3]; // all after now
    expect(isFlapping(starts, NOW)).toBe(false);
  });

  it("honours custom windowMs and threshold", () => {
    const starts = [NOW - 1000, NOW - 2000]; // 2 within a 10s window
    expect(isFlapping(starts, NOW, 10_000, 2)).toBe(true);
    expect(isFlapping(starts, NOW, 10_000, 3)).toBe(false);
  });

  it("is false for an empty list", () => {
    expect(isFlapping([], NOW)).toBe(false);
  });
});
