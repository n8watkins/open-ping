import { describe, expect, it } from "vitest";
import { alertsTarget, settingsTarget, shellTransitionKey } from "./section-routes";

describe("settingsTarget", () => {
  it("opens General by default", () => {
    expect(settingsTarget("", "")).toBe("/settings/general");
    expect(settingsTarget("", "#")).toBe("/settings/general");
    expect(settingsTarget("", "#no-such-section")).toBe("/settings/general");
  });

  it("sends each old #anchor to the sub-page that now holds it", () => {
    expect(settingsTarget("", "#general")).toBe("/settings/general");
    expect(settingsTarget("", "#sign-in")).toBe("/settings/security");
    expect(settingsTarget("", "#encryption")).toBe("/settings/security");
    expect(settingsTarget("", "#reports")).toBe("/settings/reports");
    expect(settingsTarget("", "#waitlist")).toBe("/settings/reports");
    expect(settingsTarget("", "#landing-counts")).toBe("/settings/reports");
    for (const anchor of ["retention", "usage", "diagnostics", "about"]) {
      expect(settingsTarget("", `#${anchor}`)).toBe("/settings/system");
    }
  });

  it("keeps the query string, which /recover uses to explain what happened", () => {
    expect(settingsTarget("?recovered=1", "#sign-in")).toBe("/settings/security?recovered=1");
  });
});

describe("alertsTarget", () => {
  it("moves /integrations to /alerts with its search and hash", () => {
    expect(alertsTarget("", "")).toBe("/alerts");
    expect(alertsTarget("?x=1", "#push")).toBe("/alerts?x=1#push");
  });
});

describe("shellTransitionKey", () => {
  it("treats a page with sub-pages as one page", () => {
    expect(shellTransitionKey("/settings/general")).toBe("/settings");
    expect(shellTransitionKey("/settings/system")).toBe("/settings");
    expect(shellTransitionKey("/developers/mcp")).toBe("/developers");
  });

  it("gives every other address its own entrance", () => {
    expect(shellTransitionKey("/")).toBe("/");
    expect(shellTransitionKey("/monitors")).toBe("/monitors");
    expect(shellTransitionKey("/monitors/mon_1")).toBe("/monitors/mon_1");
  });
});
