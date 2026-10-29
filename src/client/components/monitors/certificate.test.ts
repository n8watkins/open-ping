import { describe, expect, it } from "vitest";
import { certLookupFailure, daysLeftLabel } from "./certificate";

describe("daysLeftLabel", () => {
  it("says how long is left, or how long ago it expired", () => {
    expect(daysLeftLabel(42, false)).toBe("42 days left");
    expect(daysLeftLabel(1, false)).toBe("1 day left");
    expect(daysLeftLabel(0, false)).toBe("Expires today");
    expect(daysLeftLabel(-1, true)).toBe("Expired");
    expect(daysLeftLabel(-2, true)).toBe("Expired 1 day ago");
    expect(daysLeftLabel(-4, true)).toBe("Expired 3 days ago");
  });
});

describe("certLookupFailure", () => {
  it("names each failed read in words", () => {
    expect(certLookupFailure("cert_timeout")).toBe("timed out");
    expect(certLookupFailure("cert_connect_failed")).toBe("couldn't connect");
    expect(certLookupFailure("something_new")).toBe("read error");
  });
});
