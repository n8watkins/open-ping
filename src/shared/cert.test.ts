import { describe, expect, it } from "vitest";
import { CERT_DEFAULT_WARN_DAYS, parseCertTarget, parseWarnDays } from "./cert";

describe("parseCertTarget", () => {
  it("takes the host, and any port, from what people paste", () => {
    expect(parseCertTarget("example.com")).toEqual({ host: "example.com" });
    expect(parseCertTarget("  Example.COM. ")).toEqual({ host: "example.com" });
    expect(parseCertTarget("https://www.example.com/pricing?x=1")).toEqual({ host: "www.example.com" });
    expect(parseCertTarget("https://example.com:8443/")).toEqual({ host: "example.com", port: 8443 });
    expect(parseCertTarget("example.com:8443")).toEqual({ host: "example.com", port: 8443 });
    expect(parseCertTarget("")).toEqual({ host: "" });
  });
});

describe("parseWarnDays", () => {
  it("reads a typed list, largest first, without repeats", () => {
    expect(parseWarnDays("7, 30,14")).toEqual([30, 14, 7]);
    expect(parseWarnDays("30 30 7")).toEqual([30, 7]);
    expect(parseWarnDays(CERT_DEFAULT_WARN_DAYS.join(", "))).toEqual([30, 14, 7]);
    expect(parseWarnDays("")).toEqual([]);
  });
  it("keeps something that isn't a number visible, for the validation to name", () => {
    const days = parseWarnDays("30, soon");
    expect(days[0]).toBe(30);
    expect(Number.isNaN(days[1])).toBe(true);
  });
});
