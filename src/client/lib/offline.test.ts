import { describe, expect, it } from "vitest";
import { API_CACHE_MESSAGE } from "./sw-contract";
import {
  formatSavedAt,
  isApiCacheMessage,
  nextSavedAt,
  offlineBanner,
  offlineSummary,
  type ApiCacheMessage,
} from "./offline";

// Local times, so the clock reads the same in any time zone the tests run in.
const now = new Date(2026, 9, 28, 14, 5).getTime();
const tenFortyTwo = new Date(2026, 9, 28, 10, 42).getTime();
const yesterday = new Date(2026, 9, 27, 9, 7).getTime();

describe("offlineBanner", () => {
  it("names the time of the saved data", () => {
    expect(offlineBanner({ online: false, savedAt: tenFortyTwo, now })).toBe("Offline, showing data from 10:42");
  });

  it("shows saved data even when the browser thinks it is online (a dead network)", () => {
    expect(offlineBanner({ online: true, savedAt: tenFortyTwo, now })).toBe("Offline, showing data from 10:42");
  });

  it("falls back to a plain offline note when nothing saved is on screen", () => {
    expect(offlineBanner({ online: false, savedAt: null, now })).toBe("You're offline, so data may be stale.");
  });

  it("shows nothing when online with live data", () => {
    expect(offlineBanner({ online: true, savedAt: null, now })).toBeNull();
  });

  it("adds the day when the data is from another day", () => {
    expect(offlineBanner({ online: false, savedAt: yesterday, now, locale: "en-US" })).toBe(
      "Offline, showing data from Oct 27, 09:07",
    );
  });
});

describe("formatSavedAt", () => {
  it("uses a 24-hour clock with leading zeros", () => {
    expect(formatSavedAt(new Date(2026, 9, 28, 0, 3).getTime(), now)).toBe("00:03");
    expect(formatSavedAt(new Date(2026, 9, 28, 23, 59).getTime(), now)).toBe("23:59");
  });
});

describe("nextSavedAt", () => {
  const cached = (savedAt?: number): ApiCacheMessage => ({ type: API_CACHE_MESSAGE, source: "cached", savedAt });
  const fresh: ApiCacheMessage = { type: API_CACHE_MESSAGE, source: "fresh" };

  it("starts showing saved data at its saved time", () => {
    expect(nextSavedAt(null, cached(tenFortyTwo))).toBe(tenFortyTwo);
  });

  it("keeps the oldest time when several saved answers are on screen", () => {
    expect(nextSavedAt(tenFortyTwo, cached(yesterday))).toBe(yesterday);
    expect(nextSavedAt(yesterday, cached(tenFortyTwo))).toBe(yesterday);
  });

  it("clears once the network answers again", () => {
    expect(nextSavedAt(tenFortyTwo, fresh)).toBeNull();
  });

  it("ignores a saved answer without a time", () => {
    expect(nextSavedAt(null, cached())).toBeNull();
    expect(nextSavedAt(tenFortyTwo, cached())).toBe(tenFortyTwo);
  });
});

describe("isApiCacheMessage", () => {
  it("accepts the service worker's messages", () => {
    expect(isApiCacheMessage({ type: API_CACHE_MESSAGE, source: "cached", savedAt: 1 })).toBe(true);
    expect(isApiCacheMessage({ type: API_CACHE_MESSAGE, source: "fresh" })).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isApiCacheMessage(null)).toBe(false);
    expect(isApiCacheMessage("openping:api-cache")).toBe(false);
    expect(isApiCacheMessage({ type: "other", source: "fresh" })).toBe(false);
    expect(isApiCacheMessage({ type: API_CACHE_MESSAGE, source: "maybe" })).toBe(false);
    expect(isApiCacheMessage({ type: API_CACHE_MESSAGE, source: "cached", savedAt: "10:42" })).toBe(false);
    expect(isApiCacheMessage({ type: API_CACHE_MESSAGE, source: "cached", savedAt: Number.NaN })).toBe(false);
  });
});

describe("offlineSummary", () => {
  it("says when the status on screen is from", () => {
    expect(offlineSummary(tenFortyTwo, now)).toBe("Offline, status from 10:42");
  });

  it("says it may be out of date when nothing saved is on screen", () => {
    expect(offlineSummary(null, now)).toBe("Offline, status may be out of date");
  });
});
