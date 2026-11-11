import { afterEach, describe, expect, it, vi } from "vitest";
import { turnstileRequired, turnstileSiteKey, verifyTurnstile } from "./turnstile";

const both = { TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" };

afterEach(() => vi.restoreAllMocks());

describe("turnstileRequired and turnstileSiteKey", () => {
  it("is off only when both keys are unset (or blank)", () => {
    expect(turnstileRequired({})).toBe(false);
    expect(turnstileRequired({ TURNSTILE_SITE_KEY: " ", TURNSTILE_SECRET_KEY: "" })).toBe(false);
    expect(turnstileRequired(both)).toBe(true);
    expect(turnstileRequired({ TURNSTILE_SITE_KEY: "site" })).toBe(true);
    expect(turnstileRequired({ TURNSTILE_SECRET_KEY: "secret" })).toBe(true);
  });

  it("offers the site key to the form only when both are set", () => {
    expect(turnstileSiteKey(both)).toBe("site");
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: "site" })).toBeNull();
    expect(turnstileSiteKey({ TURNSTILE_SECRET_KEY: "secret" })).toBeNull();
    expect(turnstileSiteKey({})).toBeNull();
  });
});

describe("verifyTurnstile", () => {
  it("passes without calling Cloudflare while it is off", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await verifyTurnstile({}, undefined, undefined)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
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
