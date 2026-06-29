import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "./timing";

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("s3cret-token", "s3cret-token")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("returns false for differing strings of equal length", () => {
    expect(timingSafeEqual("aaaaaa", "aaaaab")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
    expect(timingSafeEqual("secret", "")).toBe(false);
  });

  it("handles non-ASCII characters", () => {
    expect(timingSafeEqual("café", "café")).toBe(true);
    expect(timingSafeEqual("café", "cafe")).toBe(false);
  });
});
