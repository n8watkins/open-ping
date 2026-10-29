import { describe, expect, it } from "vitest";
import { safeNextPath } from "./native-app";
import { androidPhone, isAppUserAgent } from "../../shared/native-app";

describe("isAppUserAgent", () => {
  const chrome =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

  it("finds the app's token at the end of the web view's user agent", () => {
    expect(isAppUserAgent(`${chrome} OpenPingApp/1.0.0 (Android)`)).toBe(true);
  });

  it("is false for a browser, and for look-alikes", () => {
    expect(isAppUserAgent(chrome)).toBe(false);
    expect(isAppUserAgent(`${chrome} NotOpenPingApp/1.0`)).toBe(false);
    expect(isAppUserAgent(`${chrome} OpenPingApp`)).toBe(false);
    expect(isAppUserAgent(null)).toBe(false);
    expect(isAppUserAgent(undefined)).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps a path on this site", () => {
    expect(safeNextPath("/auth/app/finish")).toBe("/auth/app/finish");
    expect(safeNextPath("/")).toBe("/");
  });

  it("never leaves the site", () => {
    expect(safeNextPath("//evil.example/")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("https://evil.example/")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(42)).toBe("/");
  });
});

describe("androidPhone", () => {
  it("finds the model, or the Android version when the model is hidden", () => {
    expect(androidPhone("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36")).toBe("Pixel 8");
    expect(androidPhone("Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36")).toBe("Android 15");
    expect(androidPhone("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBeNull();
    expect(androidPhone(undefined)).toBeNull();
  });
});
