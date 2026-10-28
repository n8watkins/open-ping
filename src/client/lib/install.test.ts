import { describe, expect, it } from "vitest";
import { devicePlatform, installState, isIosDevice, type InstallSignals } from "./install";

const base: InstallSignals = { standalone: false, hasPrompt: false, installedBefore: false, ios: false };

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipadOs:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

describe("installState", () => {
  it("is installed when running as the app, whatever else is true", () => {
    expect(installState({ ...base, standalone: true })).toBe("installed");
    expect(installState({ standalone: true, hasPrompt: true, installedBefore: false, ios: true })).toBe("installed");
  });

  it("offers the button when the browser handed over its prompt", () => {
    expect(installState({ ...base, hasPrompt: true })).toBe("prompt");
  });

  it("prefers a fresh prompt over an old installed note (the app was uninstalled)", () => {
    expect(installState({ ...base, hasPrompt: true, installedBefore: true })).toBe("prompt");
  });

  it("stays hidden in a tab once this browser installed the app", () => {
    expect(installState({ ...base, installedBefore: true })).toBe("installed");
    expect(installState({ ...base, installedBefore: true, ios: true })).toBe("installed");
  });

  it("shows the Share steps on iPhone, which has no prompt", () => {
    expect(installState({ ...base, ios: true })).toBe("ios");
  });

  it("offers nothing without a prompt elsewhere", () => {
    expect(installState(base)).toBe("unsupported");
  });
});

describe("isIosDevice", () => {
  it("knows an iPhone", () => {
    expect(isIosDevice(UA.iphone, "iPhone", 5)).toBe(true);
  });

  it("knows iPadOS posing as a Mac by its touch screen", () => {
    expect(isIosDevice(UA.ipadOs, "MacIntel", 5)).toBe(true);
    expect(isIosDevice(UA.ipadOs, "MacIntel", 0)).toBe(false);
  });

  it("is false for Android and Windows", () => {
    expect(isIosDevice(UA.android, "Linux armv8l", 5)).toBe(false);
    expect(isIosDevice(UA.windows, "Win32", 0)).toBe(false);
  });
});

describe("devicePlatform", () => {
  it("sorts devices into the three sets of steps", () => {
    expect(devicePlatform(UA.iphone, "iPhone", 5)).toBe("ios");
    expect(devicePlatform(UA.ipadOs, "MacIntel", 5)).toBe("ios");
    expect(devicePlatform(UA.android, "Linux armv8l", 5)).toBe("android");
    expect(devicePlatform(UA.windows, "Win32", 0)).toBe("desktop");
  });
});
