import { describe, expect, it } from "vitest";

import { appOrigin, classifyHost, tenantOrigin } from "./hosts";

const DOMAIN = "openping.example";

describe("classifyHost", () => {
  it("routes app.<domain> to the platform", () => {
    expect(classifyHost("app.openping.example", DOMAIN)).toEqual({ kind: "app" });
    expect(classifyHost("APP.OpenPing.Example.", DOMAIN)).toEqual({ kind: "app" });
  });

  it("treats the apex and www as the apex", () => {
    expect(classifyHost("openping.example", DOMAIN)).toEqual({ kind: "apex" });
    expect(classifyHost("www.openping.example", DOMAIN)).toEqual({ kind: "apex" });
  });

  it("routes one label before the domain to a tenant", () => {
    expect(classifyHost("acme.openping.example", DOMAIN)).toEqual({ kind: "tenant", slug: "acme" });
    expect(classifyHost("Acme.openping.example", DOMAIN)).toEqual({ kind: "tenant", slug: "acme" });
  });

  it("refuses deeper names, look-alike domains and other hosts", () => {
    for (const host of [
      "a.b.openping.example",
      "acme.app.openping.example",
      "evilopenping.example",
      "acme.openping.example.evil.test",
      "openping.example.evil.test",
      "localhost",
      ".openping.example",
    ]) {
      expect(classifyHost(host, DOMAIN), host).toEqual({ kind: "unknown" });
    }
  });

  it("matches nothing when the domain is not set", () => {
    expect(classifyHost("app.openping.example", "")).toEqual({ kind: "unknown" });
  });

  it("builds origins from the domain", () => {
    expect(appOrigin("OpenPing.Example")).toBe("https://app.openping.example");
    expect(tenantOrigin("acme", DOMAIN)).toBe("https://acme.openping.example");
  });
});
