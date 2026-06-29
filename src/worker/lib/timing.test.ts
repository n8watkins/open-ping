import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "./timing";

describe("timingSafeEqual", () => {
  it("returns true for identical strings", async () => {
    expect(await timingSafeEqual("s3cret-token", "s3cret-token")).toBe(true);
    expect(await timingSafeEqual("", "")).toBe(true);
  });

  it("returns false for differing strings of equal length", async () => {
    expect(await timingSafeEqual("aaaaaa", "aaaaab")).toBe(false);
  });

  it("returns false for strings of different length", async () => {
    expect(await timingSafeEqual("abc", "abcd")).toBe(false);
    expect(await timingSafeEqual("abcd", "abc")).toBe(false);
    expect(await timingSafeEqual("secret", "")).toBe(false);
  });

  it("handles non-ASCII characters", async () => {
    expect(await timingSafeEqual("café", "café")).toBe(true);
    expect(await timingSafeEqual("café", "cafe")).toBe(false);
  });
});
