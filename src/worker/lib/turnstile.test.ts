import { afterEach, describe, expect, it, vi } from "vitest";
import { turnstileRequired, turnstileSiteKey, verifyTurnstile } from "./turnstile";

const both = { TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" };

afterEach(() => vi.restoreAllMocks());

describe("turnstileRequired and turnstileSiteKey", () => {
  it("is required unless the install explicitly opts out with TURNSTILE=off", () => {
    expect(turnstileRequired({})).toBe(true);
    expect(turnstileRequired({ TURNSTILE_SITE_KEY: " ", TURNSTILE_SECRET_KEY: "" })).toBe(true);
    expect(turnstileRequired(both)).toBe(true);
    expect(turnstileRequired({ TURNSTILE: "on" })).toBe(true);
    expect(turnstileRequired({ TURNSTILE: " OFF " })).toBe(false);
  });

  it("offers the site key to the form only when both are set", () => {
    expect(turnstileSiteKey(both)).toBe("site");
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: "site" })).toBeNull();
    expect(turnstileSiteKey({ TURNSTILE_SECRET_KEY: "secret" })).toBeNull();
    expect(turnstileSiteKey({})).toBeNull();
    expect(turnstileSiteKey({ ...both, TURNSTILE: "off" })).toBeNull();
  });
});

describe("verifyTurnstile", () => {
  it("passes without calling Cloudflare only under the explicit TURNSTILE=off opt-out", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await verifyTurnstile({ TURNSTILE: "off" }, undefined, undefined)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses when the keys are missing, with no opt-out (production default)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await verifyTurnstile({}, "t", "1.1.1.1")).toBe(false);
    expect(await verifyTurnstile({ TURNSTILE_SITE_KEY: "site" }, "t", "1.1.1.1")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes with Cloudflare's always-pass test keys", async () => {
    const test = { TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: true, hostname: "example.com" })));
    expect(await verifyTurnstile(test, "XXXX.DUMMY.TOKEN.XXXX", "1.1.1.1")).toBe(true);
  });

  it("checks the Siteverify hostname against TURNSTILE_HOSTNAMES when it is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ success: true, hostname: "evil.example" })));
    expect(await verifyTurnstile({ ...both, TURNSTILE_HOSTNAMES: "openping.n8builds.dev, Other.dev" }, "t", "1.1.1.1")).toBe(false);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ success: true })));
    expect(await verifyTurnstile({ ...both, TURNSTILE_HOSTNAMES: "openping.n8builds.dev" }, "t", "1.1.1.1")).toBe(false);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ success: true, hostname: "OpenPing.n8builds.dev" })));
    expect(await verifyTurnstile({ ...both, TURNSTILE_HOSTNAMES: "openping.n8builds.dev" }, "t", "1.1.1.1")).toBe(true);
  });

  it("fails closed: no token, a long token, half the keys, a bad status or a network error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 500 }));
    expect(await verifyTurnstile(both, undefined, "1.1.1.1")).toBe(false);
    expect(await verifyTurnstile(both, "x".repeat(2049), "1.1.1.1")).toBe(false);
    expect(await verifyTurnstile({ TURNSTILE_SECRET_KEY: "secret" }, "t", "1.1.1.1")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await verifyTurnstile(both, "t", "1.1.1.1")).toBe(false);
    fetchSpy.mockRejectedValue(new Error("offline"));
    expect(await verifyTurnstile(both, "t", "1.1.1.1")).toBe(false);
  });

  it("passes only on success: true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ success: "true" })));
    expect(await verifyTurnstile(both, "t", "1.1.1.1")).toBe(false);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ success: false })));
    expect(await verifyTurnstile(both, "t", "1.1.1.1")).toBe(false);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ success: true })));
    expect(await verifyTurnstile(both, "t", "unknown")).toBe(true);
    const [url, init] = fetchSpy.mock.calls.at(-1)!;
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = init!.body as FormData;
    expect(body.get("secret")).toBe("secret");
    expect(body.get("remoteip")).toBeNull();
    expect(body.get("idempotency_key")).toBeTruthy();
  });
});
