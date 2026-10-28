import { describe, expect, it } from "vitest";
import { TIME_RANGES } from "../../../shared/time-range";
import { rangeLabel } from "./RangeControl";

describe("rangeLabel", () => {
  it("starts with the visible text, then says what it means", () => {
    expect(rangeLabel("24h")).toBe("24h, last 24 hours");
    expect(rangeLabel("90d")).toBe("90d, last 90 days");
  });

  it("names every range by its button text", () => {
    for (const r of TIME_RANGES) expect(rangeLabel(r).startsWith(`${r},`)).toBe(true);
  });
});
