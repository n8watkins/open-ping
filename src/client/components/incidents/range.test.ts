import { describe, expect, it } from "vitest";
import { matchPreset, presetRange, rangeLabel } from "./range";

// Local-time "now": Oct 28 2026, midday.
const NOW = new Date(2026, 9, 28, 12, 0).getTime();

describe("incident date ranges", () => {
  it("computes preset bounds in local time", () => {
    expect(presetRange("all", NOW)).toEqual({ from: "", to: "" });
    expect(presetRange("month", NOW)).toEqual({ from: "2026-10-01", to: "" });
    expect(presetRange("30d", NOW)).toEqual({ from: "2026-09-29", to: "" });
    expect(presetRange("90d", NOW)).toEqual({ from: "2026-07-31", to: "" });
  });

  it("recognises a preset and labels custom ranges", () => {
    expect(matchPreset("2026-10-01", "", NOW)).toBe("month");
    expect(matchPreset("2026-10-02", "", NOW)).toBeNull();
    expect(rangeLabel("", "", NOW)).toBe("All time");
    expect(rangeLabel("2026-10-01", "", NOW)).toBe("This month");
    expect(rangeLabel("2026-07-01", "2026-07-31", NOW, "en-US")).toBe("Jul 1, 2026 to Jul 31, 2026");
    expect(rangeLabel("2026-07-02", "", NOW, "en-US")).toBe("Since Jul 2, 2026");
    expect(rangeLabel("", "2026-07-31", NOW, "en-US")).toBe("Until Jul 31, 2026");
  });
});
