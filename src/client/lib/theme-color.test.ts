import { describe, expect, it } from "vitest";
import { DARK_THEME_COLOR, themeColorFor } from "./theme-color";

describe("themeColorFor", () => {
  it("is the dark shell for the app and dark status pages", () => {
    expect(themeColorFor(null, null)).toBe(DARK_THEME_COLOR);
    expect(themeColorFor("dark", "#0b1220")).toBe(DARK_THEME_COLOR);
  });

  it("follows a light status page's canvas", () => {
    expect(themeColorFor("light", "#f6f8fb")).toBe("#f6f8fb");
  });

  it("stays dark when the light canvas can't be read", () => {
    expect(themeColorFor("light", null)).toBe(DARK_THEME_COLOR);
  });
});
