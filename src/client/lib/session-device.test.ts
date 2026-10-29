import { describe, expect, it } from "vitest";
import { sessionDevice } from "./session-device";

const APP = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36 OpenPingApp/1.0.0 (Android)";

describe("sessionDevice", () => {
  it("names the OpenPing app and its phone", () => {
    expect(sessionDevice(APP, "app")).toBe("OpenPing app on Pixel 8");
    expect(sessionDevice("Mozilla/5.0 (Linux; Android 14; K) Chrome/131 OpenPingApp/1.0.0 (Android)", null)).toBe(
      "OpenPing app on Android 14",
    );
    expect(sessionDevice(null, "app")).toBe("OpenPing app");
  });

  it("names a browser and its system", () => {
    expect(sessionDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36", null)).toBe("Chrome on Windows");
    expect(sessionDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", null)).toBe("Safari on Mac");
    expect(sessionDevice("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", null)).toBe("Firefox on Linux");
    expect(sessionDevice(null, null)).toBe("Unknown device");
  });
});
