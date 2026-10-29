import { describe, expect, it } from "vitest";
import { browserInitiated, exchangeAllowed, s256 } from "./app-signin";

describe("browserInitiated (who may start an app sign-in)", () => {
  it("lets the browser's own navigations through: an app's Custom Tab, a typed address", () => {
    expect(browserInitiated("none")).toBe(true);
    // A browser without Fetch Metadata.
    expect(browserInitiated(undefined)).toBe(true);
  });

  it("refuses anything a web page started", () => {
    expect(browserInitiated("cross-site")).toBe(false);
    expect(browserInitiated("same-site")).toBe(false);
    expect(browserInitiated("same-origin")).toBe(false);
  });
});

describe("exchangeAllowed (who may post the code)", () => {
  const own = "https://openping.test";

  it("takes the app's web view (no Origin, or null) and the install's own page", () => {
    expect(exchangeAllowed(undefined, "none", own)).toBe(true);
    expect(exchangeAllowed("null", undefined, own)).toBe(true);
    expect(exchangeAllowed(own, "same-origin", own)).toBe(true);
  });

  it("refuses another site's form", () => {
    expect(exchangeAllowed("https://evil.example", "cross-site", own)).toBe(false);
    expect(exchangeAllowed("https://evil.example", undefined, own)).toBe(false);
    expect(exchangeAllowed(undefined, "cross-site", own)).toBe(false);
    expect(exchangeAllowed("https://other.openping.test", "same-site", own)).toBe(false);
  });
});

describe("s256", () => {
  it("is RFC 7636's example", async () => {
    expect(await s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
