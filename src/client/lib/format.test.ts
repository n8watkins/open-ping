import { describe, it, expect } from "vitest";
import {
  formatRelativeTime,
  formatDuration,
  formatMs,
  formatPct,
  formatSince,
  formatShortDateTime,
} from "./format";

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

  it("renders a plain dash for nullish input", () => {
    expect(formatMs(null)).toBe("-");
    expect(formatMs(undefined)).toBe("-");
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

describe("formatSince", () => {
  const opts = { locale: "en-US", timeZone: "America/Los_Angeles" };
  // Friday 2026-10-23 16:48 in Los Angeles.
  const friday = Date.UTC(2026, 9, 23, 23, 48);
  const HOUR_MS = 3600 * 1000;

  it("shows only the time for earlier today", () => {
    expect(formatSince(friday, friday + 2 * HOUR_MS, opts)).toBe("4:48 PM");
  });

  it("shows the weekday and time within the last week", () => {
    // Sunday morning, two days later.
    expect(formatSince(friday, friday + 40 * HOUR_MS, opts)).toBe("Fri 4:48 PM");
  });

  it("uses the timezone's calendar day, not UTC's", () => {
    // 23:48 UTC is already Saturday in UTC, but still Friday in Los Angeles;
    // one hour later is still the same Los Angeles day.
    expect(formatSince(friday, friday + HOUR_MS, opts)).toBe("4:48 PM");
  });

  it("shows the month and day for older instants", () => {
    expect(formatSince(friday, friday + 10 * 24 * HOUR_MS, opts)).toBe("Oct 23");
  });

  it("adds the year when it differs", () => {
    expect(formatSince(friday, Date.UTC(2027, 1, 1), opts)).toBe("Oct 23, 2026");
  });
});

describe("formatShortDateTime", () => {
  const opts = { locale: "en-US", timeZone: "UTC" };
  it("omits the year within the current one and shows it otherwise", () => {
    const now = Date.UTC(2026, 9, 28, 18);
    expect(formatShortDateTime(Date.UTC(2026, 9, 28, 15, 4), now, opts)).toBe("Oct 28, 3:04 PM");
    expect(formatShortDateTime(Date.UTC(2025, 11, 31, 9, 0), now, opts)).toBe("Dec 31, 2025, 9:00 AM");
  });
});
