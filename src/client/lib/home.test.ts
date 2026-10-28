import { describe, expect, it } from "vitest";
import { isLandingInstall, rootView } from "./home";
import type { AuthStatus } from "./bootstrap";

const base: AuthStatus = {
  setupComplete: true,
  encryptionConfigured: true,
  githubEnabled: true,
  githubAdminConfigured: true,
  emailAdminConfigured: false,
};

describe("rootView", () => {
  it("waits for the bootstrap before picking a page", () => {
    expect(rootView({ loading: true, me: null, status: null })).toBe("loading");
    expect(rootView({ loading: true, me: { authenticated: true }, status: { ...base, homePage: "landing" } })).toBe("loading");
  });

  it("gives a signed-in admin the dashboard on every install", () => {
    for (const homePage of ["landing", "status", undefined] as const) {
      expect(rootView({ loading: false, me: { authenticated: true }, status: { ...base, homePage } })).toBe("dashboard");
    }
  });

  it("shows guests the marketing page only on a landing install", () => {
    const guest = { authenticated: false };
    expect(rootView({ loading: false, me: guest, status: { ...base, homePage: "landing" } })).toBe("landing");
    expect(rootView({ loading: false, me: guest, status: { ...base, homePage: "status" } })).toBe("status");
  });

  it("falls back to the install's status page when the server didn't say", () => {
    // An older Worker without the field, or a failed bootstrap fetch.
    expect(rootView({ loading: false, me: { authenticated: false }, status: base })).toBe("status");
    expect(rootView({ loading: false, me: null, status: null })).toBe("status");
  });
});

describe("isLandingInstall", () => {
  it("is true only for an explicit landing home", () => {
    expect(isLandingInstall({ ...base, homePage: "landing" })).toBe(true);
    expect(isLandingInstall({ ...base, homePage: "status" })).toBe(false);
    expect(isLandingInstall(null)).toBe(false);
  });
});
