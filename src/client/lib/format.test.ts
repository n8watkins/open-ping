import { describe, it, expect } from "vitest";
import { formatRelativeTime, formatDuration, formatMs, formatPct } from "./format";

// Fixed reference instant (epoch ms) so relative-time math is deterministic.
const NOW = 1_700_000_000_000;

describe("formatRelativeTime", () => {
  it("returns 'just now' for very recent timestamps", () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe("just now");
  });

  it("formats minutes in the past", () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
  });

  it("formats hours in the past", () => {
    expect(formatRelativeTime(NOW - 3 * 60 * 60_000, NOW)).toBe("3h ago");
  });

  it("formats days in the past", () => {
    expect(formatRelativeTime(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe("2d ago");
  });

  it("formats future timestamps", () => {
    expect(formatRelativeTime(NOW + 5 * 60_000, NOW)).toBe("in 5m");
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  it("formats whole minutes", () => {
    expect(formatDuration(12 * 60)).toBe("12m");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3h 5m");
  });

  it("formats days and hours", () => {
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe("2d 4h");
  });
});

describe("formatMs", () => {
  it("formats sub-second values in milliseconds", () => {
    expect(formatMs(182)).toBe("182 ms");
  });

  it("formats values at/above a second in seconds", () => {
    expect(formatMs(1200)).toBe("1.20 s");
  });

  it("renders an em dash for nullish input", () => {
    expect(formatMs(null)).toBe("—");
    expect(formatMs(undefined)).toBe("—");
  });
});

describe("formatPct", () => {
  it("uses two decimals by default", () => {
    expect(formatPct(99.95)).toBe("99.95%");
  });

  it("respects an explicit digits argument", () => {
    expect(formatPct(100, 0)).toBe("100%");
  });
});
