import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../../package.json";
import { BOT_INFO_URL, checkerUserAgent, DEFAULT_CHECKER_USER_AGENT } from "./user-agent";

describe("checkerUserAgent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defaults to OpenPing/<version> with a link to the /bot page", () => {
    expect(DEFAULT_CHECKER_USER_AGENT).toBe(`OpenPing/${pkg.version} (+https://openping.n8builds.dev/bot)`);
    expect(BOT_INFO_URL).toBe("https://openping.n8builds.dev/bot");
    expect(checkerUserAgent()).toBe(DEFAULT_CHECKER_USER_AGENT);
    expect(checkerUserAgent({})).toBe(DEFAULT_CHECKER_USER_AGENT);
    expect(checkerUserAgent({ CHECKER_USER_AGENT: "   " })).toBe(DEFAULT_CHECKER_USER_AGENT);
  });

  it("uses the install's CHECKER_USER_AGENT, trimmed", () => {
    expect(checkerUserAgent({ CHECKER_USER_AGENT: " AcmeUptime/1.0 (+https://status.acme.test/bot) " })).toBe(
      "AcmeUptime/1.0 (+https://status.acme.test/bot)",
    );
  });

  it("falls back to the default for a value that isn't a safe header", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(checkerUserAgent({ CHECKER_USER_AGENT: "Bad\r\nX-Injected: 1" })).toBe(DEFAULT_CHECKER_USER_AGENT);
    expect(checkerUserAgent({ CHECKER_USER_AGENT: "Ünïcode/1" })).toBe(DEFAULT_CHECKER_USER_AGENT);
    expect(checkerUserAgent({ CHECKER_USER_AGENT: "x".repeat(257) })).toBe(DEFAULT_CHECKER_USER_AGENT);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
