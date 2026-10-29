import { describe, expect, it } from "vitest";
import { hostOf, hostedOrigin, normalizeAddress } from "./addresses";

describe("normalizeAddress", () => {
  it("adds https and keeps only the origin", () => {
    expect(normalizeAddress("openping.example.com")).toEqual({ ok: true, origin: "https://openping.example.com" });
    expect(normalizeAddress(" OpenPing.Example.com/ ")).toEqual({ ok: true, origin: "https://openping.example.com" });
    expect(normalizeAddress("https://openping.example.com/login?x=1#y")).toEqual({
      ok: true,
      origin: "https://openping.example.com",
    });
    expect(normalizeAddress("status.example.com:8443")).toEqual({ ok: true, origin: "https://status.example.com:8443" });
  });

  it("refuses plain http and other schemes", () => {
    expect(normalizeAddress("http://openping.example.com")).toEqual({ ok: false, reason: "not_https" });
    expect(normalizeAddress("ftp://openping.example.com")).toEqual({ ok: false, reason: "not_https" });
  });

  it("refuses what can't be an address", () => {
    expect(normalizeAddress("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeAddress("localhost")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeAddress("user:pw@openping.example.com")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeAddress("open ping.example.com")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeAddress("example..com")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("hostedOrigin", () => {
  it("builds the customer's address from its name", () => {
    expect(hostedOrigin("acme", "openping.app")).toEqual({ ok: true, origin: "https://acme.openping.app" });
    expect(hostedOrigin(" Acme.openping.app ", "openping.app")).toEqual({ ok: true, origin: "https://acme.openping.app" });
  });

  it("takes only a platform slug", () => {
    expect(hostedOrigin("", "openping.app")).toEqual({ ok: false, reason: "empty" });
    expect(hostedOrigin("a", "openping.app")).toEqual({ ok: false, reason: "invalid" });
    expect(hostedOrigin("1acme", "openping.app")).toEqual({ ok: false, reason: "invalid" });
    expect(hostedOrigin("acme.evil.com", "openping.app")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("hostOf", () => {
  it("shows the host", () => {
    expect(hostOf("https://openping.example.com")).toBe("openping.example.com");
  });
});
