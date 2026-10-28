import { describe, expect, it } from "vitest";
import { pacer } from "./pace";

describe("pacer", () => {
  it("lets the first call through and spaces the rest by the spacing, in call order", async () => {
    let t = 1_000;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const pace = pacer(2_000, sleep, () => t);
    await Promise.all([pace(), pace(), pace()]);
    expect(waits).toEqual([2_000, 4_000]);

    // Long after the last one: no wait.
    t += 10_000;
    waits.length = 0;
    await pace();
    expect(waits).toEqual([]);
  });
});
